import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { isValidOpsToken } from './ops-token.js';

async function requireAdministrator(
  authGuard: Pick<CanActivate, 'canActivate'>,
  context: ExecutionContext,
): Promise<true> {
  await authGuard.canActivate(context);
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (request.user?.role !== 'ADMIN') {
    throw new ForbiddenException('Operação exclusiva do administrador');
  }
  return true;
}

/** Endpoints operacionais: somente ADMIN autenticado. */
@Injectable()
export class OpsAdminGuard implements CanActivate {
  constructor(private readonly authGuard: AuthGuard) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    return requireAdministrator(this.authGuard, context);
  }
}

/**
 * /api/ops/metrics: `Authorization: Bearer <OPS_METRICS_TOKEN>` (coletor Prometheus) OU
 * sessão ADMIN. Token ausente/curto no ambiente desabilita o acesso por token.
 */
@Injectable()
export class OpsMetricsGuard implements CanActivate {
  constructor(private readonly authGuard: AuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (isValidOpsToken(request.headers.authorization)) return true;
    return requireAdministrator(this.authGuard, context);
  }
}
