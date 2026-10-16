import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { AuthGuard, AuthenticatedRequest } from '../auth/auth.guard.js';
import { bearerToken, configuredOpsToken, isValidOpsToken } from './ops-token.js';
import { OpsAdminGuard, OpsMetricsGuard } from './ops.guards.js';

const TOKEN = 'token-de-metricas-com-tamanho-suficiente';
const originalToken = process.env.OPS_METRICS_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.OPS_METRICS_TOKEN;
  else process.env.OPS_METRICS_TOKEN = originalToken;
});

function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function fakeAuthGuard(role: 'ADMIN' | 'OPERATOR' | null): {
  guard: AuthGuard;
  calls: () => number;
} {
  let calls = 0;
  const guard = {
    async canActivate(context: ExecutionContext) {
      calls += 1;
      if (!role) throw new UnauthorizedException('Autenticação obrigatória');
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      request.user = { sub: 'user-1', email: 'admin@example.test', role };
      return true;
    },
  } as unknown as AuthGuard;
  return { guard, calls: () => calls };
}

describe('autorização por OPS_METRICS_TOKEN', () => {
  it('aceita somente Bearer igual ao token configurado', () => {
    assert.equal(isValidOpsToken(`Bearer ${TOKEN}`, TOKEN), true);
    assert.equal(isValidOpsToken(`bearer ${TOKEN}`, TOKEN), true);
    assert.equal(isValidOpsToken(`Bearer ${TOKEN}x`, TOKEN), false);
    assert.equal(isValidOpsToken(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN), false);
    assert.equal(isValidOpsToken(TOKEN, TOKEN), false);
    assert.equal(isValidOpsToken(undefined, TOKEN), false);
    assert.equal(isValidOpsToken('Bearer ', TOKEN), false);
  });

  it('token vazio ou curto desabilita o acesso por token', () => {
    delete process.env.OPS_METRICS_TOKEN;
    assert.equal(configuredOpsToken(''), null);
    assert.equal(configuredOpsToken('   '), null);
    assert.equal(configuredOpsToken('curto'), null);
    assert.equal(configuredOpsToken(undefined), null);
    assert.equal(configuredOpsToken(TOKEN), TOKEN);
    assert.equal(isValidOpsToken('Bearer ', null), false);
    assert.equal(isValidOpsToken(`Bearer ${TOKEN}`, null), false);
  });

  it('extrai bearer de cabeçalho simples ou repetido', () => {
    assert.equal(bearerToken('Bearer abc'), 'abc');
    assert.equal(bearerToken(['Bearer abc', 'Bearer def']), 'abc');
    assert.equal(bearerToken('Basic abc'), null);
    assert.equal(bearerToken('Bearer a b'), null);
  });

  it('guard de métricas libera token válido sem consultar sessão', async () => {
    process.env.OPS_METRICS_TOKEN = TOKEN;
    const auth = fakeAuthGuard(null);
    const guard = new OpsMetricsGuard(auth.guard);
    assert.equal(
      await guard.canActivate(contextFor({ headers: { authorization: `Bearer ${TOKEN}` } })),
      true,
    );
    assert.equal(auth.calls(), 0);
  });

  it('guard de métricas exige ADMIN quando o token não confere ou está desabilitado', async () => {
    process.env.OPS_METRICS_TOKEN = TOKEN;
    const admin = fakeAuthGuard('ADMIN');
    assert.equal(
      await new OpsMetricsGuard(admin.guard).canActivate(
        contextFor({ headers: { authorization: 'Bearer errado' } }),
      ),
      true,
    );
    assert.equal(admin.calls(), 1);

    await assert.rejects(
      new OpsMetricsGuard(fakeAuthGuard('OPERATOR').guard).canActivate(contextFor({ headers: {} })),
      ForbiddenException,
    );
    await assert.rejects(
      new OpsMetricsGuard(fakeAuthGuard(null).guard).canActivate(contextFor({ headers: {} })),
      UnauthorizedException,
    );

    process.env.OPS_METRICS_TOKEN = '';
    await assert.rejects(
      new OpsMetricsGuard(fakeAuthGuard(null).guard).canActivate(
        contextFor({ headers: { authorization: 'Bearer ' } }),
      ),
      UnauthorizedException,
    );
  });

  it('dead-letters aceitam somente ADMIN, nunca o token de métricas', async () => {
    process.env.OPS_METRICS_TOKEN = TOKEN;
    await assert.rejects(
      new OpsAdminGuard(fakeAuthGuard(null).guard).canActivate(
        contextFor({ headers: { authorization: `Bearer ${TOKEN}` } }),
      ),
      UnauthorizedException,
    );
    await assert.rejects(
      new OpsAdminGuard(fakeAuthGuard('OPERATOR').guard).canActivate(contextFor({ headers: {} })),
      ForbiddenException,
    );
    assert.equal(
      await new OpsAdminGuard(fakeAuthGuard('ADMIN').guard).canActivate(
        contextFor({ headers: {} }),
      ),
      true,
    );
  });
});
