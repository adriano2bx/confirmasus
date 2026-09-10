import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { CampaignStatus, prisma } from '@confirma/database';
import {
  normalizeBrazilianPhone,
  normalizePatientName,
  patientGroupingKey,
  selectWhatsAppPhone,
} from '@confirma/domain';
import { readImportedRow } from '../imports/import-row.js';
import type { CreateCampaignDto } from './create-campaign.dto.js';
import type { CampaignsQueryDto } from './campaigns-query.dto.js';
import type { UpdateCampaignDto } from './update-campaign.dto.js';

@Injectable()
export class CampaignsService {
  async createFromImport(importId: string, input: CreateCampaignDto, userId: string) {
    const firstActionAt = new Date(input.firstActionAt);
    if (Number.isNaN(firstActionAt.valueOf()))
      throw new BadRequestException('Data da primeira tentativa inválida');
    if (firstActionAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('A primeira convocação não pode ser programada no passado');
    }

    return prisma.$transaction(async (transaction) => {
      const imported = await transaction.import.findUnique({
        where: { id: importId },
        include: { sourceRecords: { include: { importRow: true } }, campaigns: true },
      });
      if (!imported) throw new BadRequestException('Importação não encontrada');
      if (imported.status !== 'APPROVED')
        throw new ConflictException('A importação precisa estar aprovada');
      if (imported.campaigns.length > 0)
        throw new ConflictException('Esta importação já possui uma campanha');
      if (imported.sourceRecords.length === 0)
        throw new BadRequestException('Não há registros válidos para criar campanha');

      const campaign = await transaction.campaign.create({
        data: {
          importId,
          name: input.name.trim(),
          status: CampaignStatus.DRAFT,
          firstActionAt,
          secondIntervalDays: input.secondIntervalDays,
          secondStartTime: input.secondStartTime,
          thirdIntervalDays: input.thirdIntervalDays,
          thirdStartTime: input.thirdStartTime,
          finalResponseWindowDays: input.finalResponseWindowDays,
        },
      });

      const groups = new Map<string, typeof imported.sourceRecords>();
      for (const record of imported.sourceRecords) {
        const row = readImportedRow(record.importRow.normalizedData);
        if (!row.nome) continue;
        const key = patientGroupingKey({
          name: row.nome,
          birthDate: row.dataNascimento ? toIsoDate(row.dataNascimento) : null,
          cpf: row.cpf,
        });
        const group = groups.get(key) ?? [];
        group.push(record);
        groups.set(key, group);
      }

      for (const records of groups.values()) {
        const first = records[0];
        if (!first) continue;
        const row = readImportedRow(first.importRow.normalizedData);
        if (!row.nome) continue;
        const importedRows = records.map((record) =>
          readImportedRow(record.importRow.normalizedData),
        );
        const birthDate = row.dataNascimento
          ? new Date(`${toIsoDate(row.dataNascimento)}T00:00:00.000Z`)
          : null;
        const cpf = row.cpf?.replace(/\D/g, '') || null;
        const cns =
          importedRows
            .map((value) => value.cns?.replace(/\D/g, ''))
            .find((value) => value?.length === 15) ?? null;
        const normalizedName = normalizePatientName(row.nome);
        const existingPatient = await transaction.patient.findFirst({
          where: cpf
            ? { cpf }
            : birthDate
              ? { normalizedName, birthDate }
              : { normalizedName, birthDate: null },
        });
        const patient = existingPatient
          ? await transaction.patient.update({
              where: { id: existingPatient.id },
              data: {
                displayName: row.nome,
                normalizedName,
                ...(cpf ? { cpf } : {}),
                ...(cns ? { cns } : {}),
                ...(birthDate ? { birthDate } : {}),
              },
            })
          : await transaction.patient.create({
              data: {
                displayName: row.nome,
                normalizedName,
                ...(birthDate ? { birthDate } : { birthDate: null }),
                ...(cpf ? { cpf } : {}),
                ...(cns ? { cns } : {}),
              },
            });

        const allPhones = importedRows.flatMap((value) => value.telefones);
        const normalizedPhones = allPhones.map(normalizeBrazilianPhone);
        const requestedPhone = importedRows
          .map((value) => value.selectedPhone)
          .find((value): value is string => Boolean(value));
        const requested = requestedPhone ? normalizeBrazilianPhone(requestedPhone) : null;
        const selected =
          (requested?.valid && requested.mobile ? requested : null) ??
          selectWhatsAppPhone(normalizedPhones);
        if (!selected) continue;
        await transaction.patientPhone.createMany({
          data: normalizedPhones.map((phone) => ({
            patientId: patient.id,
            originalValue: phone.original,
            normalizedValue: phone.normalized,
            valid: phone.valid,
            mobile: phone.mobile,
            selectedForWhatsApp: phone.normalized === selected.normalized,
          })),
          skipDuplicates: true,
        });
        const selectedPhone = await transaction.patientPhone.findUniqueOrThrow({
          where: {
            patientId_normalizedValue: {
              patientId: patient.id,
              normalizedValue: selected.normalized,
            },
          },
        });
        const convocation = await transaction.convocation.create({
          data: {
            campaignId: campaign.id,
            patientId: patient.id,
            selectedPhoneId: selectedPhone.id,
            nextActionAt: firstActionAt,
          },
        });
        await transaction.convocationRecord.createMany({
          data: records.map((record) => ({
            convocationId: convocation.id,
            sourceRecordId: record.id,
          })),
        });
      }

      const counts = await transaction.convocation.count({ where: { campaignId: campaign.id } });
      await transaction.auditLog.create({
        data: {
          userId,
          eventType: 'CAMPAIGN_CREATED',
          entityType: 'campaign',
          entityId: campaign.id,
          newData: { importId, patientCount: counts },
        },
      });
      return { ...campaign, patientCount: counts };
    });
  }

