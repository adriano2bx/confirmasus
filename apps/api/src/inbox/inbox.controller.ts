import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import {
  AddTeamMemberDto,
  AssignConversationDto,
  ContactOptOutDto,
  CreateNoteDto,
  CreateTeamDto,
  LinkContextDto,
  ListConversationsQueryDto,
  MarkReadDto,
  ResumeAutomationDto,
  SendHumanMessageDto,
  TimelineQueryDto,
  TransferConversationDto,
  UpdateConversationPriorityDto,
  UpdateConversationStatusDto,
  UpdateTeamDto,
  VersionDto,
} from './inbox.dto.js';
import { parseStreamCursor } from './inbox.helpers.js';
import { InboxActionsService } from './inbox-actions.service.js';
import { InboxQueryService } from './inbox-query.service.js';
import { InboxStreamService } from './inbox-stream.service.js';
import type { RequestUser } from './inbox-summary.js';
import { InboxTeamsService } from './inbox-teams.service.js';

function currentUser(request: AuthenticatedRequest): RequestUser {
  if (!request.user) throw new UnauthorizedException('Autenticação obrigatória');
  return { sub: request.user.sub, role: request.user.role };
}

/** Prefixo final: /api/inbox. Autorização por conversa/equipe nos serviços (RBAC server-side). */
@Controller('inbox')
@UseGuards(AuthGuard)
export class InboxController {
  constructor(
    private readonly query: InboxQueryService,
    private readonly actions: InboxActionsService,
    private readonly teams: InboxTeamsService,
    private readonly stream: InboxStreamService,
  ) {}

  @Get('me') me(@Req() request: AuthenticatedRequest) {
    return this.query.me(currentUser(request));
  }

  @Get('conversations')
  list(@Req() request: AuthenticatedRequest, @Query() input: ListConversationsQueryDto) {
    return this.query.list(currentUser(request), input);
  }

  @Get('conversations/:id')
  detail(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.query.detail(currentUser(request), id);
  }

  @Get('conversations/:id/timeline')
  timeline(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() input: TimelineQueryDto,
  ) {
    return this.query.timeline(currentUser(request), id, input);
  }

  @Post('conversations/:id/claim')
  @HttpCode(200)
  claim(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: VersionDto,
  ) {
    return this.actions.claim(currentUser(request), id, input.version);
  }

  @Post('conversations/:id/assign')
  @HttpCode(200)
  assign(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: AssignConversationDto,
  ) {
    return this.actions.assign(currentUser(request), id, input);
  }

  @Post('conversations/:id/transfer')
  @HttpCode(200)
  transfer(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: TransferConversationDto,
  ) {
    return this.actions.transfer(currentUser(request), id, input);
  }

  @Post('conversations/:id/status')
  @HttpCode(200)
  status(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateConversationStatusDto,
  ) {
    return this.actions.updateStatus(currentUser(request), id, input);
  }

  @Post('conversations/:id/priority')
  @HttpCode(200)
  priority(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateConversationPriorityDto,
  ) {
    return this.actions.updatePriority(currentUser(request), id, input);
  }

  @Post('conversations/:id/messages')
  @HttpCode(202)
  sendMessage(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: SendHumanMessageDto,
  ) {
    return this.actions.sendMessage(currentUser(request), id, input);
  }

  @Post('conversations/:id/notes')
  @HttpCode(201)
  addNote(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CreateNoteDto,
  ) {
    return this.actions.addNote(currentUser(request), id, input);
  }

  @Post('conversations/:id/contexts')
  @HttpCode(201)
  async linkContext(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: LinkContextDto,
  ) {
    await this.actions.linkContext(currentUser(request), id, input);
  }

  @Delete('conversations/:id/contexts/:convocationId')
  @HttpCode(204)
  async unlinkContext(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('convocationId', ParseUUIDPipe) convocationId: string,
  ) {
    await this.actions.unlinkContext(currentUser(request), id, convocationId);
  }

  @Get('conversations/:id/automation')
  automation(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.query.automation(currentUser(request), id);
  }

  @Post('conversations/:id/automation/resume')
  @HttpCode(200)
  resumeAutomation(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ResumeAutomationDto,
  ) {
    return this.actions.resumeAutomation(currentUser(request), id, input);
  }

  @Post('conversations/:id/read')
  @HttpCode(204)
  async markRead(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: MarkReadDto,
  ) {
    await this.query.markRead(currentUser(request), id, input);
  }

  @Post('contacts/:id/opt-out')
  @HttpCode(204)
  async optOut(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ContactOptOutDto,
  ) {
    await this.actions.setOptOut(currentUser(request), id, input);
  }

  @Get('teams') listTeams(@Req() request: AuthenticatedRequest) {
    return this.teams.list(currentUser(request));
  }

  @Post('teams')
  createTeam(@Req() request: AuthenticatedRequest, @Body() input: CreateTeamDto) {
    return this.teams.create(currentUser(request), input);
  }

  @Patch('teams/:id')
  updateTeam(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateTeamDto,
  ) {
    return this.teams.update(currentUser(request), id, input);
  }

  @Post('teams/:id/members')
  addMember(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: AddTeamMemberDto,
  ) {
    return this.teams.addMember(currentUser(request), id, input);
  }

  @Delete('teams/:id/members/:userId')
  @HttpCode(204)
  async removeMember(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.teams.removeMember(currentUser(request), id, userId);
  }

  /** SSE: só tipo/IDs, filtrado pelas equipes visíveis. Cliente reconecta com Last-Event-ID. */
  @Get('stream')
  async openStream(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Query('cursor') cursor: string | undefined,
  ) {
    const requested = parseStreamCursor(lastEventId ?? cursor);
    const actor = await this.query.actor(currentUser(request));
    await this.stream.open(request, response, actor, requested);
  }
}
