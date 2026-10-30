import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { prisma } from '@confirma/database';
import type { UpdateConvocationStatusDto } from './update-convocation-status.dto.js';
import type { ConvocationsQueryDto } from './convocations-query.dto.js';

@Injectable()
export class ConvocationsService {
  async list(input: ConvocationsQueryDto) {
    const createdAt = datePeriod(input.dateFrom, input.dateTo);
    const search = input.query?.trim();
    const documentSearch = search?.replace(/\D/g, '') ?? '';
    const where = {
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      ...(input.status ? { status: input.status as never } : {}),
      ...(input.stage ? { stage: input.stage as never } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(input.procedure?.trim()
        ? {
            records: {
              some: {
                sourceRecord: {
                  procedures: {
                    some: {
                      name: { contains: input.procedure.trim(), mode: 'insensitive' as const },
                    },
                  },
                },
              },
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { patient: { displayName: { contains: search, mode: 'insensitive' as const } } },
              ...(documentSearch
                ? [
                    { patient: { cpf: { contains: documentSearch } } },
                    { patient: { cns: { contains: documentSearch } } },
                  ]
                : []),
              { campaign: { name: { contains: search, mode: 'insensitive' as const } } },
              {
                records: {
                  some: {
                    sourceRecord: {
                      codigoConvocacaoOrigem: { contains: search, mode: 'insensitive' as const },
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };
    const [total, items] = await Promise.all([
      prisma.convocation.count({ where }),
      prisma.convocation.findMany({
        where,
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          patient: { include: { phones: true } },
          selectedPhone: true,
          campaign: { select: { id: true, name: true } },
          records: { include: { sourceRecord: { include: { procedures: true } } } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
    ]);
    return {
      items,
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        pages: Math.max(1, Math.ceil(total / input.limit)),
      },
    };
  }

  detail(id: string) {
    return prisma.convocation
      .findUniqueOrThrow({
        where: { id },
        include: {
          patient: { include: { phones: true } },
          selectedPhone: true,
          campaign: true,
          records: { include: { sourceRecord: { include: { procedures: true } } } },
          messages: {
            include: { events: { orderBy: { receivedAt: 'asc' } }, billingEvents: true },
            orderBy: { createdAt: 'asc' },
          },
          responses: { orderBy: { receivedAt: 'asc' } },
          handoff: true,
        },
      })
      .then(async (convocation) => ({
        ...convocation,
        auditLogs: await prisma.auditLog.findMany({
          where: { entityType: 'convocation', entityId: id },
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { name: true } } },
        }),
      }));
  }

  async updateStatus(id: string, input: UpdateConvocationStatusDto, userId: string) {
    return prisma.$transaction(async (transaction) => {
      const convocation = await transaction.convocation.findUnique({ where: { id } });
      if (!convocation) throw new BadRequestException('Convocação não encontrada');
      const terminal = ['CONFIRMED', 'CANCELLED', 'FINISHED_NO_RESPONSE'];
      if (convocation.status === input.status) return convocation;
      if (terminal.includes(convocation.status)) {
        throw new ConflictException('Esta convocação já foi finalizada');
      }

      const now = new Date();
      const updated = await transaction.convocation.update({
        where: { id },
        data: {
          status: input.status,
          nextActionAt: null,
          stage: 'FINISHED',
          finishedAt: now,
          version: { increment: 1 },
          ...(input.status === 'CONFIRMED'
            ? { confirmedAt: now, cancelledAt: null }
            : { cancelledAt: now, confirmedAt: null }),
        },
      });
      await transaction.auditLog.create({
        data: {
          userId,
          eventType: 'CONVOCATION_STATUS_CHANGED_MANUALLY',
          entityType: 'convocation',
          entityId: id,
          previousData: { status: convocation.status },
          newData: { status: input.status },
          reason: input.reason.trim(),
        },
      });

      const remaining = await transaction.convocation.count({
        where: {
          campaignId: convocation.campaignId,
          status: { notIn: ['CONFIRMED', 'CANCELLED', 'FINISHED_NO_RESPONSE', 'SEND_ERROR'] },
        },
      });
      if (remaining === 0) {
        await transaction.campaign.updateMany({
          where: {
            id: convocation.campaignId,
            status: { in: ['SCHEDULED', 'RUNNING', 'PAUSED'] },
          },
          data: { status: 'COMPLETED', completedAt: now },
        });
      }
      return updated;
    });
  }
}

function datePeriod(dateFrom?: string, dateTo?: string) {
  if (!dateFrom && !dateTo) return undefined;
  const start = dateFrom ? new Date(`${dateFrom}T00:00:00`) : undefined;
  const end = dateTo ? new Date(`${dateTo}T00:00:00`) : undefined;
  if ((start && Number.isNaN(start.valueOf())) || (end && Number.isNaN(end.valueOf()))) {
    throw new BadRequestException('O período informado contém uma data inválida');
  }
  if (start && end && start > end) {
    throw new BadRequestException('A data inicial não pode ser posterior à data final');
  }
  if (end) end.setDate(end.getDate() + 1);
  return { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) };
}
