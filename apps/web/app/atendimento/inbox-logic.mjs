// Lógica pura da tela /atendimento. Fica em .mjs (com tipos em inbox-logic.d.mts) para que
// `node --test` rode os testes em Node 22 sem build nem flags; os componentes TSX importam daqui.
// Não há regra de produto reimplementada aqui: a permissão de resposta vem sempre de
// `replyPolicy` calculada no servidor por `evaluateHumanReplyPolicy` (@confirma/domain).
// A UI só pode FECHAR o gate (ex.: janela vencida no relógio local), nunca abri-lo.

/** Réplica de HUMAN_REPLY_BLOCK_LABELS (@confirma/domain), que não é dependência do web. */
export const HUMAN_REPLY_BLOCK_LABELS = Object.freeze({
  NO_ELIGIBLE_INBOUND:
    'O contato ainda não respondeu a um template de campanha. O atendimento humano não pode iniciar conversa.',
  WINDOW_EXPIRED:
    'A janela de 24 horas desde a última resposta elegível expirou. Envio humano bloqueado.',
  CONTACT_OPTED_OUT: 'O contato pediu para não receber mensagens.',
  CONTACT_BLOCKED: 'O contato está bloqueado.',
  CONVERSATION_RESOLVED: 'A conversa está resolvida.',
  NOT_ASSIGNEE: 'Somente o responsável atribuído pode responder.',
});

/** Limites de tamanho de @confirma/domain (réplica; o servidor valida). */
export const MAX_HUMAN_TEXT_LENGTH = 4_096;
export const MAX_NOTE_LENGTH = 4_000;

const UNKNOWN_BLOCK_LABEL = 'Envio bloqueado pela regra de atendimento.';

export const INBOUND_INELIGIBILITY_LABELS = Object.freeze({
  NO_CONTEXT: 'Mensagem espontânea: não é resposta a um template de campanha.',
  CONTEXT_NOT_FOUND: 'Responde a uma mensagem que não foi encontrada no sistema.',
  CONTEXT_NOT_CAMPAIGN_TEMPLATE: 'Responde a uma mensagem que não é template de campanha.',
  RECIPIENT_MISMATCH: 'O template referenciado foi enviado a outro número.',
  SENDER_MISMATCH: 'O template referenciado foi enviado por outro número da instituição.',
  TEMPLATE_NOT_SUBMITTED: 'O template referenciado ainda não havia sido enviado.',
});

export const CONVERSATION_STATUS_LABELS = Object.freeze({
  OPEN: 'Aberta',
  WAITING_CONTACT: 'Aguardando cidadão',
  SNOOZED: 'Adiada',
  RESOLVED: 'Resolvida',
});

export const PRIORITY_OPTIONS = Object.freeze([
  { value: 0, label: 'Normal' },
  { value: 1, label: 'Alta' },
  { value: 2, label: 'Muito alta' },
  { value: 3, label: 'Urgente' },
]);

export const INBOX_VIEWS = Object.freeze([
  { value: 'unassigned', label: 'Não atribuídas' },
  { value: 'mine', label: 'Minhas' },
  { value: 'team', label: 'Equipe' },
  { value: 'waiting_contact', label: 'Aguardando cidadão' },
  { value: 'snoozed', label: 'Adiadas' },
  { value: 'resolved', label: 'Resolvidas' },
  { value: 'all', label: 'Todas' },
]);

/** Estado de mensagem → rótulo, tom visual e explicação (para leitores de tela e tooltip). */
const MESSAGE_STATUS = Object.freeze({
  RECEIVED: { label: 'Recebida', tone: 'info', description: 'Mensagem recebida do cidadão.' },
  QUEUED: { label: 'Na fila', tone: 'info', description: 'Aguardando envio.' },
  PROCESSING: { label: 'Enviando', tone: 'info', description: 'Envio em andamento.' },
  SUBMITTED: { label: 'Aceita pela Meta', tone: 'info', description: 'A Meta aceitou o envio.' },
  SENT: { label: 'Enviada', tone: 'success', description: 'Mensagem enviada ao cidadão.' },
  DELIVERED: { label: 'Entregue', tone: 'success', description: 'Mensagem entregue no aparelho.' },
  READ: { label: 'Lida', tone: 'success', description: 'O cidadão leu a mensagem.' },
  FAILED: { label: 'Falha no envio', tone: 'danger', description: 'A mensagem não foi enviada.' },
  UNKNOWN: {
    label: 'Envio não confirmado',
    tone: 'warning',
    description: 'Envio não confirmado, aguardando reconciliação.',
  },
  BLOCKED: {
    label: 'Bloqueada',
    tone: 'danger',
    description: 'Envio bloqueado pela regra de atendimento; nada foi enviado.',
  },
});

