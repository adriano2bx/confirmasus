import {
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { DeadLettersService } from './dead-letters.service.js';
import { OpsMetricsService } from './ops-metrics.service.js';
import { OpsAdminGuard, OpsMetricsGuard } from './ops.guards.js';
import { PROMETHEUS_CONTENT_TYPE } from './prometheus.js';

@Controller('ops')
export class OpsController {
  constructor(
    private readonly metrics: OpsMetricsService,
    private readonly deadLetters: DeadLettersService,
  ) {}

  @Get('metrics')
  @UseGuards(OpsMetricsGuard)
  @Header('Content-Type', PROMETHEUS_CONTENT_TYPE)
  @Header('Cache-Control', 'no-store')
  renderMetrics(): Promise<string> {
    return this.metrics.render();
  }

  @Get('dead-letters')
  @UseGuards(OpsAdminGuard)
  listDeadLetters(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.deadLetters.list(Math.max(1, page), Math.min(Math.max(1, limit), 100));
  }

  @Post('dead-letters/:id/replay')
  @HttpCode(200)
  @UseGuards(OpsAdminGuard)
  replayDeadLetter(@Param('id', ParseUUIDPipe) id: string, @Req() request: AuthenticatedRequest) {
    return this.deadLetters.replay(id, request.user!.sub);
  }
}
