import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { PostgresStore } from '../../src/stores/postgresStore.js';
import { resolveDatabaseUrl, setSaleTestEnv, uniqueSaleId } from '../helpers/postgres.js';
import { resolveRedisUrl } from '../helpers/redis.js';

/**
 * Rate limiter keys per-user (not per-IP) and counts in Redis so N API
 * processes share one budget. In-memory express-rate-limit would give each
 * pod its own RATE_LIMIT_MAX.
 */
describe('rate limiter is per-user and shared across processes', () => {
  let agentA: Agent;
  let agentB: Agent;
  let close: () => Promise<void>;

  const MAX = 3;

  beforeAll(async () => {
    await resolveDatabaseUrl();
    await resolveRedisUrl();
    setSaleTestEnv({
      saleId: uniqueSaleId('rl'),
      stock: 1000,
      rateLimitMax: String(MAX),
    });

    const config = loadConfig();
    const builtA = await buildApp(config);
    const builtB = await buildApp(config);
    agentA = request(builtA.app);
    agentB = request(builtB.app);
    close = async () => {
      await (builtA.deps.store as PostgresStore)._reset();
      await builtA.deps.store.close();
      await builtB.deps.store.close();
      await builtA.deps.redis.quit();
      await builtB.deps.redis.quit();
    };
  });

  afterAll(async () => { if (close) await close(); });

  it('a second user (same connection/IP) is NOT starved by the first user spamming', async () => {
    let firstUserLimited = false;
    for (let i = 0; i < MAX + 5; i++) {
      const r = await agentA.post('/api/sale/purchase').send({ userId: 'rl-userA' });
      if (r.status === 429) firstUserLimited = true;
    }
    expect(firstUserLimited).toBe(true);

    const rB = await agentA.post('/api/sale/purchase').send({ userId: 'rl-userB' });
    expect(rB.status).not.toBe(429);
  });

  it('two API processes share one budget for the same user', async () => {
    const userId = 'rl-shared';
    expect((await agentA.post('/api/sale/purchase').send({ userId })).status).not.toBe(429);
    expect((await agentA.post('/api/sale/purchase').send({ userId })).status).not.toBe(429);
    expect((await agentB.post('/api/sale/purchase').send({ userId })).status).not.toBe(429);

    const fourth = await agentB.post('/api/sale/purchase').send({ userId });
    expect(fourth.status).toBe(429);
    expect(fourth.body).toEqual({ error: 'rate_limited' });
  });
});
