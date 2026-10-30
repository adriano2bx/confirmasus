export const AUTOMATIC_REPLY_TEMPLATE_ID = 'SESSION_TEXT';

export type AutomaticReplyAction = 'CONFIRM' | 'CANCEL';

export function automaticReplyEnabled(): boolean {
  return process.env.AUTOMATIC_REPLY_ENABLED?.trim().toLowerCase() !== 'false';
}

export function automaticReplyDefinition(action: AutomaticReplyAction) {
  return action === 'CONFIRM'
    ? {
        attemptNumber: 4,
        templateName: 'resposta_automatica_confirmacao',
        text:
          process.env.AUTOMATIC_REPLY_CONFIRM_TEXT?.trim() ||
          'Obrigado pela sua confirmação. Aguarde, em breve nossa equipe dará continuidade ao atendimento pelo whatsapp ou por ligação através do número (65) 3184-0054',
      }
    : {
        attemptNumber: 5,
        templateName: 'resposta_automatica_cancelamento',
        text:
          process.env.AUTOMATIC_REPLY_CANCEL_TEXT?.trim() ||
          'Seu cancelamento foi registrado. Não enviaremos novas convocações referentes a esta solicitação.',
      };
}
