'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { AppShell } from '../../components/navigation';
import {
  EmptyState,
  Feedback,
  Icon,
  LoadingState,
  Pagination,
  StatusBadge,
} from '../../components/ui';
import { authFetch } from '../../lib/api';
import { APP_TIME_ZONE, dateTimeLocalToIso, toDateTimeLocalValue } from '../../lib/date-time';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';

type RowData = {
  codigoConvocacaoOrigem?: string | null;
  nome?: string | null;
  dataNascimento?: string | null;
  cpf?: string | null;
  cns?: string | null;
  telefones?: string[];
  dataHora?: string | null;
  procedimentos?: string[];
  selectedPhone?: string | null;
};
type ImportRow = {
  id: string;
  rowNumber: number;
  validationStatus: string;
  validationIssues: string[] | null;
  data: RowData | null;
};
type PatientGroup = {
  key: string;
  name: string | null;
  birthDate: string | null;
  cpf: string | null;
  cns: string | null;
  rowIds: string[];
  recordCount: number;
  codes: string[];
  procedures: string[];
  phones: Array<{ original: string; normalized: string | null; valid: boolean; mobile: boolean }>;
  selectedPhone: string | null;
  eligible: boolean;
  issues: string[];
};
type Review = {
  id: string;
  status: string;
  layout: string | null;
  totalReported: number | null;
  recordsFound: number | null;
  warnings: string[] | null;
  counts: {
    totalRows: number;
    validRows: number;
    warningRows: number;
    invalidRows: number;
    identifiedPatients: number;
    eligiblePatients: number;
    patientsWithoutValidPhone: number;
  };
  canApprove: boolean;
  sourceRecordCount: number;
  campaign: { id: string; name: string; status: string; firstActionAt: string | null } | null;
  rows: ImportRow[];
  patientGroups: PatientGroup[];
};
type Notice = { tone: 'success' | 'error' | 'notice'; text: string } | null;

function formatCns(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits.length === 15
    ? digits.replace(/^(\d{3})(\d{4})(\d{4})(\d{4})$/, '$1 $2 $3 $4')
    : value;
}

