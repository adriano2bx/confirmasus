import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { isUniqueViolation, type PrismaClient } from '@confirma/database';
import { INBOX_PRISMA } from './inbox.constants.js';
import type { AddTeamMemberDto, CreateTeamDto, UpdateTeamDto } from './inbox.dto.js';
import { slugify } from './inbox.helpers.js';
import type { Db, RequestUser } from './inbox-summary.js';

const TEAM_SELECT = {
  id: true,
  name: true,
  slug: true,
  isDefault: true,
  active: true,
  members: {
    select: { role: true, user: { select: { id: true, name: true, email: true, active: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

function assertAdmin(user: RequestUser): void {
  if (user.role !== 'ADMIN')
    throw new ForbiddenException('Somente administradores gerenciam equipes');
}

@Injectable()
export class InboxTeamsService {
  constructor(@Inject(INBOX_PRISMA) private readonly db: PrismaClient) {}

  /** ADMIN vê todas; demais usuários só as próprias equipes ativas (para atribuição). */
  async list(user: RequestUser) {
    const teams = await this.db.team.findMany({
      where: user.role === 'ADMIN' ? {} : { active: true, members: { some: { userId: user.sub } } },
      select: TEAM_SELECT,
      orderBy: { name: 'asc' },
    });
    return teams.map((team) => ({
      ...team,
      members: team.members.map((member) => ({ ...member.user, role: member.role })),
    }));
  }

  async create(user: RequestUser, input: CreateTeamDto) {
    assertAdmin(user);
    const slug = input.slug ?? slugify(input.name);
    if (!slug) throw new UnprocessableEntityException('Nome de equipe inválido');
    try {
      return await this.db.$transaction(async (tx) => {
        if (input.isDefault) await clearDefault(tx);
        const team = await tx.team.create({
          data: { name: input.name.trim(), slug, isDefault: input.isDefault ?? false },
          select: { id: true, name: true, slug: true, isDefault: true, active: true },
        });
        await tx.auditLog.create({
          data: {
            userId: user.sub,
            eventType: 'INBOX_TEAM_CREATED',
            entityType: 'team',
            entityId: team.id,
            newData: team,
          },
        });
        return team;
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException('Já existe uma equipe com este identificador');
      throw error;
    }
  }

  async update(user: RequestUser, teamId: string, input: UpdateTeamDto) {
    assertAdmin(user);
    return this.db.$transaction(async (tx) => {
      const current = await tx.team.findUnique({
        where: { id: teamId },
        select: { id: true, name: true, isDefault: true, active: true },
      });
      if (!current) throw new NotFoundException('Equipe não encontrada');
      const active = input.active ?? current.active;
      const isDefault = input.isDefault ?? current.isDefault;
      if (isDefault && !active) {
        throw new UnprocessableEntityException('A fila padrão precisa estar ativa');
      }
      if (input.isDefault === true && !current.isDefault) await clearDefault(tx);
      const team = await tx.team.update({
        where: { id: teamId },
        data: { ...(input.name ? { name: input.name.trim() } : {}), isDefault, active },
        select: { id: true, name: true, slug: true, isDefault: true, active: true },
      });
      await tx.auditLog.create({
        data: {
          userId: user.sub,
          eventType: 'INBOX_TEAM_UPDATED',
          entityType: 'team',
          entityId: teamId,
          previousData: current,
          newData: team,
        },
      });
      return team;
    });
  }

  async addMember(user: RequestUser, teamId: string, input: AddTeamMemberDto) {
    assertAdmin(user);
    const [team, member] = await Promise.all([
      this.db.team.findUnique({ where: { id: teamId }, select: { id: true } }),
      this.db.user.findUnique({
        where: { id: input.userId },
        select: { active: true, deletedAt: true },
      }),
    ]);
    if (!team) throw new NotFoundException('Equipe não encontrada');
    if (!member?.active || member.deletedAt)
      throw new NotFoundException('Usuário não encontrado ou inativo');
    return this.db.$transaction(async (tx) => {
      const saved = await tx.teamMember.upsert({
        where: { teamId_userId: { teamId, userId: input.userId } },
        create: { teamId, userId: input.userId, role: input.role },
        update: { role: input.role },
        select: { teamId: true, userId: true, role: true },
      });
      await tx.auditLog.create({
        data: {
          userId: user.sub,
          eventType: 'INBOX_TEAM_MEMBER_SET',
          entityType: 'team',
          entityId: teamId,
          newData: saved,
        },
      });
      return saved;
    });
  }

  async removeMember(user: RequestUser, teamId: string, userId: string) {
    assertAdmin(user);
    await this.db.$transaction(async (tx) => {
      const removed = await tx.teamMember.deleteMany({ where: { teamId, userId } });
      if (!removed.count) throw new NotFoundException('Membro não encontrado');
      await tx.auditLog.create({
        data: {
          userId: user.sub,
          eventType: 'INBOX_TEAM_MEMBER_REMOVED',
          entityType: 'team',
          entityId: teamId,
          previousData: { userId },
        },
      });
    });
  }
}

async function clearDefault(tx: Db): Promise<void> {
  await tx.team.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
}
