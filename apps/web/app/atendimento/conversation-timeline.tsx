'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../components/ui';
import { formatDateTime } from '../lib/date-time';
import {
  INBOX_API,
  type ConversationDetail,
  type TimelineItem,
  type TimelineMessage,
} from '../lib/inbox-api';
import { activityLabel, ineligibilityLabel, messageStatusInfo } from '../lib/inbox-labels';
import { stageLabel } from '../lib/labels';
import {
  MAX_HUMAN_TEXT_LENGTH,
  MAX_NOTE_LENGTH,
  activityDetail,
  campaignRefLabel,
  composerState,
  formatRemaining,
} from './inbox-logic.mjs';
import styles from './atendimento.module.css';

type ComposerMode = 'reply' | 'note';

export function ConversationTimeline({
  detail,
  items,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  now,
  canNote,
  onSendReply,
  onAddNote,
}: {
  detail: ConversationDetail;
  items: TimelineItem[];
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  now: number;
  canNote: boolean;
  onSendReply: (text: string) => Promise<boolean>;
  onAddNote: (text: string) => Promise<boolean>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastKey = useRef<string | null>(null);
  // Nome do paciente só para convocações explicitamente vinculadas (CAMPAIGN_REF não traz paciente).
  const linked = new Map(
    detail.contexts.map((context) => [context.convocationId, context.patient.displayName]),
  );

  // Rola para o fim ao abrir a conversa ou quando chega item novo no fim (não ao carregar anteriores).
  useEffect(() => {
    const last = items.at(-1);
    const key = last ? `${detail.id}:${last.kind}:${last.id}` : null;
    if (key && key !== lastKey.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    lastKey.current = key;
  }, [items, detail.id]);

  return (
    <>
      <div
        ref={scrollRef}
        className={styles.timeline}
        role="log"
        aria-label={`Histórico da conversa ${detail.protocol}`}
        tabIndex={0}
      >
        {hasOlder ? (
          <button
            type="button"
            className={`button secondary small ${styles.loadOlder}`}
            onClick={onLoadOlder}
            disabled={loadingOlder}
          >
            {loadingOlder ? 'Carregando…' : 'Carregar anteriores'}
          </button>
        ) : null}
        {items.length === 0 ? (
          <p className={styles.empty}>Nenhum registro nesta conversa.</p>
        ) : null}
        {items.map((item) => (
          <TimelineEntry key={`${item.kind}:${item.id}`} item={item} linked={linked} />
        ))}
      </div>
      <Composer
        key={detail.id}
        detail={detail}
        now={now}
        canNote={canNote}
        onSendReply={onSendReply}
        onAddNote={onAddNote}
      />
    </>
  );
}

function TimelineEntry({ item, linked }: { item: TimelineItem; linked: Map<string, string> }) {
  if (item.kind === 'note') {
    return (
      <article className={`${styles.entry} ${styles.note}`} aria-label="Nota interna">
        <span className={styles.noteLabel}>
          <Icon name="file" width={16} height={16} />
          Nota interna — não é enviada ao cidadão
        </span>
        <p>{item.body}</p>
        <span className={styles.entryMeta}>
          {item.author?.name ?? 'Equipe'} · {formatDateTime(item.createdAt)}
        </span>
      </article>
    );
  }
  if (item.kind === 'activity') {
    const detail = activityDetail(item.type, item.metadata);
    return (
      <div className={`${styles.entry} ${styles.activity}`}>
        {activityLabel(item.type)}
        {detail ? `: ${detail}` : ''}
        {item.actor ? ` por ${item.actor.name}` : ''}
        {item.reason ? ` — ${item.reason}` : ''} · {formatDateTime(item.createdAt)}
      </div>
    );
  }
  return <MessageEntry message={item} linked={linked} />;
}

function MessageEntry({
  message,
  linked,
}: {
  message: TimelineMessage;
  linked: Map<string, string>;
}) {
  if (message.messageKind === 'CAMPAIGN_REF') {
    const ref = message.campaignMessage ?? null;
    const label = campaignRefLabel(
      ref
        ? {
            stage: ref.stage,
            attemptNumber: ref.attemptNumber,
            convocationId: ref.convocationId,
            patientName: linked.get(ref.convocationId) ?? null,
          }
        : null,
      linked.keys(),
    );
    const campaignStatus = ref?.status ?? message.status;
    const status = messageStatusInfo(campaignStatus);
    return (
      <article className={`${styles.entry} ${styles.campaign}`} aria-label="Template de campanha">
        <strong>{label.title}</strong>
        <span className={styles.entryMeta}>
          {label.patient ? `Paciente: ${label.patient}` : 'Mensagem oficial enviada pelo sistema'}
          {ref ? ` · ${ref.templateName} (${stageLabel(ref.stage)})` : ''}
        </span>
        <span className={styles.entryMeta}>
          <StatusChip status={campaignStatus} />
          {formatDateTime(message.createdAt)}
          <span className="sr-only">{status.description}</span>
        </span>
      </article>
    );
  }
  const inbound = message.messageKind === 'INBOUND' || message.direction === 'INBOUND';
  return (
    <article
      className={`${styles.entry} ${inbound ? styles.inbound : styles.outbound}`}
      aria-label={inbound ? 'Mensagem do cidadão' : 'Resposta da equipe'}
    >
      <p>{message.body ?? describeContent(message)}</p>
      {message.media?.length ? (
        <ul className={styles.entryMeta} aria-label="Anexos">
          {message.media.map((media) => (
            <li key={media.id}>
              {media.status === 'AVAILABLE' ? (
                <a href={`${INBOX_API}/media/${media.id}`} download rel="noopener">
                  Baixar anexo ({media.detectedMimeType ?? media.declaredMimeType ?? 'arquivo'})
                </a>
              ) : (
                `Anexo ${mediaStatus(media.status)}`
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {inbound && message.replyEligibility === 'NOT_ELIGIBLE' ? (
        <span className={styles.ineligible}>
          {ineligibilityLabel(message.eligibilityReason)} Não abre janela de resposta.
        </span>
      ) : null}
      {inbound && message.replyEligibility === 'ELIGIBLE_TEMPLATE_REPLY' ? (
        <span className={styles.entryMeta}>
          Resposta a template de campanha · abre a janela de 24 h
        </span>
      ) : null}
      <span className={styles.entryMeta}>
        {inbound ? 'Cidadão' : (message.author?.name ?? 'Você')} ·{' '}
        {formatDateTime(message.createdAt)}
        {!inbound ? <StatusChip status={message.status} /> : null}
      </span>
      {!inbound && message.status === 'FAILED' && message.failureCode ? (
        <span className={styles.ineligible}>Código da falha: {message.failureCode}</span>
      ) : null}
    </article>
  );
}

function StatusChip({ status }: { status: string }) {
  const info = messageStatusInfo(status);
  return (
    <span className={styles.chip} data-tone={info.tone} title={info.description}>
      {status === 'UNKNOWN' ? info.description : info.label}
    </span>
  );
}

function describeContent(message: TimelineMessage): string {
  const type = message.contentType ?? 'unknown';
  const labels: Record<string, string> = {
    image: '[Imagem]',
    document: '[Documento]',
    audio: '[Áudio]',
    video: '[Vídeo]',
    location: '[Localização compartilhada]',
    sticker: '[Figurinha]',
    contacts: '[Contato compartilhado]',
  };
  return labels[type] ?? '[Conteúdo não exibível]';
}

function mediaStatus(status: string): string {
  const labels: Record<string, string> = {
    PENDING: 'em verificação',
    QUARANTINED: 'em quarentena',
    AVAILABLE: 'disponível',
    REJECTED: 'rejeitado',
    EXPIRED: 'expirado',
  };
  return labels[status] ?? 'situação desconhecida';
}

function Composer({
  detail,
  now,
  canNote,
  onSendReply,
  onAddNote,
}: {
  detail: ConversationDetail;
  now: number;
  canNote: boolean;
  onSendReply: (text: string) => Promise<boolean>;
  onAddNote: (text: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<ComposerMode>('reply');
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const state = composerState(detail.replyPolicy, now);
  const isNote = mode === 'note';
  const text = isNote ? note : reply;
  const limit = isNote ? MAX_NOTE_LENGTH : MAX_HUMAN_TEXT_LENGTH;
  const disabled = isNote ? !canNote : !state.enabled;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || disabled || busy) return;
    setBusy(true);
    try {
      const ok = isNote ? await onAddNote(value) : await onSendReply(value);
      if (ok) (isNote ? setNote : setReply)('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`${styles.composer} ${isNote ? styles.noteComposer : ''}`} onSubmit={submit}>
      <div className={styles.composerTabs} role="tablist" aria-label="Tipo de registro">
        <button
          type="button"
          role="tab"
          id="composer-tab-reply"
          aria-controls="composer-panel"
          aria-selected={!isNote}
          data-mode="reply"
          onClick={() => setMode('reply')}
        >
          Responder ao cidadão
        </button>
        <button
          type="button"
          role="tab"
          id="composer-tab-note"
          aria-controls="composer-panel"
          aria-selected={isNote}
          data-mode="note"
          onClick={() => setMode('note')}
        >
          Nota interna
        </button>
      </div>
      <div
        id="composer-panel"
        role="tabpanel"
        aria-labelledby={isNote ? 'composer-tab-note' : 'composer-tab-reply'}
      >
        {isNote ? (
          <p className={styles.noteLabel} id="composer-hint">
            <Icon name="file" width={16} height={16} />
            Nota interna — não é enviada ao cidadão
          </p>
        ) : state.enabled ? null : (
          <div className={styles.blocked} id="composer-hint" role="note">
            <strong>Resposta indisponível.</strong>
            <ul>
              {state.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        {isNote && !canNote ? (
          <p className={styles.blocked}>
            Você não tem permissão para registrar notas nesta conversa.
          </p>
        ) : null}
        <label className="sr-only" htmlFor="composer-text">
          {isNote ? 'Texto da nota interna' : 'Resposta ao cidadão'}
        </label>
        <textarea
          id="composer-text"
          value={text}
          maxLength={limit}
          disabled={disabled || busy}
          aria-describedby={!isNote && state.enabled ? 'composer-window' : 'composer-hint'}
          placeholder={
            isNote
              ? 'Registre uma observação para a equipe (o cidadão não vê).'
              : state.enabled
                ? 'Escreva a resposta. Somente texto; templates não podem ser enviados daqui.'
                : 'Resposta bloqueada.'
          }
          onChange={(event) => (isNote ? setNote : setReply)(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
      </div>
      <div className={styles.composerFooter}>
        <span id="composer-window">
          {isNote
            ? `${text.length}/${limit}`
            : state.windowExpiresAt
              ? `Janela de resposta até ${formatDateTime(state.windowExpiresAt)} (${formatRemaining(
                  state.remainingMs ?? 0,
                )}) · ${text.length}/${limit}`
              : 'Sem janela de resposta aberta.'}
        </span>
        <button type="submit" className="button small" disabled={disabled || busy || !text.trim()}>
          <Icon name={isNote ? 'file' : 'send'} width={16} height={16} />
          {busy ? 'Enviando…' : isNote ? 'Salvar nota' : 'Enviar resposta'}
        </button>
      </div>
    </form>
  );
}
