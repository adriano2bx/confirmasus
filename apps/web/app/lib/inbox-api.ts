// Cliente da API do atendimento (contrato §7, prefixo /api/inbox). O servidor é a autoridade
// de RBAC e da regra de resposta; aqui só há transporte, tipos e tratamento de erros.
import { authFetch } from './api';

export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';
export const INBOX_API = `${API}/inbox`;

export type ConversationStatus = 'OPEN' | 'WAITING_CONTACT' | 'SNOOZED' | 'RESOLVED';

export interface InboxMe {
  userId: string;
  globalRole: 'ADMIN' | 'OPERATOR';
  teams: { id: string; name: string; role: 'AGENT' | 'SUPERVISOR' }[];
}

export interface ReplyPolicy {
  allowed: boolean;
  reasons: string[];
  windowExpiresAt: string | null;
}

export interface UserRef {
  id: string;
  name: string;
}

export interface ConversationSummary {
  id: string;
  protocol: string;
  status: ConversationStatus;
  priority: number;
  version: number;
  team: { id: string; name: string } | null;
  assignee: UserRef | null;
  contact: { id: string; waIdMasked: string; profileName: string | null; optedOut: boolean };
  phoneNumberId: string;
  lastActivityAt: string;
  lastInboundAt: string | null;
  unreadCount: number;
  automationPaused: boolean;
  replyPolicy: ReplyPolicy;
  snoozedUntil: string | null;
}

/** Convocação em contexts/candidates/automation (mapConvocation de inbox-query.service.ts). */
export interface ConvocationRef {
  convocationId: string;
  status: string;
  stage: string;
  nextActionAt: string | null;
  humanHoldAt: string | null;
  humanHoldConversationId: string | null;
  patient: { id: string; displayName: string };
  campaign: { id: string; name: string };
}

export interface LinkedConvocation extends ConvocationRef {
  source: 'TEMPLATE_REPLY' | 'MANUAL';
  linkedAt: string;
  linkedById: string | null;
}

export interface ConversationDetail extends ConversationSummary {
  contexts: LinkedConvocation[];
  /** Mesmo telefone, NÃO vinculadas: exigem confirmação humana de identidade. */
  candidates: ConvocationRef[];
  ambiguous: boolean;
}

/** Linha de `messages` referenciada por CAMPAIGN_REF (sem dados do paciente). */
export interface CampaignMessageRef {
  id: string;
  templateName: string;
  stage: string;
  attemptNumber: number;
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  convocationId: string;
}

export interface TimelineMedia {
  id: string;
  status: 'PENDING' | 'QUARANTINED' | 'AVAILABLE' | 'REJECTED' | 'EXPIRED';
  declaredMimeType: string | null;
  detectedMimeType: string | null;
  sizeBytes: number | null;
}

export interface TimelineMessage {
  kind: 'message';
  id: string;
  createdAt: string;
  direction: 'INBOUND' | 'OUTBOUND';
  messageKind: 'INBOUND' | 'HUMAN_TEXT' | 'CAMPAIGN_REF';
  status: string;
  contentType: string;
  body: string | null;
  replyEligibility?: 'ELIGIBLE_TEMPLATE_REPLY' | 'NOT_ELIGIBLE' | null;
  eligibilityReason?: string | null;
  providerTimestamp?: string | null;
  sentAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  failedAt?: string | null;
  failureCode?: string | null;
  /** Ausente na resposta 202 do envio (só authorId). */
  author?: UserRef | null;
  authorId?: string | null;
  campaignMessage?: CampaignMessageRef | null;
  media?: TimelineMedia[];
}

export interface TimelineNote {
  kind: 'note';
  id: string;
  createdAt: string;
  body: string;
  author: UserRef;
}

export interface TimelineActivity {
  kind: 'activity';
  id: string;
  createdAt: string;
  type: string;
  actor: UserRef | null;
  reason: string | null;
  metadata: unknown;
  fromTeamId: string | null;
  toTeamId: string | null;
  fromUserId: string | null;
  toUserId: string | null;
}

