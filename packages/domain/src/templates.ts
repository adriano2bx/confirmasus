export type MessageStage = 'FIRST' | 'SECOND' | 'THIRD';

export interface WhatsAppTemplate {
  name: string;
  idEnvironmentVariable: string;
  defaultId: string;
}

export const WHATSAPP_TEMPLATES: Record<MessageStage, WhatsAppTemplate> = {
  FIRST: {
    name: 'primeira_convocacao_sus_unico',
    idEnvironmentVariable: 'META_TEMPLATE_FIRST_NAME',
    defaultId: 'primeira_convocacao_sus_unico',
  },
  SECOND: {
    name: 'segunda_convocacao_sus',
    idEnvironmentVariable: 'META_TEMPLATE_SECOND_NAME',
    defaultId: 'segunda_convocacao_sus',
  },
  THIRD: {
    name: 'terceira_convocacao_sus',
    idEnvironmentVariable: 'META_TEMPLATE_THIRD_NAME',
    defaultId: 'terceira_convocacao_sus',
  },
};

export function templateForStage(stage: MessageStage): WhatsAppTemplate {
  return WHATSAPP_TEMPLATES[stage];
}
