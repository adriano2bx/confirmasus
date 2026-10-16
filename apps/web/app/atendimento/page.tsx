'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '../components/navigation';
import { Feedback, Icon, LoadingState } from '../components/ui';
import {
  InboxApiError,
  blockedReasons,
  conflictSummary,
  inboxApi,
  type ConversationDetail,
  type ConversationSummary,
  type InboxMe,
  type TimelineItem,
} from '../lib/inbox-api';
import { PRIORITY_OPTIONS, blockReasonLabel, conversationStatusLabel } from '../lib/inbox-labels';
import { ActionDialog, type DialogHandlers, type DialogState } from './action-dialogs';
import { ContextPanel } from './context-panel';
import { ConversationList, type ListFilters } from './conversation-list';
import { ConversationTimeline } from './conversation-timeline';
import {
  appendConversationPage,
  buildConversationQuery,
  clearStreamPending,
  initialStreamState,
  mergeListHead,
  mergeTimeline,
  pendingAfterSend,
  prepareSend,
  reduceInboxEvent,
  timelineItemFromSent,
  uiPermissions,
  type InboxStreamEvent,
  type SendAttempt,
} from './inbox-logic.mjs';
import { useInboxStream } from './use-inbox-stream';
import styles from './atendimento.module.css';

type Step = 'list' | 'timeline' | 'context';
type Notice = { tone: 'success' | 'error' | 'notice'; text: string } | null;

const PAGE_SIZE = 25;
const CONFLICT_TEXT =
  'A conversa foi alterada por outra pessoa. O estado foi recarregado; revise e tente novamente.';