/**
 * @param {string} status
 * @returns {{ label: string, tone: 'info'|'success'|'warning'|'danger', description: string }}
 */
export function messageStatusInfo(status) {
  return (
    MESSAGE_STATUS[/** @type {keyof typeof MESSAGE_STATUS} */ (status)] ?? {
      label: 'Situação não identificada',
      tone: 'info',
      description: 'Situação não identificada.',
    }
  );
}

export const ACTIVITY_LABELS = Object.freeze({
  CONVERSATION_OPENED: 'Conversa aberta',
  CONVERSATION_REOPENED: 'Conversa reaberta',
  ASSIGNED: 'Conversa atribuída',
  UNASSIGNED: 'Atribuição removida',
  TRANSFERRED: 'Conversa transferida',
  STATUS_CHANGED: 'Estado alterado',
  PRIORITY_CHANGED: 'Prioridade alterada',
  CONTEXT_LINKED: 'Convocação vinculada',
  CONTEXT_UNLINKED: 'Convocação desvinculada',
  AUTOMATION_PAUSED: 'Automação de convocações pausada',
  AUTOMATION_RESUMED: 'Automação de convocações retomada',
  HUMAN_SEND_BLOCKED: 'Envio humano bloqueado pela regra de atendimento',
  HUMAN_SEND_UNKNOWN: 'Envio humano não confirmado, aguardando reconciliação',
  CONTACT_OPTED_OUT: 'Contato marcado como "não receber mensagens"',
  CONTACT_OPTED_IN: 'Contato voltou a aceitar mensagens',
  NOTE_ADDED: 'Nota interna adicionada',
});

/** @param {string} type */
export function activityLabel(type) {
  return (
    ACTIVITY_LABELS[/** @type {keyof typeof ACTIVITY_LABELS} */ (type)] ?? 'Atividade registrada'
  );
}

/** @param {string} status */
export function conversationStatusLabel(status) {
  return (
    CONVERSATION_STATUS_LABELS[/** @type {keyof typeof CONVERSATION_STATUS_LABELS} */ (status)] ??
    'Situação não identificada'
  );
}

/** @param {number} priority */
export function priorityLabel(priority) {
  return PRIORITY_OPTIONS.find((option) => option.value === priority)?.label ?? `Nível ${priority}`;
}

/** @param {string} reason */
export function blockReasonLabel(reason) {
  return (
    HUMAN_REPLY_BLOCK_LABELS[/** @type {keyof typeof HUMAN_REPLY_BLOCK_LABELS} */ (reason)] ??
    UNKNOWN_BLOCK_LABEL
  );
}

/** @param {string | null | undefined} reason */
export function ineligibilityLabel(reason) {
  if (!reason) return 'Esta mensagem não abre janela de resposta humana.';
  return (
    INBOUND_INELIGIBILITY_LABELS[
      /** @type {keyof typeof INBOUND_INELIGIBILITY_LABELS} */ (reason)
    ] ?? 'Esta mensagem não abre janela de resposta humana.'
  );
}

