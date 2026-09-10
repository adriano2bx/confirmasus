import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { Prisma, prisma } from '@confirma/database';
import { normalizeBrazilianPhone, patientGroupingKey, selectWhatsAppPhone } from '@confirma/domain';
import type { ParseImportJob } from '@confirma/queue';
import type { Queue } from 'bullmq';
import { environment } from '../environment.js';
import { IMPORT_QUEUE } from './imports.constants.js';
import { validateImportedRow } from './import-row.js';
import { readImportedRow } from './import-row.js';
import type { UpdateImportRowDto } from './update-import-row.dto.js';
import type { ImportsQueryDto } from './imports-query.dto.js';

@Injectable()
export class ImportsService {
  constructor(@Inject(IMPORT_QUEUE) private readonly queue: Queue<ParseImportJob>) {}

  async create(file: Express.Multer.File, userId: string) {
    const isPdf = file.mimetype === 'application/pdf' && file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'));
    const isXlsx =
      (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || file.mimetype === 'application/zip' || file.originalname.toLowerCase().endsWith('.xlsx')) &&
      file.buffer.subarray(0, 2).equals(Buffer.from('PK'));
    if (!isPdf && !isXlsx) throw new BadRequestException('Envie um arquivo PDF ou uma planilha XLSX válida');

    const temporaryDirectory = environment().UPLOAD_TEMP_DIR;
    await mkdir(temporaryDirectory, { recursive: true });
    const temporaryPath = join(temporaryDirectory, `${randomUUID()}${isXlsx ? '.xlsx' : '.pdf'}`);
    await writeFile(temporaryPath, file.buffer, { flag: 'wx' });

    const checksum = createHash('sha256').update(file.buffer).digest('hex');

    try {
      const createdImport = await prisma.import.create({
        data: {
          status: 'UPLOADED',
          files: {
            create: {
              originalName: file.originalname,
              mimeType: file.mimetype,
              sizeBytes: file.size,
              checksum,
              temporaryKey: temporaryPath,
            },
          },
        },
        include: { files: true },
      });

      const importFile = createdImport.files[0];
      if (!importFile) throw new Error('Arquivo da importação não persistido');

      await this.queue.add(
        'parse-import',
        { importId: createdImport.id, importFileId: importFile.id, temporaryPath },
        {
          jobId: `parse:${importFile.id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 500,
          removeOnFail: 1_000,
        },
      );

      await prisma.import.update({
        where: { id: createdImport.id },
        data: { status: 'PROCESSING' },
      });

      await prisma.auditLog.create({
        data: {
          userId,
          eventType: 'IMPORT_UPLOADED',
          entityType: 'import',
          entityId: createdImport.id,
          metadata: {
            fileName: file.originalname,
            sizeBytes: file.size,
            checksum,
          },
        },
      });

      return { id: createdImport.id, status: 'PROCESSING' as const };
    } catch (error) {
      await import('node:fs/promises').then(({ unlink }) =>
        unlink(temporaryPath).catch(() => undefined),
      );
      throw error;
    }
  }

  async list(input: ImportsQueryDto) {
    const where = input.status ? { status: input.status } : {};
    const [total, items] = await Promise.all([
      prisma.import.count({ where }),
      prisma.import.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        include: { files: { select: { id: true, originalName: true, sizeBytes: true } } },
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

  findById(id: string) {
    return prisma.import.findUniqueOrThrow({
      where: { id },
      include: { files: true, rows: { orderBy: { rowNumber: 'asc' }, take: 500 } },
    });
  }

  async review(id: string) {
    const imported = await prisma.import.findUniqueOrThrow({
      where: { id },
      include: { rows: { orderBy: { rowNumber: 'asc' } }, sourceRecords: true, campaigns: true },
    });
    const rows = imported.rows.map((row) => ({
      id: row.id,
      rowNumber: row.rowNumber,
      validationStatus: row.validationStatus,
      validationIssues: row.validationIssues,
      data: row.normalizedData,
    }));
    const validatedRows = rows.map((row) => ({ ...row, validated: validateImportedRow(row.data) }));
    const validRows = rows.filter((row) => row.validationStatus === 'VALID').length;
    const warningRows = rows.filter((row) => row.validationStatus === 'WARNING').length;
    const invalidRows = rows.filter((row) => row.validationStatus === 'INVALID').length;
    const grouped = new Map<string, typeof validatedRows>();
    for (const row of validatedRows) {
      const value = row.validated;
      if (!value.normalizedName) continue;
      const key = patientGroupingKey({
        name: value.nome ?? '',
        birthDate: value.birthDate ? value.birthDate.toISOString().slice(0, 10) : null,
        cpf: value.normalizedCpf,
      });
      const group = grouped.get(key) ?? [];
      group.push(row);
      grouped.set(key, group);
    }
    const patientGroups = [...grouped.entries()].map(([key, group]) => {
      const first = group[0]!.validated;
      const phones = [...new Set(group.flatMap((row) => row.validated.telefones))];
      const normalizedPhones = phones.map(normalizeBrazilianPhone);
      const requested = group
        .map((row) => row.validated.selectedPhone)
        .find((phone): phone is string => Boolean(phone));
      const requestedNormalized = requested ? normalizeBrazilianPhone(requested) : null;
      const selected =
        (requestedNormalized?.valid && requestedNormalized.mobile ? requestedNormalized : null) ??
        selectWhatsAppPhone(normalizedPhones);
      return {
        key,
        name: first.nome,
        birthDate: first.dataNascimento,
        cpf: first.cpf,
        cns:
          group
            .map((row) => row.validated.normalizedCns)
            .find((value): value is string => Boolean(value)) ?? null,
        rowIds: group.map((row) => row.id),
        recordCount: group.length,
        codes: group.map((row) => row.validated.codigoConvocacaoOrigem).filter(Boolean),
        procedures: [...new Set(group.flatMap((row) => row.validated.procedimentos))],
        phones: normalizedPhones,
        selectedPhone: selected?.normalized ?? null,
        eligible: group.every((row) => row.validated.issues.length === 0) && Boolean(selected),
        issues: [...new Set(group.flatMap((row) => row.validated.issues))],
      };
    });
    return {
      id: imported.id,
      status: imported.status,
      layout: imported.layout,
      totalReported: imported.totalReported,
      recordsFound: imported.recordsFound,
      warnings: imported.warnings,
      counts: {
        totalRows: rows.length,
        validRows,
        warningRows,
        invalidRows,
        identifiedPatients: patientGroups.length,
        eligiblePatients: patientGroups.filter((group) => group.eligible).length,
        patientsWithoutValidPhone: patientGroups.filter((group) => !group.selectedPhone).length,
      },
      canApprove:
        ['READY_FOR_REVIEW', 'REVIEW_REQUIRED'].includes(imported.status) &&
        imported.campaigns.length === 0,
      sourceRecordCount: imported.sourceRecords.length,
      campaign: imported.campaigns[0]
        ? {
            id: imported.campaigns[0].id,
            name: imported.campaigns[0].name,
            status: imported.campaigns[0].status,
            firstActionAt: imported.campaigns[0].firstActionAt,
          }
        : null,
      rows,
      patientGroups,
    };
  }

  async updateRow(id: string, rowId: string, input: UpdateImportRowDto, userId: string) {
    return prisma.$transaction(async (transaction) => {
      const imported = await transaction.import.findUnique({
        where: { id },
        include: { campaigns: { select: { id: true } } },
      });
      if (!imported) throw new BadRequestException('Importação não encontrada');
      if (imported.status === 'APPROVED' || imported.campaigns.length > 0) {
        throw new ConflictException('Registros de uma importação aprovada não podem ser alterados');
      }
      if (!['READY_FOR_REVIEW', 'REVIEW_REQUIRED'].includes(imported.status)) {
        throw new ConflictException('A importação ainda não está disponível para revisão');
      }
      const row = await transaction.importRow.findFirst({ where: { id: rowId, importId: id } });
      if (!row) throw new BadRequestException('Registro importado não encontrado');
      const previous = readImportedRow(row.normalizedData);
      const normalizedData = {
        ...previous,
        ...input,
        codigoConvocacaoOrigem:
          input.codigoConvocacaoOrigem?.trim() ?? previous.codigoConvocacaoOrigem,
        nome: input.nome?.trim() ?? previous.nome,
        cpf: input.cpf !== undefined ? input.cpf.trim() || null : previous.cpf,
        cns: input.cns !== undefined ? input.cns.trim() || null : previous.cns,
        telefones:
          input.telefones?.map((value) => value.trim()).filter(Boolean) ?? previous.telefones,
        procedimentos:
          input.procedimentos?.map((value) => value.trim()).filter(Boolean) ??
          previous.procedimentos,
        selectedPhone:
          input.selectedPhone !== undefined
            ? input.selectedPhone.trim() || null
            : previous.selectedPhone,
      };
      const validated = validateImportedRow(normalizedData);
      const updated = await transaction.importRow.update({
        where: { id: row.id },
        data: {
          normalizedData: normalizedData as Prisma.InputJsonValue,
          validationStatus: validated.issues.length ? 'INVALID' : 'VALID',
          validationIssues: validated.issues,
        },
      });
      const invalid = await transaction.importRow.count({
        where: { importId: id, validationStatus: { not: 'VALID' } },
      });
      await transaction.import.update({
        where: { id },
        data: { status: invalid > 0 ? 'REVIEW_REQUIRED' : 'READY_FOR_REVIEW' },
      });
      await transaction.auditLog.create({
        data: {
          userId,
          eventType: 'IMPORT_ROW_UPDATED',
          entityType: 'import_row',
          entityId: row.id,
          previousData: previous as unknown as Prisma.InputJsonValue,
          newData: normalizedData as Prisma.InputJsonValue,
        },
      });
      return {
        id: updated.id,
        validationStatus: updated.validationStatus,
        validationIssues: updated.validationIssues,
        data: updated.normalizedData,
      };
    });
  }

  async cancel(id: string, userId: string) {
    const result = await prisma.$transaction(async (transaction) => {
      const imported = await transaction.import.findUnique({
        where: { id },
        include: { campaigns: true, files: true },
      });
      if (!imported) throw new BadRequestException('Importação não encontrada');
      if (imported.status === 'CANCELLED') return { updated: imported, files: imported.files };
      if (imported.status === 'FAILED')
        throw new ConflictException('Uma importação com falha não pode ser abortada');
      const campaign = imported.campaigns[0];
      if (campaign && campaign.status !== 'DRAFT') {
        throw new ConflictException('O fluxo já foi programado; cancele a campanha na operação');
      }
      if (campaign) {
        await transaction.campaign.update({
          where: { id: campaign.id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
        await transaction.convocation.updateMany({
          where: {
            campaignId: campaign.id,
            status: { in: ['SCHEDULED', 'QUEUED', 'PROCESSING', 'WAITING_RESPONSE'] },
          },
          data: { nextActionAt: null },
        });
      }
      const updated = await transaction.import.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });
      await transaction.auditLog.create({
        data: {
          userId,
          eventType: 'IMPORT_CANCELLED',
          entityType: 'import',
          entityId: id,
          ...(campaign ? { metadata: { campaignId: campaign.id } } : {}),
        },
      });
      return { updated, files: imported.files };
    });

    const job = await this.queue.getJob(`parse:${result.files[0]?.id ?? ''}`);
    await job?.remove().catch(() => undefined);
    for (const file of result.files) {
      if (file.temporaryKey) await unlink(file.temporaryKey).catch(() => undefined);
    }
    return result.updated;
  }

  async approve(id: string, userId: string, note?: string) {
    return prisma.$transaction(async (transaction) => {
      const imported = await transaction.import.findUnique({
        where: { id },
        include: { rows: true, sourceRecords: true, campaigns: true },
      });
      if (!imported) throw new BadRequestException('Importação não encontrada');
      if (!['READY_FOR_REVIEW', 'REVIEW_REQUIRED'].includes(imported.status)) {
        throw new ConflictException('Esta importação não está disponível para aprovação');
      }
      if (imported.campaigns.length > 0)
        throw new ConflictException('A importação já possui uma campanha');

      const normalizedRows = imported.rows.map((row) => ({
        row,
        validated: validateImportedRow(row.normalizedData),
      }));
      const valid = normalizedRows.filter(({ validated }) => validated.issues.length === 0);
      if (valid.length === 0)
        throw new BadRequestException('A importação não contém registros válidos para campanha');

      for (const { row, validated } of normalizedRows) {
        await transaction.importRow.update({
          where: { id: row.id },
          data: {
            validationStatus: validated.issues.length === 0 ? 'VALID' : 'INVALID',
            validationIssues: validated.issues,
          },
        });
      }
      if (imported.sourceRecords.length === 0) {
        for (const { row, validated } of valid) {
          await transaction.sourceRecord.create({
            data: {
              importId: imported.id,
              importRowId: row.id,
              codigoConvocacaoOrigem: validated.codigoConvocacaoOrigem!,
              scheduledAt: validated.scheduledAt!,
              procedures: { create: validated.procedimentos.map((name) => ({ name })) },
            },
          });
        }
      }
      const summary = {
        valid: valid.length,
        invalid: normalizedRows.length - valid.length,
        warning: 0,
      };
      await transaction.import.update({
        where: { id },
        data: { status: 'APPROVED', approvedAt: new Date(), validationSummary: summary },
      });
      await transaction.auditLog.create({
        data: {
          userId,
          eventType: 'IMPORT_APPROVED',
          entityType: 'import',
          entityId: id,
          metadata: { note, ...summary },
        },
      });
      return { id, status: 'APPROVED' as const, ...summary };
    });
  }
}