export default function AtendimentoPage() {
  const [me, setMe] = useState<InboxMe | null>(null);
  const [accessError, setAccessError] = useState('');
  const [filters, setFilters] = useState<ListFilters>({
    view: 'unassigned',
    q: '',
    teamId: '',
    priority: '',
  });
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [step, setStep] = useState<Step>('list');
  const [notice, setNotice] = useState<Notice>(null);
  const [announcement, setAnnouncement] = useState('');
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const listRef = useRef(list);
  listRef.current = list;
  const streamState = useRef(initialStreamState());
  const flushTimer = useRef<number | undefined>(undefined);
  const pendingSend = useRef<SendAttempt | null>(null);

  // Relógio para a janela de resposta (só fecha o composer; nunca abre).
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    inboxApi
      .me()
      .then((value) => {
        // /me não exige equipe; a listagem responderia 403. Avisa antes de tentar.
        if (value.globalRole !== 'ADMIN' && value.teams.length === 0) {
          setAccessError('Você não participa de nenhuma equipe de atendimento.');
          return;
        }
        setMe(value);
      })
      .catch((cause) =>
        setAccessError(
          cause instanceof InboxApiError && cause.status === 403
            ? 'Você não participa de nenhuma equipe de atendimento.'
            : 'Não foi possível carregar seu acesso ao atendimento.',
        ),
      );
  }, []);

  const showError = useCallback((cause: unknown, fallback: string) => {
    setNotice({
      tone: 'error',
      text: cause instanceof Error && cause.message ? cause.message : fallback,
    });
  }, []);

  const loadList = useCallback(
    async (cursor: string | null) => {
      setListLoading(true);
      try {
        const page = await inboxApi.conversations(
          buildConversationQuery({ ...filtersRef.current, cursor, limit: PAGE_SIZE }),
        );
        setList((current) => (cursor ? appendConversationPage(current, page.items) : page.items));
        setListCursor(page.nextCursor);
      } catch (cause) {
        showError(cause, 'Não foi possível carregar as conversas.');
      } finally {
        setListLoading(false);
      }
    },
    [showError],
  );

  const refreshListHead = useCallback(async (affected: string[]) => {
    try {
      const head = await inboxApi.conversations(
        buildConversationQuery({ ...filtersRef.current, limit: PAGE_SIZE }),
      );
      setList((current) => mergeListHead(current, head, affected));
      // Mantém o cursor de "carregar mais" se a lista já tinha passado da primeira página.
      setListCursor((cursor) =>
        listRef.current.length > head.items.length ? cursor : head.nextCursor,
      );
    } catch {
      // Silencioso: o próximo evento/polling tenta de novo.
    }
  }, []);

  const applySummary = useCallback((summary: ConversationSummary) => {
    setList((current) =>
      current.map((item) => (item.id === summary.id ? { ...item, ...summary } : item)),
    );
    setDetail((current) =>
      current && current.id === summary.id ? { ...current, ...summary } : current,
    );
  }, []);

  const markRead = useCallback((id: string, items: TimelineItem[]) => {
    const lastMessage = mergeTimeline([], items)
      .reverse()
      .find((item) => item.kind === 'message');
    inboxApi.markRead(id, lastMessage?.id).catch(() => undefined);
    setList((current) =>
      current.map((item) => (item.id === id ? { ...item, unreadCount: 0 } : item)),
    );
  }, []);

  const refreshSelected = useCallback(
    async (withTimeline: boolean) => {
      const id = selectedRef.current;
      if (!id) return;
      try {
        const [nextDetail, page] = await Promise.all([
          inboxApi.conversation(id),
          withTimeline ? inboxApi.timeline(id, null) : Promise.resolve(null),
        ]);
        if (selectedRef.current !== id) return;
        setDetail(nextDetail);
        applySummary(nextDetail);
        if (page) {
          setTimeline((current) => mergeTimeline(current, page.items));
          markRead(id, page.items);
        }
      } catch (cause) {
        if (cause instanceof InboxApiError && (cause.status === 403 || cause.status === 404)) {
          setNotice({ tone: 'notice', text: 'Esta conversa não está mais disponível para você.' });
          setSelectedId(null);
          setDetail(null);
          setStep('list');
        }
      }
    },
    [applySummary, markRead],
  );

  const openConversation = useCallback(
    async (id: string) => {
      setSelectedId(id);
      selectedRef.current = id;
      setStep('timeline');
      setDetailLoading(true);
      setTimeline([]);
      setOlderCursor(null);
      pendingSend.current = null;
      try {
        const [nextDetail, page] = await Promise.all([
          inboxApi.conversation(id),
          inboxApi.timeline(id, null),
        ]);
        if (selectedRef.current !== id) return;
        setDetail(nextDetail);
        const merged = mergeTimeline([], page.items);
        setTimeline(merged);
        setOlderCursor(page.nextCursor);
        markRead(id, merged);
      } catch (cause) {
        setDetail(null);
        showError(cause, 'Não foi possível abrir a conversa.');
      } finally {
        setDetailLoading(false);
      }
    },
    [markRead, showError],
  );

  async function loadOlder() {
    const id = selectedRef.current;
    if (!id || !olderCursor) return;
    setLoadingOlder(true);
    try {
      const page = await inboxApi.timeline(id, olderCursor);
      if (selectedRef.current !== id) return;
      setTimeline((current) => mergeTimeline(current, page.items));
      setOlderCursor(page.nextCursor);
    } catch (cause) {
      showError(cause, 'Não foi possível carregar mensagens anteriores.');
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    if (!me) return;
    void loadList(null);
  }, [me, filters, loadList]);

  const flushStream = useCallback(() => {
    flushTimer.current = undefined;
    const state = streamState.current;
    streamState.current = clearStreamPending(state);
    if (state.announcement) setAnnouncement(state.announcement);
    if (state.refreshList) void refreshListHead(state.affectedConversationIds);
    if (state.refreshSelected) void refreshSelected(state.refreshSelectedTimeline);
  }, [refreshListHead, refreshSelected]);

  const onStreamEvent = useCallback(
    (event: InboxStreamEvent) => {
      streamState.current = reduceInboxEvent(streamState.current, event, selectedRef.current);
      // Agrupa rajadas de eventos num único refetch.
      if (flushTimer.current === undefined)
        flushTimer.current = window.setTimeout(flushStream, 700);
    },
    [flushStream],
  );

  const onResync = useCallback(() => {
    void refreshListHead([]);
    void refreshSelected(true);
  }, [refreshListHead, refreshSelected]);

  const streamStatus = useInboxStream({ onEvent: onStreamEvent, onResync });

  /** Executa ação versionada; em 409 aplica o estado atual do servidor e avisa. */
  const runAction = useCallback(
    async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
      setNotice(null);
      try {
        const result = await action();
        if (result && typeof result === 'object') {
          // Ações versionadas devolvem o summary; a retomada devolve { conversation }.
          if ('protocol' in result) applySummary(result as ConversationSummary);
          else if ('conversation' in result && result.conversation) {
            applySummary(result.conversation as ConversationSummary);
          }
        }
        await refreshSelected(true);
        void refreshListHead(selectedRef.current ? [selectedRef.current] : []);
        setNotice({ tone: 'success', text: success });
        return true;
      } catch (cause) {
        const conflict = conflictSummary(cause);
        if (conflict || (cause instanceof InboxApiError && cause.code === 'VERSION_CONFLICT')) {
          if (conflict) applySummary(conflict);
          await refreshSelected(true);
          setNotice({ tone: 'notice', text: CONFLICT_TEXT });
          return true;
        }
        showError(cause, 'Não foi possível concluir a ação.');
        return false;
      }
    },
    [applySummary, refreshListHead, refreshSelected, showError],
  );

  async function sendReply(text: string): Promise<boolean> {
    const id = selectedRef.current;
    if (!id) return false;
    const attempt = prepareSend(pendingSend.current, text, () => crypto.randomUUID());
    pendingSend.current = attempt;
    setNotice(null);
    try {
      const result = await inboxApi.sendMessage(id, attempt.body, attempt.idempotencyKey);
      pendingSend.current = pendingAfterSend(attempt, 202);
      if (result?.message) {
        const item = timelineItemFromSent(result.message) as TimelineItem;
        setTimeline((current) => mergeTimeline(current, [item]));
      }
      setAnnouncement('Resposta enfileirada para envio.');
      void refreshSelected(true);
      return true;
    } catch (cause) {
      const status = cause instanceof InboxApiError ? cause.status : null;
      pendingSend.current = pendingAfterSend(attempt, status);
      const reasons = blockedReasons(cause);
      if (reasons) {
        await refreshSelected(false);
        setNotice({
          tone: 'error',
          text: `Envio bloqueado: ${reasons.length ? reasons.map(blockReasonLabel).join(' ') : 'regra de atendimento.'}`,
        });
      } else if (cause instanceof InboxApiError && cause.code === 'VERSION_CONFLICT') {
        await refreshSelected(true);
        setNotice({ tone: 'notice', text: CONFLICT_TEXT });
      } else if (pendingSend.current) {
        setNotice({
          tone: 'error',
          text: `${cause instanceof Error ? cause.message : 'Falha no envio.'} Ao tentar de novo com o mesmo texto, a mensagem não será duplicada.`,
        });
      } else {
        showError(cause, 'Não foi possível enviar a resposta.');
      }
      return false;
    }
  }

  async function addNote(text: string): Promise<boolean> {
    const id = selectedRef.current;
    if (!id) return false;
    setNotice(null);
    try {
      const result = await inboxApi.addNote(id, text);
      if (result?.note)
        setTimeline((current) => mergeTimeline(current, [{ ...result.note, kind: 'note' }]));
      setAnnouncement('Nota interna registrada.');
      return true;
    } catch (cause) {
      showError(cause, 'Não foi possível salvar a nota.');
      return false;
    }
  }

  const permissions = uiPermissions(me, {
    teamId: detail?.team?.id ?? null,
    assigneeId: detail?.assignee?.id ?? null,
  });

  const handlers: DialogHandlers | null = detail
    ? {
        assign: (assigneeId) =>
          runAction(
            () => inboxApi.assign(detail.id, detail.version, assigneeId),
            'Conversa atribuída.',
          ),
        transfer: (body) =>
          runAction(
            () => inboxApi.transfer(detail.id, { version: detail.version, ...body }),
            'Conversa transferida.',
          ),
        status: (body) =>
          runAction(
            () => inboxApi.setStatus(detail.id, { version: detail.version, ...body }),
            `Estado alterado para "${conversationStatusLabel(body.status)}".`,
          ),
        link: (convocationId) =>
          runAction(() => inboxApi.linkContext(detail.id, convocationId), 'Convocação vinculada.'),
        unlink: (convocationId) =>
          runAction(
            () => inboxApi.unlinkContext(detail.id, convocationId),
            'Convocação desvinculada.',
          ),
        optOut: (optedOut, reason) =>
          runAction(
            () => inboxApi.setOptOut(detail.contact.id, optedOut, reason),
            optedOut ? 'Opt-out registrado.' : 'Opt-out removido.',
          ),
        resume: (convocationIds, version) =>
          runAction(
            () => inboxApi.resumeAutomation(detail.id, version, convocationIds),
            'Automação retomada para as convocações selecionadas.',
          ),
      }
    : null;

  if (accessError) {
    return (
      <AppShell title="Atendimento" eyebrow="Operação">
        <Feedback tone="error">{accessError}</Feedback>
      </AppShell>
    );
  }

  return (
    <AppShell title="Atendimento" eyebrow="Operação">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {notice ? (
        <div style={{ marginBottom: 12 }}>
          <Feedback tone={notice.tone}>{notice.text}</Feedback>
        </div>
      ) : null}
      <div className={styles.inbox} data-step={step}>
        <section className={`${styles.pane} ${styles.listPane}`} aria-label="Filas e conversas">
          <ConversationList
            me={me}
            filters={filters}
            onFilters={(next) => {
              setFilters(next);
              setList([]);
              setListCursor(null);
            }}
            items={list}
            loading={listLoading}
            hasMore={Boolean(listCursor)}
            onLoadMore={() => void loadList(listCursor)}
            selectedId={selectedId}
            onSelect={(id) => void openConversation(id)}
            streamStatus={streamStatus}
          />
        </section>

        <section className={`${styles.pane} ${styles.timelinePane}`} aria-label="Conversa">
          {detail ? (
            <>
              <header className={styles.convHeader}>
                <div className={styles.convTitle}>
                  <button
                    type="button"
                    className={`icon-button ${styles.back}`}
                    aria-label="Voltar para a lista"
                    onClick={() => setStep('list')}
                  >
                    <Icon name="chevron" style={{ transform: 'rotate(180deg)' }} />
                  </button>
                  <h2>{detail.protocol}</h2>
                  <span className={styles.chip} data-tone="neutral">
                    {conversationStatusLabel(detail.status)}
                  </span>
                  <span className="muted">{detail.contact.waIdMasked}</span>
                  <button
                    type="button"
                    className={`button ghost small ${styles.back}`}
                    onClick={() => setStep('context')}
                  >
                    Contexto
                  </button>
                </div>
                <ConversationActions
                  detail={detail}
                  permissions={permissions}
                  onClaim={() =>
                    void runAction(
                      () => inboxApi.claim(detail.id, detail.version),
                      'Conversa assumida. A automação relacionada foi pausada.',
                    )
                  }
                  onPriority={(priority) =>
                    void runAction(
                      () => inboxApi.setPriority(detail.id, detail.version, priority),
                      'Prioridade alterada.',
                    )
                  }
                  onDialog={setDialog}
                />
              </header>
              <ConversationTimeline
                detail={detail}
                items={timeline}
                hasOlder={Boolean(olderCursor)}
                loadingOlder={loadingOlder}
                onLoadOlder={() => void loadOlder()}
                now={now}
                canNote={permissions.note}
                onSendReply={sendReply}
                onAddNote={addNote}
              />
            </>
          ) : detailLoading ? (
            <LoadingState label="Abrindo conversa…" />
          ) : (
            <p className={styles.empty}>Selecione uma conversa na lista para ver o histórico.</p>
          )}
        </section>

        <section
          className={`${styles.pane} ${styles.contextPane}`}
          aria-label="Contexto do contato"
        >
          <header className={styles.paneHeader}>
            <button
              type="button"
              className={`icon-button ${styles.back}`}
              aria-label="Voltar para a conversa"
              onClick={() => setStep('timeline')}
            >
              <Icon name="chevron" style={{ transform: 'rotate(180deg)' }} />
            </button>
            <h2 className={styles.grow}>Contexto</h2>
          </header>
          {detail ? (
            <ContextPanel
              detail={detail}
              permissions={permissions}
              onLink={(convocation) => setDialog({ kind: 'link', convocation })}
              onUnlink={(convocation) => setDialog({ kind: 'unlink', convocation })}
              onOptOut={(optedOut) => setDialog({ kind: 'optout', optedOut })}
              onAutomation={() => setDialog({ kind: 'automation' })}
            />
          ) : (
            <p className={styles.empty}>Sem conversa selecionada.</p>
          )}
        </section>
      </div>
      {dialog && detail && handlers ? (
        <ActionDialog
          dialog={dialog}
          detail={detail}
          me={me}
          handlers={handlers}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </AppShell>
  );
}

function ConversationActions({
  detail,
  permissions,
  onClaim,
  onPriority,
  onDialog,
}: {
  detail: ConversationDetail;
  permissions: ReturnType<typeof uiPermissions>;
  onClaim: () => void;
  onPriority: (priority: number) => void;
  onDialog: (dialog: DialogState) => void;
}) {
  const resolved = detail.status === 'RESOLVED';
  return (
    <div className={styles.actions} role="toolbar" aria-label="Ações da conversa">
      {permissions.claim && !resolved ? (
        <button type="button" className="button small" onClick={onClaim}>
          Assumir
        </button>
      ) : null}
      {permissions.assign && !resolved ? (
        <button
          type="button"
          className="button secondary small"
          onClick={() => onDialog({ kind: 'assign' })}
        >
          Atribuir…
        </button>
      ) : null}
      {permissions.transfer && !resolved ? (
        <button
          type="button"
          className="button secondary small"
          onClick={() => onDialog({ kind: 'transfer' })}
        >
          Transferir…
        </button>
      ) : null}
      {permissions.changeStatus && !resolved ? (
        <>
          {detail.status !== 'OPEN' ? (
            <button
              type="button"
              className="button ghost small"
              onClick={() => onDialog({ kind: 'status', status: 'OPEN' })}
            >
              Marcar como aberta
            </button>
          ) : null}
          {detail.status !== 'WAITING_CONTACT' ? (
            <button
              type="button"
              className="button ghost small"
              onClick={() => onDialog({ kind: 'status', status: 'WAITING_CONTACT' })}
            >
              Aguardando cidadão
            </button>
          ) : null}
          <button
            type="button"
            className="button ghost small"
            onClick={() => onDialog({ kind: 'status', status: 'SNOOZED' })}
          >
            Adiar…
          </button>
          <button
            type="button"
            className="button ghost small"
            onClick={() => onDialog({ kind: 'status', status: 'RESOLVED' })}
          >
            Resolver
          </button>
        </>
      ) : null}
      {permissions.reopen && resolved ? (
        <button
          type="button"
          className="button secondary small"
          onClick={() => onDialog({ kind: 'status', status: 'OPEN' })}
        >
          Reabrir
        </button>
      ) : null}
      {permissions.priority && !resolved ? (
        <>
          <label className="sr-only" htmlFor="conv-priority">
            Prioridade
          </label>
          <select
            id="conv-priority"
            value={detail.priority}
            onChange={(event) => onPriority(Number(event.target.value))}
          >
            {PRIORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                Prioridade: {option.label}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </div>
  );
}
