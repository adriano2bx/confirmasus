import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@confirma/database';

export const DEAD_LETTER_REPLAY_EVENT = 'WEBHOOK_DEAD_LETTER_REPLAYED';

/** Erro minimizado: sem dígitos longos (telefone/WAMID decodificado) e curto. */
export function minimizeProcessingError(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/\d{6,}/g, '[digitos]')
    .replace(/wamid\.[\w=+/-]+/gi, '[wamid]')
    .slice(0, 200);
}

@Injectable()
export class DeadLettersService {
  async list(page: number, limit: number) {
    const where = { processingStatus: 'DEAD_LETTER' as const };
    const [total, rows] = await Promise.all([
      prisma.messageEvent.count({ where }),
      prisma.messageEvent.findMany({
        where,
        orderBy: [{ deadLetteredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        // Nunca o payload, waId ou WAMID: só IDs técnicos, tipo, erro minimizado e datas.
        select: {
          id: true,
          eventType: true,
          messageId: true,
          phoneNumberId: true,
          attempts: true,
          processingError: true,
          receivedAt: true,
          deadLetteredAt: true,
        },
      }),
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        processingError: minimizeProcessingError(row.processingError),
      })),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /**
   * Devolve o evento ao outbox (PENDING, attempts 0, nextAttemptAt null); o despachante do
   * worker o republica. Auditado. Não reprocessa nada diretamente.
   */
  async replay(id: string, userId: string) {
    return prisma.$transaction(async (tx) => {
      const current = await tx.messageEvent.findUnique({
        where: { id },
        select: { id: true, processingStatus: true, attempts: true, deadLetteredAt: true },
      });
      if (!current) throw new NotFoundException('Evento não encontrado');
      const updated = await tx.messageEvent.updateMany({
        where: { id, processingStatus: 'DEAD_LETTER' },
        data: {
          processingStatus: 'PENDING',
          attempts: 0,
          nextAttemptAt: null,
          dispatchLeaseUntil: null,
        },
      });
      if (updated.count === 0) {
        throw new ConflictException('Evento não está em dead-letter');
      }
      await tx.auditLog.create({
        data: {
          userId,
          eventType: DEAD_LETTER_REPLAY_EVENT,
          entityType: 'message_event',
          entityId: id,
          previousData: {
            processingStatus: current.processingStatus,
            attempts: current.attempts,
            deadLetteredAt: current.deadLetteredAt?.toISOString() ?? null,
          },
          newData: { processingStatus: 'PENDING', attempts: 0 },
        },
      });
      return { id, processingStatus: 'PENDING' as const };
    });
  }
}
