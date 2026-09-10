import { Prisma, prisma } from '@confirma/database';
import type { Job } from 'bullmq';
import type { ProcessHandoffJob } from '@confirma/queue';

const handoffEnabled = () => process.env.HANDOFF_MODE === 'LIVE';

export async function processHandoff(job: Job<ProcessHandoffJob>): Promise<void> {
  const event = await prisma.handoffEvent.findUnique({
    where: { id: job.data.handoffEventId },
    include: {
      convocation: {
        include: {
          patient: { include: { phones: true } },
          campaign: true,
          records: { include: { sourceRecord: { include: { procedures: true } } } },
          messages: { orderBy: { createdAt: 'asc' } },
          responses: { orderBy: { receivedAt: 'asc' } },
        },
      },
    },
  });
  if (!event || event.status === 'SUBMITTED') return;

  if (!handoffEnabled()) {
    await prisma.handoffEvent.update({
      where: { id: event.id },
      data: {
        status: 'FAILED',
        failureReason: 'Transbordo desabilitado pela configuração do ambiente',
        nextAttemptAt: null,
      },
    });
    return;
  }

  try {
    const config = requiredConfiguration();
    const payload = createPayload(event, config);
    const response = await fetch(config.webhook, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': event.idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const responsePayload = await responseBody(response);
    if (!response.ok) throw new Error(`View/EasySAC respondeu HTTP ${response.status}`);

    await prisma.$transaction([
      prisma.handoffEvent.update({
        where: { id: event.id },
        data: {
          status: 'SUBMITTED',
          attempts: { increment: 1 },
          nextAttemptAt: null,
          submittedAt: new Date(),
          responsePayload:
            responsePayload === null ? Prisma.JsonNull : (responsePayload as Prisma.InputJsonValue),
        },
      }),
      prisma.auditLog.create({
        data: {
          eventType: 'PATIENT_HANDOFF_SUBMITTED',
          entityType: 'convocation',
          entityId: event.convocationId,
          metadata: { handoffEventId: event.id },
        },
      }),
    ]);
  } catch (error) {
    const attempts = event.attempts + 1;
    const maximum = Number(process.env.HANDOFF_MAX_ATTEMPTS ?? 5);
    const finalFailure = attempts >= maximum;
    const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
    await prisma.handoffEvent.update({
      where: { id: event.id },
      data: {
        status: finalFailure ? 'FAILED' : 'PENDING',
        attempts,
        nextAttemptAt: finalFailure ? null : new Date(Date.now() + delay),
        failureReason:
          error instanceof Error ? error.message.slice(0, 500) : 'Erro desconhecido no transbordo',
      },
    });
    if (finalFailure) {
      await prisma.auditLog.create({
        data: {
          eventType: 'PATIENT_HANDOFF_FAILED',
          entityType: 'convocation',
          entityId: event.convocationId,
          metadata: { handoffEventId: event.id, attempts },
        },
      });
    }
  }
}

function requiredConfiguration() {
  const keys = [
    'VIEW_EASYSAC_WEBHOOK',
    'VIEW_EASYSAC_ORG_ID',
    'VIEW_EASYSAC_APP_KEY',
    'VIEW_EASYSAC_CHANNEL_ID',
    'VIEW_EASYSAC_QUEUE_ID',
  ] as const;
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Configuração de transbordo ausente: ${missing.join(', ')}`);
  return {
    webhook: process.env.VIEW_EASYSAC_WEBHOOK!,
    orgId: process.env.VIEW_EASYSAC_ORG_ID!,
    appKey: process.env.VIEW_EASYSAC_APP_KEY!,
    channelId: process.env.VIEW_EASYSAC_CHANNEL_ID!,
    queueId: process.env.VIEW_EASYSAC_QUEUE_ID!,
    channelType: process.env.VIEW_EASYSAC_CHANNEL_TYPE ?? 'whatsapp',
  };
}

function createPayload(event: any, config: ReturnType<typeof requiredConfiguration>) {
  const { convocation } = event;
  const phone =
    convocation.messages.at(-1)?.phone ??
    convocation.patient.phones.find((item: any) => item.selectedForWhatsApp)?.normalizedValue ??
    convocation.patient.phones.find((item: any) => item.valid)?.normalizedValue ??
    '';
  const records = convocation.records.map(({ sourceRecord }: any) => ({
    codigo: sourceRecord.codigoConvocacaoOrigem,
    dataHora: sourceRecord.scheduledAt.toISOString(),
    procedimentos: sourceRecord.procedures.map((procedure: any) => procedure.name),
  }));
  const summary = [
    'Paciente confirmou interesse em exame SUS.',
    `Paciente: ${convocation.patient.displayName}`,
    `Nascimento: ${convocation.patient.birthDate ? formatDate(convocation.patient.birthDate) : 'Não informada'}`,
    convocation.patient.cpf ? `CPF: ${convocation.patient.cpf}` : null,
    `Telefone: ${phone}`,
    `Campanha: ${convocation.campaign.name}`,
    '',
    'Solicitações:',
    ...records.map(
      (record: any) =>
        `• Código ${record.codigo} | ${formatDateTime(record.dataHora)} | ${record.procedimentos.join(', ') || 'Sem procedimento informado'}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');

  return {
    orgId: config.orgId,
    webhook: config.webhook,
    appKey: config.appKey,
    channelId: config.channelId,
    queueId: config.queueId,
    channelType: config.channelType,
    createdAt: formatZonedIso(new Date(), process.env.APP_TIMEZONE ?? 'America/Sao_Paulo'),
    mobile: phone,
    name: convocation.patient.displayName,
    photo: null,
    messages: [{ type: 'text', text: summary }],
    scheduleOffset: 0,
    escalated: true,
    close: false,
  };
}

async function responseBody(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, 10_000);
  try {
    return JSON.parse(text);
  } catch {
    return text || null;
  }
}
function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: process.env.APP_TIMEZONE ?? 'America/Sao_Paulo',
  }).format(value);
}
function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: process.env.APP_TIMEZONE ?? 'America/Sao_Paulo',
  }).format(new Date(value));
}

function formatZonedIso(value: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: part }) => [type, part]),
  );
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMinutes = Math.round((localAsUtc - value.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}:${String(absoluteOffset % 60).padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(value.getMilliseconds()).padStart(3, '0')}${offset}`;
}
