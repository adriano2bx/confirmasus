'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { AppShell } from '../../components/navigation';
import { Feedback, Icon, LoadingState, StatusBadge } from '../../components/ui';
import { authFetch } from '../../lib/api';
import { formatDateTime } from '../../lib/date-time';
import { stageLabel, statusLabel, templateLabel } from '../../lib/labels';
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';
export default function DetailPage() {
  const { id } = useParams<{ id: string }>();
  const [item, setItem] = useState<any>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [manualStatus, setManualStatus] = useState<'CONFIRMED' | 'CANCELLED' | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const load = async () => {
    const response = await authFetch(`${API}/convocations/${id}`);
    if (!response.ok) throw new Error();
    setItem(await response.json());
  };
  useEffect(() => {
    load().catch(() => setError('Não foi possível carregar esta convocação.'));
  }, [id]);
  async function submitManualStatus() {
    if (!manualStatus || reason.trim().length < 3) return;
    setSaving(true);
    setError('');
    try {
      const response = await authFetch(`${API}/convocations/${id}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: manualStatus, reason: reason.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? 'Não foi possível alterar a situação.');
      }
      await load();
      setMessage(
        manualStatus === 'CONFIRMED'
          ? 'Convocação marcada como confirmada.'
          : 'Convocação marcada como cancelada.',
      );
      setManualStatus(null);
      setReason('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível alterar a situação.');
    } finally {
      setSaving(false);
    }
  }
  if (!item)
    return (
      <AppShell title="Detalhe da convocação">
        {error ? (
          <Feedback tone="error">{error}</Feedback>
        ) : (
          <section className="panel">
            <LoadingState label="Carregando convocação…" />
          </section>
        )}
      </AppShell>
    );
  const manualClosure = [...item.auditLogs]
    .reverse()
    .find(
      (audit: any) =>
        audit.eventType === 'CONVOCATION_STATUS_CHANGED_MANUALLY' &&
        audit.newData?.status === item.status,
    );
  const events = [
    ...item.messages.flatMap((m: any) =>
      [
        {
          id: `${m.id}-created`,
          title: `${messageLabel(m)} · Enfileirada`,
          date: m.createdAt,
          type: 'message',
        },
        m.submittedAt
          ? {
              id: `${m.id}-submitted`,
              title: `${messageLabel(m)} · Aceita pelo provedor`,
              date: m.submittedAt,
              type: 'message',
            }
          : null,
        m.sentAt
          ? {
              id: `${m.id}-sent`,
              title: `${messageLabel(m)} · Enviada`,
              date: m.sentAt,
              type: 'message',
            }
          : null,
        m.deliveredAt
          ? {
              id: `${m.id}-delivered`,
              title: `${messageLabel(m)} · Entregue`,
              date: m.deliveredAt,
              type: 'message',
            }
          : null,
        m.readAt
          ? {
              id: `${m.id}-read`,
              title: `${messageLabel(m)} · Lida`,
              date: m.readAt,
              type: 'message',
            }
          : null,
        m.failedAt
          ? {
              id: `${m.id}-failed`,
              title: `${messageLabel(m)} · Falha: ${m.failureReason || 'motivo não informado'}`,
              date: m.failedAt,
              type: 'failure',
            }
          : null,
      ].filter(Boolean),
    ),
    ...item.responses.map((r: any) => ({
      id: r.id,
      title: `Resposta: ${responseLabel(r.action)}`,
      date: r.receivedAt,
      type: 'response',
    })),
    ...item.auditLogs.map((a: any) => ({
      id: a.id,
      title: auditLabel(a.eventType),
      detail:
        a.eventType === 'CONVOCATION_STATUS_CHANGED_MANUALLY'
          ? [
              a.reason ? `Motivo: ${a.reason}` : null,
              a.user?.name ? `Responsável: ${a.user.name}` : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : null,
      date: a.createdAt,
      type: 'audit',
    })),
    ...(item.handoff
      ? [
          {
            id: `handoff-${item.handoff.id}`,
            title: `Transbordo para atendimento · ${handoffLabel(item.handoff.status)}`,
            date: item.handoff.updatedAt,
            type: 'handoff',
          },
        ]
      : []),
  ].sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return (
    <AppShell
      title={item.patient.displayName}
      eyebrow="Detalhe da convocação"
      actions={
        <>
          <Link className="button secondary" href="/convocacoes">
            Voltar
          </Link>
          <div className="action-menu-wrap">
            <button
              className="button secondary"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              Ações
            </button>
            {menuOpen ? (
              <div className="action-menu" role="menu">
                <button
                  role="menuitem"
                  disabled={isTerminal(item.status)}
                  onClick={() => {
                    setManualStatus('CONFIRMED');
                    setMenuOpen(false);
                  }}
                >
                  <span className="action-menu-icon success-icon">
                    <Icon name="check" />
                  </span>
                  <span>
                    <strong>Marcar como confirmado</strong>
                    <small>Finaliza o fluxo e bloqueia as próximas convocações</small>
                  </span>
                </button>
                <button
                  role="menuitem"
                  disabled={isTerminal(item.status)}
                  onClick={() => {
                    setManualStatus('CANCELLED');
                    setMenuOpen(false);
                  }}
                >
                  <span className="action-menu-icon danger-icon">
                    <Icon name="alert" />
                  </span>
                  <span>
                    <strong>Marcar como cancelado</strong>
                    <small>Cancela todos os próximos disparos</small>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        </>
      }
    >
      {message ? <Feedback tone="success">{message}</Feedback> : null}
      {error ? <Feedback tone="error">{error}</Feedback> : null}
      <section className="convocation-summary" aria-label="Resumo da convocação">
        <SummaryItem label="Situação" value={<StatusBadge value={item.status} />} />
        <SummaryItem label="Etapa atual" value={stageLabel(item.stage)} />
        <SummaryItem label="Campanha" value={item.campaign.name} />
        <SummaryItem
          label="Próxima ação"
          value={item.nextActionAt ? date(item.nextActionAt) : 'Nenhuma ação programada'}
        />
      </section>
      {manualClosure ? (
        <section
          className={`closure-reason ${item.status === 'CANCELLED' ? 'closure-reason-cancelled' : 'closure-reason-confirmed'}`}
          aria-label={
            item.status === 'CANCELLED' ? 'Motivo do cancelamento' : 'Motivo da confirmação'
          }
        >
          <span className="closure-reason-icon">
            <Icon name={item.status === 'CANCELLED' ? 'alert' : 'check'} />
          </span>
          <div>
            <small>
              {item.status === 'CANCELLED'
                ? 'Motivo do cancelamento manual'
                : 'Motivo da confirmação manual'}
            </small>
            <strong>{manualClosure.reason || 'Motivo não informado'}</strong>
            <span>
              Registrado por {manualClosure.user?.name || 'usuário não identificado'} em{' '}
              {date(manualClosure.createdAt)}
            </span>
          </div>
        </section>
      ) : null}

      <section className="convocation-layout">
        <div className="convocation-main">
          <article className="panel patient-panel">
            <header className="panel-header">
              <div>
                <h2>Informações do paciente</h2>
                <span className="muted">Dados pessoais e contato utilizado nesta convocação</span>
              </div>
            </header>
            <div className="patient-details">
              <Detail
                label="Data de nascimento"
                value={item.patient.birthDate ? dateOnly(item.patient.birthDate) : 'Não informada'}
              />
              <Detail label="CPF" value={formatCpf(item.patient.cpf)} />
              <Detail label="CNS" value={formatCns(item.patient.cns)} />
              <Detail
                label="Solicitações agrupadas"
                value={`${item.records.length} ${item.records.length === 1 ? 'registro' : 'registros'}`}
              />
              <div className="contact-details">
                <small className="stat-label">Telefones</small>
                <div className="phone-list">
                  {item.selectedPhone ? (
                    <div className="phone-item" key={item.selectedPhone.id}>
                      <span className="phone-icon">
                        <Icon name="message" />
                      </span>
                      <span>
                        <strong>{formatPhone(item.selectedPhone.normalizedValue)}</strong>
                        <small>Número de WhatsApp do paciente</small>
                      </span>
                    </div>
                  ) : (
                    <p className="muted">Nenhum telefone cadastrado.</p>
                  )}
                </div>
              </div>
            </div>
          </article>

          <article className="panel">
            <header className="panel-header">
              <div>
                <h2>Solicitações e procedimentos</h2>
                <span className="muted">Registros agrupados nesta convocação</span>
              </div>
              <span className="badge">
                {item.records.length} {item.records.length === 1 ? 'registro' : 'registros'}
              </span>
            </header>
            <div className="panel-body record-list">
              {item.records.map((relation: any) => {
                const record = relation.sourceRecord;
                return (
                  <section className="record-card" key={record.id}>
                    <div className="record-heading">
                      <div>
                        <small className="stat-label">Código da convocação</small>
                        <strong>{record.codigoConvocacaoOrigem}</strong>
                      </div>
                      <span className="badge">{date(record.scheduledAt)}</span>
                    </div>
                    <div className="procedure-list">
                      {record.procedures.map((procedure: any) => (
                        <div className="procedure-item" key={procedure.id}>
                          <span className="procedure-icon">
                            <Icon name="file" />
                          </span>
                          <div>
                            <small>Procedimento</small>
                            <strong>{procedure.name}</strong>
                          </div>
                        </div>
                      ))}
                      {!record.procedures.length ? (
                        <p className="muted">Nenhum procedimento associado a este registro.</p>
                      ) : null}
                    </div>
                  </section>
                );
              })}
              {!item.records.length ? (
                <p className="muted">Nenhum registro de origem associado.</p>
              ) : null}
            </div>
          </article>
          <article className="panel">
            <header className="panel-header">
              <div>
                <h2>Mensagens enviadas</h2>
                <span className="muted">
                  Convocações e respostas automáticas enviadas pelo WhatsApp
                </span>
              </div>
              <span className="badge">
                {item.messages.length} {item.messages.length === 1 ? 'mensagem' : 'mensagens'}
              </span>
            </header>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Etapa</th>
                    <th>Modelo da mensagem</th>
                    <th>Situação</th>
                    <th>Enviada ao provedor</th>
                    <th>Entregue</th>
                    <th>Lida</th>
                  </tr>
                </thead>
                <tbody>
                  {item.messages.map((m: any) => (
                    <tr key={m.id}>
                      <td>{messageLabel(m)}</td>
                      <td>{messageTemplateLabel(m)}</td>
                      <td>
                        <StatusBadge value={m.status} />
                      </td>
                      <td>{date(m.submittedAt)}</td>
                      <td>{date(m.deliveredAt)}</td>
                      <td>{date(m.readAt)}</td>
                    </tr>
                  ))}
                  {item.messages.some((m: any) => m.failureReason) ? (
                    <tr className="message-failure-row">
                      <td colSpan={6}>
                        {item.messages
                          .filter((m: any) => m.failureReason)
                          .map((m: any) => (
                            <div key={m.id}>
                              <strong>{messageLabel(m)}:</strong> {m.failureReason}
                              {m.failureCode ? ` (código ${m.failureCode})` : ''}
                            </div>
                          ))}
                      </td>
                    </tr>
                  ) : null}
                  {!item.messages.length ? (
                    <tr>
                      <td colSpan={6} className="muted">
                        Nenhuma mensagem enviada.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </article>
          <article className="panel">
            <header className="panel-header">
              <div>
                <h2>Respostas recebidas</h2>
                <span className="muted">Botões e mensagens livres enviadas pelo paciente</span>
              </div>
              <span className="badge">{item.responses.length}</span>
            </header>
            <div className="panel-body response-list">
              {item.responses.map((response: any) => (
                <div className="response-item" key={response.id}>
                  <span className="response-icon">
                    <Icon name="message" />
                  </span>
                  <div>
                    <strong>{responseLabel(response.action)}</strong>
                    <span>
                      {response.rawText || 'Resposta recebida por botão do modelo oficial'}
                    </span>
                    <small>
                      {response.sourceStage
                        ? stageLabel(response.sourceStage)
                        : 'Etapa não identificada'}{' '}
                      · {date(response.receivedAt)}
                    </small>
                  </div>
                </div>
              ))}
              {!item.responses.length ? (
                <p className="muted">Nenhuma resposta recebida até o momento.</p>
              ) : null}
            </div>
          </article>
        </div>
        <aside className="convocation-side">
          <article className="panel timeline-panel">
            <header className="panel-header">
              <div>
                <h2>Histórico da comunicação</h2>
                <span className="muted">Eventos mais recentes primeiro</span>
              </div>
            </header>
            <div className="panel-body">
              <ol className="timeline">
                {events.map((event: any) => (
                  <li className="timeline-item" key={event.id}>
                    <span className="timeline-dot" />
                    <span className="timeline-copy">
                      <strong>{event.title}</strong>
                      {event.detail ? <span>{event.detail}</span> : null}
                      <small>{date(event.date)}</small>
                    </span>
                  </li>
                ))}
                {!events.length ? <p className="muted">Nenhum evento registrado.</p> : null}
              </ol>
            </div>
          </article>
          <article className="panel flow-note">
            <span className="stat-icon">
              <Icon name="clock" />
            </span>
            <div>
              <strong>
                {isTerminal(item.status) ? 'Fluxo finalizado' : 'Acompanhamento automático'}
              </strong>
              <p>
                {isTerminal(item.status)
                  ? 'Nenhuma nova convocação será enviada para este paciente.'
                  : 'As próximas convocações serão interrompidas assim que houver confirmação ou cancelamento.'}
              </p>
            </div>
          </article>
        </aside>
      </section>
      {manualStatus ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => !saving && setManualStatus(null)}
        >
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-status-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="modal-header">
              <div>
                <span className="page-eyebrow">Alteração manual</span>
                <h2 id="manual-status-title">
                  {manualStatus === 'CONFIRMED' ? 'Confirmar paciente' : 'Cancelar convocação'}
                </h2>
              </div>
            </header>
            <div className="modal-body">
              <p className="muted">
                Esta ação finaliza o fluxo e bloqueia automaticamente os próximos disparos.
              </p>
              <div className="field">
                <label htmlFor="manual-reason">Motivo da alteração</label>
                <textarea
                  id="manual-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Ex.: confirmação recebida por telefone"
                  maxLength={500}
                  autoFocus
                />
                <span className="field-hint">O motivo ficará registrado na auditoria.</span>
              </div>
            </div>
            <footer className="modal-actions">
              <button
                className="button secondary"
                disabled={saving}
                onClick={() => setManualStatus(null)}
              >
                Voltar
              </button>
              <button
                className={`button ${manualStatus === 'CANCELLED' ? 'danger' : ''}`}
                disabled={saving || reason.trim().length < 3}
                onClick={() => void submitManualStatus()}
              >
                {saving
                  ? 'Salvando…'
                  : manualStatus === 'CONFIRMED'
                    ? 'Confirmar paciente'
                    : 'Cancelar convocação'}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <small className="stat-label">{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
function SummaryItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="summary-item">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
function date(value?: string | null) {
  return value ? formatDateTime(value) : '—';
}
function messageLabel(message: { stage: string; templateName: string }) {
  if (message.templateName === 'resposta_automatica_confirmacao') {
    return 'Resposta automática de confirmação';
  }
  if (message.templateName === 'resposta_automatica_cancelamento') {
    return 'Resposta automática de cancelamento';
  }
  return stageLabel(message.stage);
}
function messageTemplateLabel(message: { stage: string; templateName: string }) {
  if (message.templateName.startsWith('resposta_automatica_')) {
    return 'Mensagem de sessão';
  }
  return templateLabel(message.stage);
}
function dateOnly(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(value));
}
function formatCpf(value?: string | null) {
  if (!value) return '—';
  const digits = value.replace(/\D/g, '');
  return digits.length === 11
    ? digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
    : value;
}
function formatCns(value?: string | null) {
  if (!value) return '—';
  const digits = value.replace(/\D/g, '');
  return digits.length === 15
    ? digits.replace(/^(\d{3})(\d{4})(\d{4})(\d{4})$/, '$1 $2 $3 $4')
    : value;
}
function formatPhone(value?: string | null) {
  if (!value) return '—';
  const digits = value.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('55')) {
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 12 && digits.startsWith('55')) {
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
  return `+${digits}`;
}
function isTerminal(value: string) {
  return ['CONFIRMED', 'CANCELLED', 'FINISHED_NO_RESPONSE'].includes(value);
}
function responseLabel(value: string) {
  return (
    (
      {
        CONFIRM: 'confirmação do paciente',
        CANCEL: 'cancelamento do paciente',
        FREE_TEXT: 'mensagem de texto livre',
        UNKNOWN: 'resposta não identificada',
      } as Record<string, string>
    )[value] ?? 'resposta não identificada'
  );
}
function auditLabel(value: string) {
  return (
    (
      {
        CONVOCATION_STATUS_CHANGED_MANUALLY: 'Situação alterada manualmente',
        CONVOCATION_PHONE_CHANGED: 'Telefone selecionado alterado',
        PATIENT_CONFIRMED: 'Paciente confirmado',
        PATIENT_CANCELLED: 'Paciente cancelou',
      } as Record<string, string>
    )[value] ?? 'Atualização administrativa'
  );
}
function handoffLabel(value: string) {
  return (
    (
      {
        PENDING: 'pendente',
        QUEUED: 'na fila',
        PROCESSING: 'em processamento',
        SUBMITTED: 'enviado',
        FAILED: 'com falha',
      } as Record<string, string>
    )[value] ?? value.toLocaleLowerCase('pt-BR')
  );
}
