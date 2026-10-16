// Rótulos do atendimento. HUMAN_REPLY_BLOCK_LABELS é réplica de @confirma/domain, que não é
// dependência do web; o texto canônico fica em atendimento/inbox-logic.mjs (testado por node:test).
export {
  ACTIVITY_LABELS,
  CONVERSATION_STATUS_LABELS,
  HUMAN_REPLY_BLOCK_LABELS,
  INBOUND_INELIGIBILITY_LABELS,
  INBOX_VIEWS,
  PRIORITY_OPTIONS,
  activityLabel,
  blockReasonLabel,
  conversationStatusLabel,
  ineligibilityLabel,
  messageStatusInfo,
  priorityLabel,
} from '../atendimento/inbox-logic.mjs';
export type { HumanReplyBlockReason, InboxView } from '../atendimento/inbox-logic.mjs';