  async list(input: CampaignsQueryDto) {
    const where = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.query?.trim()
        ? { name: { contains: input.query.trim(), mode: 'insensitive' as const } }
        : {}),
    };
    const [total, items] = await Promise.all([
      prisma.campaign.count({ where }),
      prisma.campaign.findMany({
        where,
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { convocations: true } } },
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

  options() {
    return prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, status: true },
    });
  }

  async detail(id: string) {
    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id },
      include: {
        import: { include: { files: { select: { originalName: true } } } },
        _count: { select: { convocations: true } },
      },
    });
    const [byStatus, byStage, messagesByStatus, recentAudit] = await Promise.all([
      prisma.convocation.groupBy({
        by: ['status'],
        where: { campaignId: id },
        _count: { _all: true },
      }),
      prisma.convocation.groupBy({
        by: ['stage'],
        where: { campaignId: id },
        _count: { _all: true },
      }),
      prisma.message.groupBy({
        by: ['status'],
        where: { convocation: { campaignId: id } },
        _count: { _all: true },
      }),
      prisma.auditLog.findMany({
        where: { entityType: 'campaign', entityId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { user: { select: { name: true } } },
      }),
    ]);
    return {
      ...campaign,
      convocationByStatus: Object.fromEntries(
        byStatus.map((item) => [item.status, item._count._all]),
      ),
      convocationByStage: Object.fromEntries(byStage.map((item) => [item.stage, item._count._all])),
      messageByStatus: Object.fromEntries(
        messagesByStatus.map((item) => [item.status, item._count._all]),
      ),
      recentAudit,
    };
  }

  async updateDraft(id: string, input: UpdateCampaignDto, userId: string) {
    const firstActionAt = input.firstActionAt ? new Date(input.firstActionAt) : undefined;
    if (firstActionAt && firstActionAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('A primeira convocação não pode ser programada no passado');
    }
    return prisma.$transaction(async (transaction) => {
      const campaign = await transaction.campaign.findUnique({ where: { id } });
      if (!campaign) throw new BadRequestException('Campanha não encontrada');
      if (campaign.status !== 'DRAFT') {
        throw new ConflictException('Somente campanhas em rascunho podem ser editadas');
      }
      const updated = await transaction.campaign.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(firstActionAt ? { firstActionAt } : {}),
          ...(input.secondIntervalDays !== undefined
            ? { secondIntervalDays: input.secondIntervalDays }
            : {}),
          ...(input.secondStartTime ? { secondStartTime: input.secondStartTime } : {}),
          ...(input.thirdIntervalDays !== undefined
            ? { thirdIntervalDays: input.thirdIntervalDays }
            : {}),
          ...(input.thirdStartTime ? { thirdStartTime: input.thirdStartTime } : {}),
          ...(input.finalResponseWindowDays !== undefined
            ? { finalResponseWindowDays: input.finalResponseWindowDays }
            : {}),
        },
      });
      if (firstActionAt) {
        await transaction.convocation.updateMany({
          where: { campaignId: id, status: 'SCHEDULED' },
          data: { nextActionAt: firstActionAt },
        });
      }
      await transaction.auditLog.create({
        data: {
          userId,
          eventType: 'CAMPAIGN_DRAFT_UPDATED',
          entityType: 'campaign',
          entityId: id,
          previousData: campaign,
          newData: updated,
        },
      });
      return updated;
    });
  }

  async schedule(id: string, userId: string) {
    return this.changeCampaignState(id, userId, 'SCHEDULED');
  }

  async pause(id: string, userId: string) {
    return this.changeCampaignState(id, userId, 'PAUSED');
  }

  async resume(id: string, userId: string) {
    const result = await this.changeCampaignState(id, userId, 'RUNNING');
    const pending = await prisma.convocation.count({
      where: {
        campaignId: id,
        status: { in: ['SCHEDULED', 'QUEUED', 'WAITING_RESPONSE'] },
        nextActionAt: { lte: new Date() },
      },
    });
    return { ...result, pendingDue: pending };
  }

  async cancel(id: string, userId: string) {
    return prisma.$transaction(async (transaction) => {
      const campaign = await transaction.campaign.findUnique({ where: { id } });
      if (!campaign) throw new BadRequestException('Campanha não encontrada');
      if (campaign.status === 'CANCELLED') return campaign;
      if (campaign.status === 'COMPLETED')
        throw new ConflictException('Campanha concluída não pode ser cancelada');
      const updated = await transaction.campaign.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await transaction.convocation.updateMany({
        where: {
          campaignId: id,
          status: { in: ['SCHEDULED', 'QUEUED', 'PROCESSING', 'WAITING_RESPONSE'] },
        },
        data: { nextActionAt: null },
      });
      await transaction.auditLog.create({
        data: { userId, eventType: 'CAMPAIGN_CANCELLED', entityType: 'campaign', entityId: id },
      });
      return updated;
    });
  }

  private async changeCampaignState(
    id: string,
    userId: string,
    target: 'SCHEDULED' | 'PAUSED' | 'RUNNING',
  ) {
    return prisma.$transaction(async (transaction) => {
      const campaign = await transaction.campaign.findUnique({ where: { id } });
      if (!campaign) throw new BadRequestException('Campanha não encontrada');
      if (campaign.status === 'CANCELLED' || campaign.status === 'COMPLETED') {
        throw new ConflictException('Não é possível alterar uma campanha finalizada');
      }
      if (target === 'SCHEDULED' && ['SCHEDULED', 'RUNNING'].includes(campaign.status)) {
        return campaign;
      }
      if (target === 'SCHEDULED' && campaign.status !== 'DRAFT') {
        throw new ConflictException('Somente campanhas em rascunho podem ser programadas');
      }
      if (
        target === 'SCHEDULED' &&
        (!campaign.firstActionAt || campaign.firstActionAt < new Date(Date.now() - 60_000))
      ) {
        throw new ConflictException('Revise a data da primeira convocação antes de programar');
      }
      if (target === 'PAUSED' && !['SCHEDULED', 'RUNNING'].includes(campaign.status)) {
        throw new ConflictException(
          'Somente campanhas programadas ou em execução podem ser pausadas',
        );
      }
      if (target === 'RUNNING' && campaign.status !== 'PAUSED') {
        throw new ConflictException('Somente campanhas pausadas podem ser retomadas');
      }
      const updated = await transaction.campaign.update({
        where: { id },
        data: {
          status: target,
          ...(target === 'RUNNING' ? { startedAt: campaign.startedAt ?? new Date() } : {}),
        },
      });
      await transaction.auditLog.create({
        data: { userId, eventType: `CAMPAIGN_${target}`, entityType: 'campaign', entityId: id },
      });
      return updated;
    });
  }
}

function toIsoDate(value: string): string {
  const [day, month, year] = value.split('/');
  return `${year}-${month}-${day}`;
}