/** @param {number} ms */
export function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'expirada';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return minutes === 0 ? 'menos de 1 min' : `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/**
 * Decide se o composer de resposta fica habilitado a partir da `replyPolicy` do servidor.
 * Só restringe: se o servidor disse não, é não. Se disse sim mas a janela já venceu no
 * relógio local (ou não há janela), também fecha.
 * @param {{ allowed: boolean, reasons: string[], windowExpiresAt: string | null } | null | undefined} policy
 * @param {number} [now]
 */
export function composerState(policy, now = Date.now()) {
  if (!policy) {
    return {
      enabled: false,
      reasons: ['Carregando a política de resposta…'],
      windowExpiresAt: null,
      remainingMs: null,
    };
  }
  const expiresAt = policy.windowExpiresAt ? Date.parse(policy.windowExpiresAt) : NaN;
  const hasWindow = Number.isFinite(expiresAt);
  const remainingMs = hasWindow ? expiresAt - now : null;
  /** @type {string[]} */
  const codes = [...(policy.reasons ?? [])];
  if (policy.allowed) {
    if (!hasWindow) codes.push('NO_ELIGIBLE_INBOUND');
    else if (/** @type {number} */ (remainingMs) <= 0) codes.push('WINDOW_EXPIRED');
  } else if (codes.length === 0) {
    codes.push('UNKNOWN');
  }
  const enabled = policy.allowed && codes.length === 0;
  return {
    enabled,
    reasons: [...new Set(codes)].map(blockReasonLabel),
    windowExpiresAt: hasWindow ? new Date(expiresAt).toISOString() : null,
    remainingMs,
  };
}

const PROTOCOL_QUERY = /^ATD-[0-9-]*$/i;
const MIN_SEARCH_DIGITS = 4;
const MAX_SEARCH_LENGTH = 40;

/**
 * Normaliza a busca: protocolo (ATD-...) em maiúsculas ou só os dígitos do WhatsApp.
 * @param {string | null | undefined} raw
 */
export function normalizeSearch(raw) {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (PROTOCOL_QUERY.test(value)) return value.toUpperCase().slice(0, MAX_SEARCH_LENGTH);
  const digits = value.replace(/\D/g, '');
  // A API exige ao menos 4 dígitos do WhatsApp (400 caso contrário).
  return digits.length >= MIN_SEARCH_DIGITS ? digits.slice(0, MAX_SEARCH_LENGTH) : '';
}

/**
 * Busca digitada que não vira filtro válido (ex.: nome ou menos de 4 dígitos).
 * @param {string | null | undefined} raw
 */
export function isSearchInvalid(raw) {
  return Boolean((raw ?? '').trim()) && normalizeSearch(raw) === '';
}

/**
 * Monta a querystring de GET /inbox/conversations. Nunca lista sem limite (máx. 50).
 * @param {{ view?: string, q?: string, teamId?: string, assigneeId?: string, status?: string,
 *   priority?: number | string | null, from?: string, to?: string, cursor?: string | null, limit?: number }} filters
 */
export function buildConversationQuery(filters) {
  const params = new URLSearchParams();
  const view =
    filters.view && INBOX_VIEWS.some((v) => v.value === filters.view) ? filters.view : 'unassigned';
  params.set('view', view);
  const q = normalizeSearch(filters.q);
  if (q) params.set('q', q);
  for (const key of /** @type {const} */ (['teamId', 'assigneeId', 'status', 'from', 'to'])) {
    const value = filters[key];
    if (typeof value === 'string' && value.trim()) params.set(key, value.trim());
  }
  if (filters.priority !== undefined && filters.priority !== null && filters.priority !== '') {
    const priority = Number(filters.priority);
    if (Number.isInteger(priority)) params.set('priority', String(priority));
  }
  if (filters.cursor) params.set('cursor', filters.cursor);
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 25), 1), 50);
  params.set('limit', String(limit));
  return params.toString();
}

/** @param {{ kind: string, id: string }} item */
export function timelineKey(item) {
  return `${item.kind}:${item.id}`;
}

/**
 * Junta páginas da timeline sem duplicar (kind+id); a versão mais nova do item vence
 * (ex.: atualização de estado). Resultado em ordem cronológica crescente para exibição.
 * @template {{ kind: string, id: string, createdAt: string }} T
 * @param {T[]} existing
 * @param {T[]} incoming
 * @returns {T[]}
 */
export function mergeTimeline(existing, incoming) {
  const byKey = new Map();
  for (const item of existing) byKey.set(timelineKey(item), item);
  for (const item of incoming) byKey.set(timelineKey(item), item);
  return [...byKey.values()].sort((a, b) => {
    const diff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (diff !== 0 && Number.isFinite(diff)) return diff;
    const ka = timelineKey(a);
    const kb = timelineKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Acrescenta uma página seguinte da lista (carregar mais) sem duplicar.
 * @template {{ id: string }} T
 * @param {T[]} existing
 * @param {T[]} page
 * @returns {T[]}
 */
export function appendConversationPage(existing, page) {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...page.filter((item) => !seen.has(item.id))];
}

/**
 * Atualiza o topo da lista com a primeira página recém-buscada (após evento SSE/polling).
 * - itens da página nova vêm primeiro, na ordem do servidor;
 * - itens antigos fora da página nova são mantidos, salvo se foram afetados pelo evento
 *   (se ainda atendessem ao filtro teriam subido para o topo) ou se a página nova é a última.
 * @template {{ id: string }} T
 * @param {T[]} existing
 * @param {{ items: T[], nextCursor: string | null }} head
 * @param {Iterable<string>} [affectedIds]
 * @returns {T[]}
 */
export function mergeListHead(existing, head, affectedIds = []) {
  if (!head.nextCursor) return [...head.items];
  const fresh = new Set(head.items.map((item) => item.id));
  const affected = new Set(affectedIds);
  return [
    ...head.items,
    ...existing.filter((item) => !fresh.has(item.id) && !affected.has(item.id)),
  ];
}

/** @param {string | number | null | undefined} id */
function eventOrdinal(id) {
  if (id === null || id === undefined || id === '') return null;
  try {
    return BigInt(String(id));
  } catch {
    return null;
  }
}

/** @returns {import('./inbox-logic.d.mts').InboxStreamState} */
export function initialStreamState() {
  return {
    lastEventId: null,
    refreshList: false,
    affectedConversationIds: [],
    refreshSelected: false,
    refreshSelectedTimeline: false,
    announcement: null,
  };
}

/**
 * Reducer de eventos SSE ({ id, type, conversationId, entityId }). Não guarda conteúdo:
 * só decide o que precisa ser rebuscado por HTTP. Eventos repetidos/antigos (id <= último)
 * são ignorados — o EventSource reenvia a partir de Last-Event-ID após reconexão.
 * @param {import('./inbox-logic.d.mts').InboxStreamState} state
 * @param {{ id?: string | number | null, type: string, conversationId: string, entityId?: string | null }} event
 * @param {string | null} selectedConversationId
 * @returns {import('./inbox-logic.d.mts').InboxStreamState}
 */
export function reduceInboxEvent(state, event, selectedConversationId) {
  if (!event || typeof event.type !== 'string' || typeof event.conversationId !== 'string')
    return state;
  // A API revisita commits atrasados (ids abaixo do cursor ainda não enviados), então um id
  // menor que o último NÃO é descartado: só o cursor guarda o maior id visto.
  const incoming = eventOrdinal(event.id);
  const last = eventOrdinal(state.lastEventId);
  const lastEventId =
    incoming !== null && (last === null || incoming > last) ? String(incoming) : state.lastEventId;
  const selected = event.conversationId === selectedConversationId;
  const timelineEvent = [
    'message.created',
    'message.updated',
    'note.created',
    'activity.created',
  ].includes(event.type);
  const affected = state.affectedConversationIds.includes(event.conversationId)
    ? state.affectedConversationIds
    : [...state.affectedConversationIds, event.conversationId];
  let announcement = state.announcement;
  if (selected && event.type === 'message.created')
    announcement = 'Nova mensagem na conversa aberta.';
  else if (!selected && event.type === 'conversation.created')
    announcement = 'Nova conversa na fila.';
  return {
    lastEventId,
    refreshList: state.refreshList || event.type !== 'note.created',
    affectedConversationIds: affected,
    refreshSelected: state.refreshSelected || selected,
    refreshSelectedTimeline: state.refreshSelectedTimeline || (selected && timelineEvent),
    announcement,
  };
}

/**
 * Limpa as pendências após o refetch, preservando o cursor do stream.
 * @param {import('./inbox-logic.d.mts').InboxStreamState} state
 */
export function clearStreamPending(state) {
  return { ...initialStreamState(), lastEventId: state.lastEventId };
}

/**
 * Lê o `data` de um MessageEvent do SSE. Retorna null se inválido.
 * @param {string} data
 * @param {string} [lastEventId]
 */
export function parseInboxEvent(data, lastEventId) {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed.type !== 'string' || typeof parsed.conversationId !== 'string')
      return null;
    return {
      id: parsed.id !== undefined && parsed.id !== null ? String(parsed.id) : lastEventId || null,
      type: parsed.type,
      conversationId: parsed.conversationId,
      entityId: typeof parsed.entityId === 'string' ? parsed.entityId : null,
    };
  } catch {
    return null;
  }
}

/**
 * URL do stream. Reconexões manuais passam o último id como ?cursor=; a reconexão
 * automática do EventSource já manda Last-Event-ID.
 * @param {string} apiBase
 * @param {string | null} cursor
 */
export function streamUrl(apiBase, cursor) {
  const base = `${apiBase.replace(/\/$/, '')}/inbox/stream`;
  return cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
}

/**
 * Chave de idempotência do envio: reaproveitada ao repetir o MESMO texto após falha
 * transitória (rede/5xx); nova para um texto diferente.
 * @param {{ body: string, idempotencyKey: string } | null} pending
 * @param {string} body
 * @param {() => string} newKey
 */
export function prepareSend(pending, body, newKey) {
  const text = body.trim();
  if (pending && pending.body === text) return pending;
  return { body: text, idempotencyKey: newKey() };
}

/**
 * Depois do envio: mantém a chave só quando o resultado é incerto (rede, 5xx), para que
 * o retry seja deduplicado no servidor. Aceito (2xx) ou recusado (4xx) descarta.
 * @param {{ body: string, idempotencyKey: string }} attempt
 * @param {number | null} httpStatus null = erro de rede
 */
export function pendingAfterSend(attempt, httpStatus) {
  if (httpStatus === null || httpStatus >= 500) return attempt;
  return null;
}

/**
 * Permissões de exibição (espelho do RBAC de @confirma/domain/canPerform). O servidor é a
 * autoridade; aqui só se decide o que mostrar/habilitar.
 * @param {{ userId: string, globalRole: string, teams: { id: string, role: string }[] } | null} me
 * @param {{ teamId: string | null, assigneeId: string | null }} target
 */
export function uiPermissions(me, target) {
  if (!me) {
    return {
      claim: false,
      assign: false,
      transfer: false,
      changeStatus: false,
      reopen: false,
      priority: false,
      note: false,
      linkContext: false,
      resumeAutomation: false,
      optOut: false,
    };
  }
  const admin = me.globalRole === 'ADMIN';
  const teamRole = target.teamId
    ? me.teams.find((team) => team.id === target.teamId)?.role
    : undefined;
  const supervisor = admin || teamRole === 'SUPERVISOR';
  const member = admin || teamRole !== undefined;
  const own = target.assigneeId !== null && target.assigneeId === me.userId;
  return {
    claim: member && target.assigneeId === null,
    assign: supervisor,
    transfer: supervisor || (member && own),
    changeStatus: supervisor || (member && own),
    reopen: supervisor,
    priority: supervisor || (member && own),
    note: member,
    linkContext: supervisor || (member && own),
    resumeAutomation: supervisor,
    optOut: supervisor,
  };
}

/**
 * Rótulo de uma referência a template de campanha. Nome do paciente só aparece quando a
 * convocação está explicitamente vinculada à conversa.
 * @param {{ stage?: string | null, attemptNumber?: number | null, convocationId?: string | null, patientName?: string | null } | null | undefined} campaign
 * @param {Iterable<string>} linkedConvocationIds
 */
export function campaignRefLabel(campaign, linkedConvocationIds) {
  const stages = { FIRST: '1ª convocação', SECOND: '2ª convocação', THIRD: '3ª convocação' };
  const stage = campaign?.stage
    ? stages[/** @type {keyof typeof stages} */ (campaign.stage)]
    : undefined;
  const title = `Template de campanha${stage ? ` — ${stage}` : ''}`;
  const linked = new Set(linkedConvocationIds);
  const patient =
    campaign?.convocationId && linked.has(campaign.convocationId) && campaign.patientName
      ? campaign.patientName
      : null;
  return { title, patient, linked: Boolean(patient) };
}

/**
 * Detalhe legível de uma atividade a partir do `metadata` gravado pela API (sem conteúdo).
 * @param {string} type
 * @param {unknown} metadata
 */
export function activityDetail(type, metadata) {
  const meta =
    metadata && typeof metadata === 'object'
      ? /** @type {Record<string, unknown>} */ (metadata)
      : {};
  if (
    (type === 'STATUS_CHANGED' || type === 'CONVERSATION_REOPENED') &&
    typeof meta.to === 'string'
  ) {
    const from = typeof meta.from === 'string' ? `${conversationStatusLabel(meta.from)} → ` : '';
    return `${from}${conversationStatusLabel(meta.to)}`;
  }
  if (type === 'PRIORITY_CHANGED' && typeof meta.to === 'number') {
    const from = typeof meta.from === 'number' ? `${priorityLabel(meta.from)} → ` : '';
    return `${from}${priorityLabel(meta.to)}`;
  }
  if (type === 'HUMAN_SEND_BLOCKED' && Array.isArray(meta.reasons)) {
    return meta.reasons
      .filter((reason) => typeof reason === 'string')
      .map(blockReasonLabel)
      .join(' ');
  }
  return '';
}

/**
 * A resposta 202 de POST /messages traz a linha crua (`kind` = HUMAN_TEXT, sem `kind: 'message'`).
 * Converte para o formato de item da timeline.
 * @param {{ id: string, kind: string, createdAt: string } & Record<string, unknown>} message
 */
export function timelineItemFromSent(message) {
  const { kind, ...rest } = message;
  return { ...rest, kind: 'message', messageKind: kind };
}
