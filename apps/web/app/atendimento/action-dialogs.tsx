'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { dateTimeLocalToIso, formatDateTime, toDateTimeLocalValue } from '../lib/date-time';
import {
  inboxApi,
  type AutomationPreview,
  type ConversationDetail,
  type ConvocationRef,
  type InboxMe,
  type TeamMemberOption,
  type TeamOption,
} from '../lib/inbox-api';
import { stageLabel, statusLabel } from '../lib/labels';
import styles from './atendimento.module.css';

export type DialogState =
  | { kind: 'assign' }
  | { kind: 'transfer' }
  | { kind: 'status'; status: 'WAITING_CONTACT' | 'SNOOZED' | 'RESOLVED' | 'OPEN' }
  | { kind: 'link'; convocation: ConvocationRef }
  | { kind: 'unlink'; convocation: ConvocationRef }
  | { kind: 'optout'; optedOut: boolean }
  | { kind: 'automation' };

export interface DialogHandlers {
  assign: (assigneeId: string) => Promise<boolean>;
  transfer: (body: { toTeamId?: string; toUserId?: string; reason: string }) => Promise<boolean>;
  status: (body: {
    status: 'WAITING_CONTACT' | 'SNOOZED' | 'RESOLVED' | 'OPEN';
    snoozedUntil?: string;
    reason?: string;
  }) => Promise<boolean>;
  link: (convocationId: string) => Promise<boolean>;
  unlink: (convocationId: string) => Promise<boolean>;
  optOut: (optedOut: boolean, reason: string) => Promise<boolean>;
  resume: (convocationIds: string[], version: number) => Promise<boolean>;
}

const STATUS_TITLES = {
  WAITING_CONTACT: 'Marcar como aguardando cidadão',
  SNOOZED: 'Adiar conversa',
  RESOLVED: 'Resolver conversa',
  OPEN: 'Reabrir conversa',
} as const;

export function ActionDialog({
  dialog,
  detail,
  me,
  handlers,
  onClose,
}: {
  dialog: DialogState;
  detail: ConversationDetail;
  me: InboxMe | null;
  handlers: DialogHandlers;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const run = async (action: () => Promise<boolean>) => {
    setSaving(true);
    try {
      if (await action()) onClose();
    } finally {
      setSaving(false);
    }
  };

  switch (dialog.kind) {
    case 'assign':
      return (
        <AssignDialog
          detail={detail}
          me={me}
          saving={saving}
          onClose={onClose}
          onSubmit={(id) => run(() => handlers.assign(id))}
        />
      );
    case 'transfer':
      return (
        <TransferDialog
          detail={detail}
          me={me}
          saving={saving}
          onClose={onClose}
          onSubmit={(body) => run(() => handlers.transfer(body))}
        />
      );
    case 'status':
      return (
        <StatusDialog
          status={dialog.status}
          saving={saving}
          onClose={onClose}
          onSubmit={(body) => run(() => handlers.status(body))}
        />
      );
    case 'link':
      return (
        <LinkDialog
          convocation={dialog.convocation}
          ambiguous={detail.ambiguous}
          saving={saving}
          onClose={onClose}
          onSubmit={() => run(() => handlers.link(dialog.convocation.convocationId))}
        />
      );
    case 'unlink':
      return (
        <Dialog
          title="Desvincular convocação"
          saving={saving}
          onClose={onClose}
          submitLabel="Desvincular"
          danger
          onSubmit={() => run(() => handlers.unlink(dialog.convocation.convocationId))}
        >
          <p>
            A convocação de <strong>{dialog.convocation.patient.displayName}</strong> deixará de
            aparecer como contexto desta conversa.
          </p>
        </Dialog>
      );
    case 'optout':
      return (
        <OptOutDialog
          optedOut={dialog.optedOut}
          saving={saving}
          onClose={onClose}
          onSubmit={(reason) => run(() => handlers.optOut(dialog.optedOut, reason))}
        />
      );
    case 'automation':
      return (
        <AutomationDialog
          conversationId={detail.id}
          saving={saving}
          onClose={onClose}
          onSubmit={(ids, version) => run(() => handlers.resume(ids, version))}
        />
      );
  }
}

function Dialog({
  title,
  children,
  saving,
  onClose,
  onSubmit,
  submitLabel,
  canSubmit = true,
  danger = false,
}: {
  title: string;
  children: ReactNode;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  canSubmit?: boolean;
  danger?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button');
    first?.focus();
    return () => previous?.focus?.();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!saving && canSubmit) onSubmit();
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => !saving && onClose()}>
      <form
        ref={ref}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !saving) {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-actions">
          <button type="button" className="button secondary" disabled={saving} onClick={onClose}>
            Voltar
          </button>
          <button
            type="submit"
            className={`button${danger ? ' danger' : ''}`}
            disabled={saving || !canSubmit}
          >
            {saving ? 'Salvando…' : submitLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}

/**
 * GET /teams devolve as equipes com membros (ADMIN: todas; demais: só as próprias equipes
 * ativas). Sem ela não há como escolher responsável: o diálogo explica e não deixa digitar ID.
 */
function useTeams() {
  const [teams, setTeams] = useState<TeamOption[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    inboxApi
      .teams()
      .then((value) => active && setTeams(value.filter((team) => team.active)))
      .catch((cause) => {
        if (!active) return;
        setTeams([]);
        setError(cause instanceof Error ? cause.message : 'Não foi possível carregar as equipes.');
      });
    return () => {
      active = false;
    };
  }, []);
  return { teams, error };
}

