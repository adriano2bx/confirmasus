import { Module } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { DeadLettersService } from './dead-letters.service.js';
import { OpsMetricsService } from './ops-metrics.service.js';
import { OpsController } from './ops.controller.js';
import { OpsAdminGuard, OpsMetricsGuard } from './ops.guards.js';

/**
 * Observabilidade e operação do inbox (ADR-28/29): métricas Prometheus e dead-letter/replay.
 * Registrar em app.module.ts (coordenador). JwtModule é global (AuthModule).
 */
@Module({
  controllers: [OpsController],
  providers: [AuthGuard, OpsAdminGuard, OpsMetricsGuard, OpsMetricsService, DeadLettersService],
})
export class OpsModule {}
