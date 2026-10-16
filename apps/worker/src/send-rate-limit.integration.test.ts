import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { acquireSendPermit, createRedisConnection, sendPermitKey } from '@confirma/queue';

/** Redis real (VPS). Pulado sem INTEGRATION_REDIS_URL. */
const redisUrl = process.env.INTEGRATION_REDIS_URL;

describe('limiter compartilhado (Redis)', { skip: !redisUrl }, () => {
  const phoneNumberId = `it-${randomUUID().slice(0, 8)}`;
  const connections = redisUrl
    ? [createRedisConnection(redisUrl), createRedisConnection(redisUrl)]
    : [];

  after(async () => {
    await connections[0]?.del(sendPermitKey(phoneNumberId));
    await Promise.all(connections.map((connection) => connection.quit()));
  });

  it('agrega o limite entre conexões (réplicas) na mesma janela', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        acquireSendPermit(connections[index % 2]!, phoneNumberId, {
          max: 5,
          durationMs: 2_000,
          maxWaitMs: 0,
        }),
      ),
    );
    assert.equal(results.filter((permit) => permit.granted).length, 5);
    for (const permit of results.filter((item) => !item.granted)) {
      assert.ok(permit.retryAfterMs > 0 && permit.retryAfterMs <= 2_000);
    }
  });

  it('concede de novo depois que a janela desliza', async () => {
    const permit = await acquireSendPermit(connections[0]!, phoneNumberId, {
      max: 5,
      durationMs: 2_000,
      maxWaitMs: 3_000,
    });
    assert.equal(permit.granted, true);
  });
});