function activeMembers(team: TeamOption | undefined): TeamMemberOption[] {
  return (team?.members ?? []).filter((member) => member.active);
}

function MemberField({
  team,
  loading,
  value,
  onChange,
  label,
  optional,
}: {
  team: TeamOption | undefined;
  loading: boolean;
  value: string;
  onChange: (value: string) => void;
  label: string;
  optional?: boolean;
}) {
  const id = useId();
  const members = activeMembers(team);
  return (
    <div className={styles.dialogField}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={loading || members.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">
          {loading
            ? 'Carregando…'
            : members.length === 0
              ? 'Nenhum membro ativo disponível'
              : optional
                ? 'Ninguém (devolver à fila da equipe)'
                : 'Selecione'}
        </option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
            {member.role === 'SUPERVISOR' ? ' (supervisor)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function AssignDialog({
  detail,
  me,
  saving,
  onClose,
  onSubmit,
}: {
  detail: ConversationDetail;
  me: InboxMe | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: (assigneeId: string) => void;
}) {
  const { teams, error } = useTeams();
  const [assigneeId, setAssigneeId] = useState('');
  const team = teams?.find((option) => option.id === detail.team?.id);
  const meIsMember = Boolean(me && activeMembers(team).some((member) => member.id === me.userId));
  return (
    <Dialog
      title="Atribuir conversa"
      saving={saving}
      onClose={onClose}
      submitLabel="Atribuir"
      canSubmit={Boolean(assigneeId) && assigneeId !== detail.assignee?.id}
      onSubmit={() => onSubmit(assigneeId)}
    >
      <p className="muted">
        Atribuir pausa a automação das convocações relacionadas a este contato.
      </p>
      {!detail.team ? (
        <p className={styles.warn}>
          A conversa não está em nenhuma equipe. Transfira para uma equipe antes de atribuir.
        </p>
      ) : (
        <MemberField
          team={team}
          loading={teams === null}
          value={assigneeId}
          onChange={setAssigneeId}
          label={`Responsável (${detail.team.name})`}
        />
      )}
      {error ? <p className={styles.warn}>{error}</p> : null}
      {me && meIsMember ? (
        <button
          type="button"
          className="button ghost small"
          onClick={() => setAssigneeId(me.userId)}
        >
          Atribuir a mim
        </button>
      ) : null}
    </Dialog>
  );
}

function TransferDialog({
  detail,
  me,
  saving,
  onClose,
  onSubmit,
}: {
  detail: ConversationDetail;
  me: InboxMe | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: (body: { toTeamId?: string; toUserId?: string; reason: string }) => void;
}) {
  const { teams, error } = useTeams();
  const [teamId, setTeamId] = useState(detail.team?.id ?? '');
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const teamFieldId = useId();
  const reasonId = useId();
  // A API recusa destino idêntico (mesma equipe e mesmo responsável). Sem pessoa = volta à fila.
  const sameDestination =
    teamId === (detail.team?.id ?? '') && (userId || null) === (detail.assignee?.id ?? null);
  const valid = Boolean(teamId) && !sameDestination && reason.trim().length >= 3;
  return (
    <Dialog
      title="Transferir conversa"
      saving={saving}
      onClose={onClose}
      submitLabel="Transferir"
      canSubmit={valid}
      onSubmit={() =>
        onSubmit({
          toTeamId: teamId,
          ...(userId ? { toUserId: userId } : {}),
          reason: reason.trim(),
        })
      }
    >
      <div className={styles.dialogField}>
        <label htmlFor={teamFieldId}>Equipe de destino</label>
        <select
          id={teamFieldId}
          value={teamId}
          disabled={teams === null}
          onChange={(event) => {
            setTeamId(event.target.value);
            setUserId('');
          }}
        >
          {teams === null ? <option value={teamId}>Carregando…</option> : null}
          {teams !== null && !teams.some((team) => team.id === teamId) ? (
            <option value={teamId}>{detail.team?.name ?? 'Selecione'}</option>
          ) : null}
          {(teams ?? []).map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
              {team.id === detail.team?.id ? ' (atual)' : ''}
            </option>
          ))}
        </select>
        {me?.globalRole !== 'ADMIN' ? (
          <span className="field-hint">Aparecem somente as equipes das quais você participa.</span>
        ) : null}
      </div>
      <MemberField
        team={teams?.find((team) => team.id === teamId)}
        loading={teams === null}
        value={userId}
        onChange={setUserId}
        label="Pessoa de destino (opcional)"
        optional
      />
      {error ? <p className={styles.warn}>{error}</p> : null}
      {sameDestination && teamId ? (
        <span className="field-hint">Escolha outra equipe ou outra pessoa.</span>
      ) : null}
      <div className={styles.dialogField}>
        <label htmlFor={reasonId}>Motivo da transferência (obrigatório)</label>
        <textarea
          id={reasonId}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          required
        />
      </div>
    </Dialog>
  );
}