export default function ImportReviewPage() {
  const params = useParams<{ id: string }>();
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<'records' | 'patients'>('records');
  const [query, setQuery] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ImportRow | null>(null);
  const [showApproval, setShowApproval] = useState(false);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [campaignStatus, setCampaignStatus] = useState<string | null>(null);

  async function request(path: string, init?: RequestInit) {
    const response = await authFetch(`${API_URL}${path}`, init);
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.message ?? 'Não foi possível concluir a operação');
    return body;
  }
  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const loaded = (await request(`/imports/${params.id}/review`)) as Review;
      setReview(loaded);
      setCampaignId(loaded.campaign?.id ?? null);
      setCampaignStatus(loaded.campaign?.status ?? null);
      if (!['UPLOADED', 'PROCESSING'].includes(loaded.status)) setNotice(null);
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Falha ao carregar a revisão',
      });
    } finally {
      if (!silent) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [params.id]);
  useEffect(() => {
    if (!review || !['UPLOADED', 'PROCESSING'].includes(review.status)) return;
    const timer = window.setInterval(() => void load(true), 3000);
    return () => window.clearInterval(timer);
  }, [review?.status, params.id]);

  async function approve(note: string) {
    setLoading(true);
    try {
      await request(`/imports/${params.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: note || undefined }),
      });
      setShowApproval(false);
      await load(true);
      setNotice({ tone: 'success', text: 'Importação aprovada. Agora defina a programação.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Não foi possível aprovar',
      });
    } finally {
      setLoading(false);
    }
  }

  async function abortFlow() {
    if (!window.confirm('Abortar esta importação e qualquer campanha ainda em rascunho?')) return;
    setLoading(true);
    try {
      await request(`/imports/${params.id}/cancel`, { method: 'POST' });
      await load(true);
      setNotice({
        tone: 'success',
        text: 'Fluxo abortado. Nenhum novo processamento será iniciado.',
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Não foi possível abortar o fluxo',
      });
    } finally {
      setLoading(false);
    }
  }

  async function saveRow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setLoading(true);
    const data = new FormData(event.currentTarget);
    try {
      await request(`/imports/${params.id}/rows/${editing.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          codigoConvocacaoOrigem: data.get('codigoConvocacaoOrigem'),
          nome: data.get('nome'),
          dataNascimento: data.get('dataNascimento'),
          cpf: data.get('cpf'),
          cns: data.get('cns'),
          telefones: String(data.get('telefones') ?? '')
            .split(/\n|,/)
            .map((v) => v.trim())
            .filter(Boolean),
          selectedPhone: data.get('selectedPhone'),
          dataHora: data.get('dataHora'),
          procedimentos: String(data.get('procedimentos') ?? '')
            .split('\n')
            .map((v) => v.trim())
            .filter(Boolean),
        }),
      });
      setEditing(null);
      await load(true);
      setNotice({ tone: 'success', text: 'Registro atualizado e validado novamente.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Não foi possível salvar',
      });
    } finally {
      setLoading(false);
    }
  }

  async function createCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    const data = new FormData(event.currentTarget);
    try {
      const campaign = await request(`/campaigns/from-import/${params.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: data.get('name'),
          firstActionAt: dateTimeLocalToIso(String(data.get('firstActionAt'))),
          secondIntervalDays: Number(data.get('secondIntervalDays')),
          secondStartTime: data.get('secondStartTime'),
          thirdIntervalDays: Number(data.get('thirdIntervalDays')),
          thirdStartTime: data.get('thirdStartTime'),
          finalResponseWindowDays: Number(data.get('finalResponseWindowDays')),
        }),
      });
      setCampaignId(campaign.id);
      setCampaignStatus(campaign.status);
      await load(true);
      setNotice({
        tone: 'success',
        text: `Campanha criada com ${campaign.patientCount} pacientes. Confira o resumo antes de programar.`,
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Não foi possível criar a campanha',
      });
    } finally {
      setLoading(false);
    }
  }

  const filteredRows = useMemo(
    () =>
      (review?.rows ?? []).filter((row) => {
        const text =
          `${row.data?.nome ?? ''} ${row.data?.cpf ?? ''} ${row.data?.cns ?? ''} ${row.data?.codigoConvocacaoOrigem ?? ''} ${(row.data?.procedimentos ?? []).join(' ')}`.toLowerCase();
        return (
          (!query || text.includes(query.toLowerCase())) &&
          (!onlyIssues || row.validationStatus !== 'VALID')
        );
      }),
    [review, query, onlyIssues],
  );
  const pageSize = 25;
  const pages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const visibleRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);

  if (loading && !review)
    return (
      <AppShell title="Revisão da importação">
        <section className="panel">
          <LoadingState label="Analisando o arquivo e reconstruindo os registros…" />
        </section>
      </AppShell>
    );
  if (!review)
    return (
      <AppShell title="Revisão da importação">
        {notice ? <Feedback tone={notice.tone}>{notice.text}</Feedback> : null}
      </AppShell>
    );
  if (['UPLOADED', 'PROCESSING'].includes(review.status))
    return (
      <AppShell
        title="Processando importação"
        eyebrow={layoutLabel(review.layout)}
        actions={
          <div className="actions">
            <Link href="/importacoes" className="button secondary">
              Voltar
            </Link>
            <button className="button danger ghost" onClick={() => void abortFlow()}>
              Abortar
            </button>
          </div>
        }
      >
        <section className="panel">
          <LoadingState label="Extraindo e validando os dados do SISREG. Esta tela será atualizada automaticamente…" />
        </section>
      </AppShell>
    );
  if (review.status === 'CANCELLED')
    return (
      <AppShell title="Fluxo abortado" eyebrow={layoutLabel(review.layout)}>
        <section className="panel">
          <Feedback tone="notice">Esta importação foi abortada e não pode mais avançar.</Feedback>
          <Link href="/importacoes" className="button secondary">
            Voltar às importações
          </Link>
        </section>
      </AppShell>
    );

  const approved = review.status === 'APPROVED';
  const step = campaignId ? 5 : approved ? 4 : phase === 'patients' ? 3 : 2;
  return (
    <AppShell
      title={approved ? 'Programar campanha' : 'Conferir importação'}
      eyebrow={layoutLabel(review.layout)}
      actions={
        <div className="actions">
          <Link href="/importacoes" className="button secondary">
            Voltar
          </Link>
          {!['CANCELLED', 'FAILED'].includes(review.status) &&
          (!campaignStatus || campaignStatus === 'DRAFT') ? (
            <button className="button danger ghost" onClick={() => void abortFlow()}>
              Abortar
            </button>
          ) : null}
        </div>
      }
    >
      <section className="steps panel">
        {['Arquivo', 'Conferência', 'Pacientes', 'Programação', 'Revisão e início'].map(
          (label, index) => (
            <Step
              key={label}
              n={index + 1}
              label={label}
              state={index + 1 < step ? 'done' : index + 1 === step ? 'active' : ''}
            />
          ),
        )}
      </section>
      {notice ? <Feedback tone={notice.tone}>{notice.text}</Feedback> : null}
      {review.warnings?.map((warning) => (
        <Feedback tone="notice" key={warning}>
          {warning}
        </Feedback>
      ))}

      {!approved && phase === 'records' ? (
        <RecordsReview
          review={review}
          rows={visibleRows}
          query={query}
          onlyIssues={onlyIssues}
          page={page}
          pages={pages}
          total={filteredRows.length}
          onQuery={(value) => {
            setQuery(value);
            setPage(1);
          }}
          onOnlyIssues={(value) => {
            setOnlyIssues(value);
            setPage(1);
          }}
          onPage={setPage}
          onEdit={setEditing}
          onContinue={() => setPhase('patients')}
        />
      ) : !approved ? (
        <PatientsReview
          review={review}
          onBack={() => setPhase('records')}
          onApprove={() => setShowApproval(true)}
          loading={loading}
        />
      ) : !campaignId ? (
        <CampaignForm onSubmit={createCampaign} loading={loading} review={review} />
      ) : (
        <CampaignReady review={review} status={campaignStatus ?? 'DRAFT'} campaignId={campaignId} />
      )}
      {editing ? (
        <EditRowModal
          row={editing}
          loading={loading}
          onClose={() => setEditing(null)}
          onSubmit={saveRow}
        />
      ) : null}
      {showApproval ? (
        <ApprovalModal
          review={review}
          loading={loading}
          onClose={() => setShowApproval(false)}
          onApprove={approve}
        />
      ) : null}
    </AppShell>
  );
}

function RecordsReview({
  review,
  rows,
  query,
  onlyIssues,
  page,
  pages,
  total,
  onQuery,
  onOnlyIssues,
  onPage,
  onEdit,
  onContinue,
}: {
  review: Review;
  rows: ImportRow[];
  query: string;
  onlyIssues: boolean;
  page: number;
  pages: number;
  total: number;
  onQuery: (v: string) => void;
  onOnlyIssues: (v: boolean) => void;
  onPage: (v: number) => void;
  onEdit: (row: ImportRow) => void;
  onContinue: () => void;
}) {
  return (
    <>
      <section className="grid import-metrics">
        <Metric label="Registros encontrados" value={review.counts.totalRows} />
        <Metric label="Válidos" value={review.counts.validRows} tone="success" />
        <Metric
          label="Precisam de correção"
          value={review.counts.warningRows + review.counts.invalidRows}
          tone={review.counts.warningRows + review.counts.invalidRows ? 'warning' : 'success'}
        />
        <Metric label="Pacientes identificados" value={review.counts.identifiedPatients} />
      </section>
      <section className="panel section-gap">
        <header className="panel-header">
          <div>
            <h2>Registros extraídos</h2>
            <span className="muted">
              Revise os dados. Registros com erro não entrarão na campanha.
            </span>
          </div>
          <button className="button" onClick={onContinue}>
            Revisar pacientes <Icon name="chevron" />
          </button>
        </header>
        <div className="table-toolbar">
          <div className="input-with-icon toolbar-search">
            <Icon name="search" />
            <input
              className="input"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="Buscar paciente, CPF, CNS, código ou procedimento"
            />
          </div>
          <label className="checkbox-control">
            <input
              type="checkbox"
              checked={onlyIssues}
              onChange={(event) => onOnlyIssues(event.target.checked)}
            />{' '}
            Somente pendências
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Paciente</th>
                <th>Código</th>
                <th>Telefone selecionado</th>
                <th>Procedimentos</th>
                <th>Situação</th>
                <th>
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.rowNumber}</td>
                  <td>
                    <div className="cell-main">
                      <strong>{row.data?.nome || 'Não identificado'}</strong>
                      <small>{row.data?.dataNascimento || 'Nascimento ausente'}</small>
                      {row.data?.cns ? <small>CNS {formatCns(row.data.cns)}</small> : null}
                      {row.validationIssues?.map((issue) => (
                        <small className="danger-text" key={issue}>
                          {issue}
                        </small>
                      ))}
                    </div>
                  </td>
                  <td>{row.data?.codigoConvocacaoOrigem || '—'}</td>
                  <td>{row.data?.selectedPhone || row.data?.telefones?.[0] || '—'}</td>
                  <td>{row.data?.procedimentos?.join(', ') || '—'}</td>
                  <td>
                    <StatusBadge value={row.validationStatus} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => onEdit(row)}
                    >
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length ? (
          <EmptyState
            title="Nenhum registro encontrado"
            description="Ajuste a busca ou remova o filtro de pendências."
            icon="search"
          />
        ) : null}
        <Pagination page={page} pages={pages} total={total} limit={25} onPage={onPage} />
      </section>
    </>
  );
}

function PatientsReview({
  review,
  onBack,
  onApprove,
  loading,
}: {
  review: Review;
  onBack: () => void;
  onApprove: () => void;
  loading: boolean;
}) {
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h2>Agrupamento por paciente</h2>
          <span className="muted">
            Nome e nascimento formam a chave; quando houver CPF, ele tem prioridade.
          </span>
        </div>
        <div className="actions">
          <button className="button secondary" onClick={onBack}>
            Voltar aos registros
          </button>
          <button
            className="button"
            disabled={!review.canApprove || !review.counts.eligiblePatients || loading}
            onClick={onApprove}
          >
            <Icon name="check" /> Aprovar importação
          </button>
        </div>
      </header>
      <div className="panel-body">
        <div className="grid import-metrics">
          <Metric label="Pacientes identificados" value={review.counts.identifiedPatients} />
          <Metric
            label="Aptos para campanha"
            value={review.counts.eligiblePatients}
            tone="success"
          />
          <Metric
            label="Sem celular válido"
            value={review.counts.patientsWithoutValidPhone}
            tone={review.counts.patientsWithoutValidPhone ? 'warning' : 'success'}
          />
          <Metric label="Registros agrupados" value={review.counts.totalRows} />
        </div>
        <div className="patient-group-list">
          {review.patientGroups.map((group) => (
            <article
              className={`patient-group ${group.eligible ? '' : 'has-issue'}`}
              key={group.key}
            >
              <div>
                <strong>{group.name || 'Paciente não identificado'}</strong>
                <span>
                  {group.birthDate || 'Nascimento ausente'}
                  {group.cpf ? ` · CPF ${group.cpf}` : ''}
                  {group.cns ? ` · CNS ${formatCns(group.cns)}` : ''}
                </span>
              </div>
              <div>
                <span className="stat-label">Solicitações</span>
                <strong>{group.recordCount}</strong>
                <small>{group.codes.join(', ')}</small>
              </div>
              <div>
                <span className="stat-label">WhatsApp selecionado</span>
                <strong>{group.selectedPhone || 'Nenhum número válido'}</strong>
                <small>{group.phones.length} telefone(s) preservado(s)</small>
              </div>
              <div>
                <span className="stat-label">Procedimentos</span>
                <strong>{group.procedures.join(', ') || 'Não informado'}</strong>
              </div>
              <StatusBadge value={group.eligible ? 'VALID' : 'INVALID'} />
              {group.issues.length ? (
                <small className="danger-text patient-group-issues">{group.issues.join(' ')}</small>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function EditRowModal({
  row,
  loading,
  onClose,
  onSubmit,
}: {
  row: ImportRow;
  loading: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const data = row.data ?? {};
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-title"
        onSubmit={onSubmit}
      >
        <header className="panel-header">
          <div>
            <h2 id="edit-title">Editar registro #{row.rowNumber}</h2>
            <span className="muted">Os dados serão validados novamente ao salvar.</span>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="panel-body form-grid">
          <Field label="Nome completo" name="nome" defaultValue={data.nome ?? ''} required wide />
          <Field
            label="Data de nascimento (opcional)"
            name="dataNascimento"
            defaultValue={data.dataNascimento ?? ''}
            placeholder="DD/MM/AAAA"
          />
          <Field label="CPF (opcional)" name="cpf" defaultValue={data.cpf ?? ''} />
          <Field label="CNS (opcional)" name="cns" defaultValue={data.cns ?? ''} />
          <Field
            label="Código da convocação"
            name="codigoConvocacaoOrigem"
            defaultValue={data.codigoConvocacaoOrigem ?? ''}
            required
          />
          <Field
            label="Data e hora do procedimento"
            name="dataHora"
            defaultValue={data.dataHora ?? ''}
            placeholder="DD/MM/AAAA HH:mm"
            required
          />
          <label className="field wide">
            <span>
              Telefones <small>(um por linha)</small>
            </span>
            <textarea
              name="telefones"
              defaultValue={(data.telefones ?? []).join('\n')}
              rows={3}
              required
            />
          </label>
          <Field
            label="WhatsApp selecionado"
            name="selectedPhone"
            defaultValue={data.selectedPhone ?? data.telefones?.[0] ?? ''}
          />
          <label className="field wide">
            <span>
              Procedimentos <small>(um por linha)</small>
            </span>
            <textarea
              name="procedimentos"
              defaultValue={(data.procedimentos ?? []).join('\n')}
              rows={4}
              required
            />
          </label>
        </div>
        <footer className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="button" disabled={loading}>
            {loading ? 'Salvando…' : 'Salvar e validar'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function ApprovalModal({
  review,
  loading,
  onClose,
  onApprove,
}: {
  review: Review;
  loading: boolean;
  onClose: () => void;
  onApprove: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  const excluded = review.counts.totalRows - review.counts.validRows;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approve-title">
        <header className="panel-header">
          <h2 id="approve-title">Confirmar aprovação</h2>
        </header>
        <div className="panel-body">
          <p>
            Serão incluídos <strong>{review.counts.validRows} registros</strong>, agrupados em{' '}
            <strong>{review.counts.eligiblePatients} pacientes aptos</strong>.
          </p>
          {excluded ? (
            <Feedback tone="notice">
              {excluded} registro(s) com erro serão preservados no histórico, mas não entrarão na
              campanha.
            </Feedback>
          ) : null}
          <label className="field">
            <span>Observação da aprovação (opcional)</span>
            <textarea
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
            />
          </label>
        </div>
        <footer className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            Voltar
          </button>
          <button className="button" disabled={loading} onClick={() => onApprove(note)}>
            {loading ? 'Aprovando…' : 'Confirmar aprovação'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function CampaignForm({
  onSubmit,
  loading,
  review,
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  loading: boolean;
  review: Review;
}) {
  const minimum = toDateTimeLocalValue(new Date(Date.now() + 60_000));
  return (
    <form className="grid-main" onSubmit={onSubmit}>
      <article className="panel">
        <header className="panel-header">
          <div>
            <h2>Programação das convocações</h2>
            <span className="muted">
              Defina o início de cada etapa. O envio será distribuído pela fila.
            </span>
          </div>
        </header>
        <div className="panel-body schedule-stack">
          <ScheduleItem n={1} title="Primeira convocação">
            <div className="field">
              <label htmlFor="firstActionAt">Data e horário de início</label>
              <input
                id="firstActionAt"
                name="firstActionAt"
                type="datetime-local"
                min={minimum}
                defaultValue={minimum}
                required
              />
              <small className="muted">Fuso: São Paulo ({APP_TIME_ZONE})</small>
            </div>
          </ScheduleItem>
          <ScheduleItem n={2} title="Segunda convocação">
            <div className="schedule-fields">
              <NumberField id="secondIntervalDays" label="Dias após a primeira" value={2} />
              <TimeField id="secondStartTime" label="Horário de início" />
            </div>
          </ScheduleItem>
          <ScheduleItem n={3} title="Terceira convocação">
            <div className="schedule-fields">
              <NumberField id="thirdIntervalDays" label="Dias após a segunda" value={3} />
              <TimeField id="thirdStartTime" label="Horário de início" />
            </div>
          </ScheduleItem>
          <ScheduleItem n={4} title="Prazo final de resposta">
            <NumberField
              id="finalResponseWindowDays"
              label="Dias para responder após a terceira"
              value={1}
              min={1}
            />
          </ScheduleItem>
        </div>
      </article>
      <aside className="panel sticky-card">
        <header className="panel-header">
          <h2>Configurações</h2>
        </header>
        <div className="panel-body">
          <div className="field">
            <label htmlFor="name">Nome da campanha</label>
            <input
              id="name"
              name="name"
              defaultValue={`SISREG ${new Date().toLocaleDateString('pt-BR')}`}
              maxLength={120}
              required
            />
          </div>
          <Feedback tone="notice">
            <span>
              <strong>{review.counts.eligiblePatients} pacientes aptos</strong>
              <br />
              Uma mensagem por paciente em cada tentativa.
            </span>
          </Feedback>
          <button className="button full-width" disabled={loading}>
            {loading ? 'Criando…' : 'Continuar para revisão'} <Icon name="chevron" />
          </button>
        </div>
      </aside>
    </form>
  );
}

function CampaignReady({
  review,
  status,
  campaignId,
}: {
  review: Review;
  status: string;
  campaignId: string;
}) {
  return (
    <section className="grid-main">
      <article className="panel">
        <header className="panel-header">
          <div>
            <h2>Campanha criada com segurança</h2>
            <span className="muted">A programação ainda pode ser revisada antes da ativação.</span>
          </div>
          <StatusBadge value={status} />
        </header>
        <div className="panel-body">
          <Feedback tone="success">
            Os registros válidos foram agrupados e a campanha está em rascunho.
          </Feedback>
          <div className="grid">
            <Summary label="Pacientes aptos" value={review.counts.eligiblePatients} />
            <Summary label="Registros válidos" value={review.counts.validRows} />
            <Summary
              label="Excluídos por pendência"
              value={review.counts.totalRows - review.counts.validRows}
            />
          </div>
        </div>
      </article>
      <aside className="panel">
        <header className="panel-header">
          <h2>Revisão final</h2>
        </header>
        <div className="panel-body">
          <p className="muted">
            Confira datas, intervalos, volume e situação antes de programar. O disparo não será
            iniciado nesta tela.
          </p>
          <Link className="button full-width" href={`/campanhas/${campaignId}`}>
            Revisar campanha <Icon name="chevron" />
          </Link>
        </div>
      </aside>
    </section>
  );
}

function Field({
  label,
  name,
  wide,
  ...props
}: { label: string; name: string; wide?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span>{label}</span>
      <input name={name} {...props} />
    </label>
  );
}
function ScheduleItem({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="schedule-item">
      <span className="schedule-index">{n}</span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}
function NumberField({
  id,
  label,
  value,
  min = 0,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={id} type="number" min={min} max="30" defaultValue={value} required />
    </div>
  );
}
function TimeField({ id, label }: { id: string; label: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={id} type="time" defaultValue="09:00" required />
    </div>
  );
}
function Step({ n, label, state }: { n: number; label: string; state?: string }) {
  return (
    <div className={`step ${state ?? ''}`}>
      <span className="step-number">{state === 'done' ? <Icon name="check" /> : n}</span>
      <span>{label}</span>
    </div>
  );
}
function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <article className="card stat-card">
      <div className="stat-copy">
        <span className="stat-label">{label}</span>
        <strong className={`stat-value ${tone ? `${tone}-text` : ''}`}>
          {value.toLocaleString('pt-BR')}
        </strong>
      </div>
    </article>
  );
}
function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="cell-main">
      <span className="stat-label">{label}</span>
      <strong className="summary-value">{value.toLocaleString('pt-BR')}</strong>
    </div>
  );
}
function layoutLabel(value: string | null) {
  return value === 'REGULAMT_XLSX'
    ? 'Planilha REGULAMT identificada'
    : value === 'SISREG_V1'
    ? 'Relatório SISREG identificado'
    : value
      ? 'Formato de relatório identificado'
      : 'Formato em análise';
}
