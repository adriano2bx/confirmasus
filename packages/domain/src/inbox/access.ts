/**
 * RBAC do inbox, avaliado no servidor em todo endpoint. A UI só reflete.
 * - ADMIN (UserRole global): tudo.
 * - SUPERVISOR de uma equipe: vê todas as conversas da equipe; atribui/transfere/retoma automação.
 * - AGENT de uma equipe: vê conversas da equipe; assume não atribuídas; responde/transfere as próprias.
 * - Usuário sem equipe: sem acesso ao inbox.
 */

export type GlobalRole = 'ADMIN' | 'OPERATOR';
export type TeamRole = 'AGENT' | 'SUPERVISOR';

export interface InboxActor {
  userId: string;
  globalRole: GlobalRole;
  /** teamId -> papel na equipe */
  teams: ReadonlyMap<string, TeamRole>;
}

export interface ConversationAccessTarget {
  teamId: string | null;
  assigneeId: string | null;
}

export type InboxAction =
  | 'view'
  | 'claim'
  | 'assign'
  | 'transfer'
  | 'resolve'
  | 'reopen'
  | 'snooze'
  | 'note'
  | 'reply'
  | 'link_context'
  | 'resume_automation'
  | 'set_opt_out';

export function isSupervisorOf(actor: InboxActor, teamId: string | null): boolean {
  if (actor.globalRole === 'ADMIN') return true;
  return teamId !== null && actor.teams.get(teamId) === 'SUPERVISOR';
}

export function isMemberOf(actor: InboxActor, teamId: string | null): boolean {
  if (actor.globalRole === 'ADMIN') return true;
  return teamId !== null && actor.teams.has(teamId);
}

export function canPerform(
  actor: InboxActor,
  action: InboxAction,
  target: ConversationAccessTarget,
): boolean {
  const supervisor = isSupervisorOf(actor, target.teamId);
  const member = isMemberOf(actor, target.teamId);
  const own = target.assigneeId === actor.userId;
  switch (action) {
    case 'view':
    case 'note':
      return member;
    case 'claim':
      return member && target.assigneeId === null;
    case 'assign':
    case 'resume_automation':
    case 'set_opt_out':
    case 'reopen':
      return supervisor;
    case 'transfer':
    case 'resolve':
    case 'snooze':
    case 'link_context':
      return supervisor || (member && own);
    case 'reply':
      // Só o responsável envia; supervisor precisa assumir/atribuir a si antes.
      return member && own;
  }
}

/** Equipes cujas conversas o ator pode listar; null = todas (ADMIN). */
export function visibleTeamIds(actor: InboxActor): string[] | null {
  if (actor.globalRole === 'ADMIN') return null;
  return [...actor.teams.keys()];
}