function StatusDialog({
  status,
  saving,
  onClose,
  onSubmit,
}: {
  status: 'WAITING_CONTACT' | 'SNOOZED' | 'RESOLVED' | 'OPEN';
  saving: boolean;
  onClose: () => void;
  onSubmit: (body: { status: typeof status; snoozedUntil?: string; reason?: string }) => void;
}) {
  const [until, setUntil] = useState(() =>
    toDateTimeLocalValue(new Date(Date.now() + 24 * 3_600_000)),
  );
  const [reason, setReason] = useState('');
  const untilId = useId();
  const reasonId = useId();
  const untilIso = status === 'SNOOZED' && until ? dateTimeLocalToIso(until) : undefined;
  const validUntil =
    status !== 'SNOOZED' || (untilIso !== undefined && Date.parse(untilIso) > Date.now());
  return (
    <Dialog
      title={STATUS_TITLES[status]}
      saving={saving}
      onClose={onClose}
      submitLabel="Confirmar"
      canSubmit={validUntil}
      onSubmit={() =>
        onSubmit({
          status,
          ...(untilIso ? { snoozedUntil: untilIso } : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        })
      }
    >
      {status === 'RESOLVED' ? (
        <p className="muted">
          Resolver não retoma a automação de convocações. Uma nova mensagem do cidadão abre um novo
          protocolo.
        </p>
      ) : null}
      {status === 'SNOOZED' ? (
        <div className={styles.dialogField}>
          <label htmlFor={untilId}>Adiar até</label>
          <input
            id={untilId}
            type="datetime-local"
            value={until}
            min={toDateTimeLocalValue(new Date())}
            onChange={(event) => setUntil(event.target.value)}
            required
          />
          {!validUntil ? <span className="field-hint">Escolha uma data futura.</span> : null}
        </div>
      ) : null}
      <div className={styles.dialogField}>
        <label htmlFor={reasonId}>Motivo (opcional)</label>
        <textarea
          id={reasonId}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
        />
      </div>
    </Dialog>
  );
}

function LinkDialog({
  convocation,
  ambiguous,
  saving,
  onClose,
  onSubmit,
}: {
  convocation: ConvocationRef;
  ambiguous: boolean;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const checkId = useId();
  return (
    <Dialog
      title="Vincular convocação"
      saving={saving}
      onClose={onClose}
      submitLabel="Vincular"
      canSubmit={confirmed}
      onSubmit={onSubmit}
    >
      <p>
        Convocação de <strong>{convocation.patient.displayName}</strong> na campanha{' '}
        {convocation.campaign.name} ({stageLabel(convocation.stage)}).
      </p>
      <p className={styles.warn}>
        Esta convocação usa o mesmo telefone, mas isso não comprova que o cidadão da conversa é o
        paciente. Confirme a identidade antes de vincular.
        {ambiguous ? ' Há mais de uma convocação ativa para este telefone.' : ''}
      </p>
      <label className={styles.checkRow} htmlFor={checkId}>
        <input
          id={checkId}
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>Confirmei a identidade do cidadão para esta convocação.</span>
      </label>
    </Dialog>
  );
}

function OptOutDialog({
  optedOut,
  saving,
  onClose,
  onSubmit,
}: {
  optedOut: boolean;
  saving: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const reasonId = useId();
  return (
    <Dialog
      title={optedOut ? 'Registrar opt-out' : 'Remover opt-out'}
      saving={saving}
      onClose={onClose}
      submitLabel="Confirmar"
      danger={optedOut}
      canSubmit={reason.trim().length >= 3}
      onSubmit={() => onSubmit(reason.trim())}
    >
      <p className="muted">
        {optedOut
          ? 'O contato deixará de receber mensagens, inclusive respostas humanas.'
          : 'O contato voltará a poder receber mensagens dentro das regras de atendimento.'}
      </p>
      <div className={styles.dialogField}>
        <label htmlFor={reasonId}>Motivo (obrigatório)</label>
        <textarea
          id={reasonId}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          required
        />
      </div>
    </Dialog>
  );
}

function AutomationDialog({
  conversationId,
  saving,
  onClose,
  onSubmit,
}: {
  conversationId: string;
  saving: boolean;
  onClose: () => void;
  onSubmit: (ids: string[], version: number) => void;
}) {
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    inboxApi
      .automation(conversationId)
      .then((value) => {
        if (!active) return;
        setPreview(value);
        setSelected(value.canResume ? value.paused.map((item) => item.convocationId) : []);
      })
      .catch(
        (cause) =>
          active &&
          setError(cause instanceof Error ? cause.message : 'Não foi possível carregar a prévia.'),
      );
    return () => {
      active = false;
    };
  }, [conversationId]);
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  return (
    <Dialog
      title="Retomar automação"
      saving={saving}
      onClose={onClose}
      submitLabel="Retomar selecionadas"
      canSubmit={Boolean(preview?.canResume) && selected.length > 0}
      onSubmit={() => preview && onSubmit(selected, preview.version)}
    >
      {error ? (
        <p className={styles.warn} role="alert">
          {error}
        </p>
      ) : null}
      {!preview && !error ? (
        <p className="muted" role="status">
          Carregando prévia…
        </p>
      ) : null}
      {preview && !preview.canResume ? (
        <p className={styles.warn}>Somente supervisores da equipe podem retomar a automação.</p>
      ) : null}
      {preview?.paused.length === 0 ? <p className="muted">Nenhuma convocação em pausa.</p> : null}
      {preview && preview.paused.length > 0 ? (
        <fieldset className={styles.section}>
          <legend className="muted">
            Os envios abaixo voltarão a seguir o fluxo automático. Envios vencidos podem sair logo
            após a retomada.
          </legend>
          {preview.paused.map((item) => (
            <label key={item.convocationId} className={`${styles.card} ${styles.checkRow}`}>
              <input
                type="checkbox"
                checked={selected.includes(item.convocationId)}
                disabled={!preview.canResume}
                onChange={() => toggle(item.convocationId)}
              />
              <span>
                <strong>{item.patient.displayName}</strong>
                <br />
                {item.campaign.name} · {stageLabel(item.stage)} · {statusLabel(item.status)}
                {item.nextActionAt ? ` · próximo envio ${formatDateTime(item.nextActionAt)}` : ''}
                {item.overdue ? (
                  <>
                    {' '}
                    <span className={styles.chip} data-tone="warning">
                      Vencido
                    </span>
                  </>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </Dialog>
  );
}
