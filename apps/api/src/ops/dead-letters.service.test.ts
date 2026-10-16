import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { minimizeProcessingError } from './dead-letters.service.js';
import { metricsRedisConnection } from './ops-metrics.service.js';

describe('operação do inbox', () => {
  it('minimiza erro de processamento sem dígitos longos nem WAMID', () => {
    assert.equal(minimizeProcessingError(null), null);
    assert.equal(
      minimizeProcessingError(
        'Status para wamid.HBgNNTUxMTk5OTk5OTk5ORUCABEYEg== do 5511999999999',
      ),
      'Status para [wamid] do [digitos]',
    );
    assert.equal(minimizeProcessingError('x'.repeat(500))?.length, 200);
  });

  it('monta conexão de métricas que falha rápido', () => {
    const connection = metricsRedisConnection(
      'rediss://user:p%40ss@redis.internal:6380/2',
    ) as Record<string, unknown>;
    assert.equal(connection.host, 'redis.internal');
    assert.equal(connection.port, 6380);
    assert.equal(connection.username, 'user');
    assert.equal(connection.password, 'p@ss');
    assert.equal(connection.db, 2);
    assert.deepEqual(connection.tls, {});
    assert.equal(connection.enableOfflineQueue, false);
    assert.equal(connection.maxRetriesPerRequest, 1);
  });
});