export type TimelineItem = TimelineMessage | TimelineNote | TimelineActivity;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Resposta 202 de POST /messages: linha crua (kind = HUMAN_TEXT). */
export interface SentHumanMessage {
  id: string;
  conversationId: string;
  direction: 'OUTBOUND';
  kind: 'HUMAN_TEXT';
  status: string;
  contentType: string;
  body: string | null;
  authorId: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface AutomationPreview {
  conversationId: string;
  version: number;
  canResume: boolean;
  paused: (ConvocationRef & { overdue: boolean })[];
}

export interface TeamMemberOption {
  id: string;
  name: string;
  email: string;
  active: boolean;
  role: 'AGENT' | 'SUPERVISOR';
}

/** GET /teams: ADMIN vê todas; demais, só as próprias equipes ativas. */
export interface TeamOption {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  active: boolean;
  members: TeamMemberOption[];
}

/** Erro de API com código do contrato (VERSION_CONFLICT, HUMAN_REPLY_BLOCKED…). */
export class InboxApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await authFetch(`${INBOX_API}${path}`, {
      ...init,
      headers: init.body ? { 'content-type': 'application/json', ...init.headers } : init.headers,
    });
  } catch (cause) {
    throw new InboxApiError(
      cause instanceof Error && cause.message === 'Sessão expirada'
        ? 'Sessão expirada.'
        : 'Falha de conexão com o servidor.',
      null,
      null,
      null,
    );
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof body?.code === 'string' ? body.code : null;
    // class-validator devolve `message` como lista; os erros de domínio, como texto.
    const message =
      typeof body?.message === 'string'
        ? body.message
        : Array.isArray(body?.message) && response.status === 400
          ? 'Dados inválidos para esta ação. Atualize a página e tente novamente.'
          : defaultError(response.status);
    throw new InboxApiError(message, response.status, code, body);
  }
  return body as T;
}

function defaultError(status: number): string {
  if (status === 403) return 'Você não tem permissão para esta ação.';
  if (status === 404) return 'Conversa não encontrada ou sem acesso.';
  if (status === 409) return 'A conversa foi alterada por outra pessoa.';
  if (status >= 500) return 'O servidor não conseguiu concluir a ação. Tente novamente.';
  return 'Não foi possível concluir a ação.';
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const inboxApi = {
  me: () => request<InboxMe>('/me'),
  conversations: (query: string) => request<Page<ConversationSummary>>(`/conversations?${query}`),
  conversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
  timeline: (id: string, cursor: string | null, limit = 30) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return request<Page<TimelineItem>>(`/conversations/${id}/timeline?${params.toString()}`);
  },
  claim: (id: string, version: number) =>
    post<ConversationSummary>(`/conversations/${id}/claim`, { version }),
  assign: (id: string, version: number, assigneeId: string) =>
    post<ConversationSummary>(`/conversations/${id}/assign`, { version, assigneeId }),
  transfer: (
    id: string,
    body: { version: number; toTeamId?: string; toUserId?: string; reason: string },
  ) => post<ConversationSummary>(`/conversations/${id}/transfer`, body),
  setStatus: (
    id: string,
    body: { version: number; status: ConversationStatus; snoozedUntil?: string; reason?: string },
  ) => post<ConversationSummary>(`/conversations/${id}/status`, body),
  setPriority: (id: string, version: number, priority: number) =>
    post<ConversationSummary>(`/conversations/${id}/priority`, { version, priority }),
  sendMessage: (id: string, body: string, idempotencyKey: string) =>
    post<{ message: SentHumanMessage }>(`/conversations/${id}/messages`, { body, idempotencyKey }),
  addNote: (id: string, body: string) =>
    post<{ note: TimelineNote }>(`/conversations/${id}/notes`, { body }),
  linkContext: (id: string, convocationId: string) =>
    post<void>(`/conversations/${id}/contexts`, { convocationId }),
  unlinkContext: (id: string, convocationId: string) =>
    request<void>(`/conversations/${id}/contexts/${convocationId}`, { method: 'DELETE' }),
  automation: (id: string) => request<AutomationPreview>(`/conversations/${id}/automation`),
  resumeAutomation: (id: string, version: number, convocationIds: string[]) =>
    post<{ resumedConvocationIds: string[]; conversation: ConversationSummary }>(
      `/conversations/${id}/automation/resume`,
      { version, convocationIds },
    ),
  markRead: (id: string, lastReadMessageId?: string) =>
    post<void>(`/conversations/${id}/read`, lastReadMessageId ? { lastReadMessageId } : {}),
  setOptOut: (contactId: string, optedOut: boolean, reason: string) =>
    post<void>(`/contacts/${contactId}/opt-out`, { optedOut, reason }),
  teams: () => request<TeamOption[]>('/teams'),
};

/** Resumo enviado no 409 VERSION_CONFLICT, se presente. */
export function conflictSummary(error: unknown): ConversationSummary | null {
  if (!(error instanceof InboxApiError) || error.code !== 'VERSION_CONFLICT') return null;
  const conversation = error.body?.conversation;
  return conversation && typeof conversation === 'object'
    ? (conversation as ConversationSummary)
    : null;
}

/** Motivos enviados no 422 HUMAN_REPLY_BLOCKED. */
export function blockedReasons(error: unknown): string[] | null {
  if (!(error instanceof InboxApiError) || error.code !== 'HUMAN_REPLY_BLOCKED') return null;
  const reasons = error.body?.reasons;
  return Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === 'string') : [];
}
