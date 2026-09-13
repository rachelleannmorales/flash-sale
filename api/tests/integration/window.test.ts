import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { PostgresStore } from '../../src/stores/postgresStore.js';
import { resolveDatabaseUrl, setSaleTestEnv, uniqueSaleId } from '../helpers/postgres.js';
import { resolveRedisUrl } from '../helpers/redis.js';

/**
 * Window check lives in the store (database NOW()), not the service.
 * We can't freeze Postgres time, so these hit clearly-before / clearly-after
 * windows rather than the exact millisecond boundary.
 */
describe('sale window is enforced against database NOW()', () => {
  beforeAll(async () => {
    await resolveDatabaseUrl();
    await resolveRedisUrl();
  });

  describe('before the window opens', () => {
    let agent: Agent;
    let close: () => Promise<void>;

    beforeAll(async () => {
      setSaleTestEnv({
        saleId: uniqueSaleId('win-early'),
        stock: 5,
        startOffsetMs: 60_000,
        endOffsetMs: 120_000,
      });
      const built = await buildApp(loadConfig());
      agent = request(built.app);
      close = async () => {
        await (built.deps.store as PostgresStore)._reset();
        await built.deps.store.close();
        await built.deps.redis.quit();
      };
    });

    afterAll(async () => { await close(); });

    it('rejects with not_started', async () => {
      const r = await agent.post('/api/sale/purchase').send({ userId: 'boundary-early' });
      expect(r.status).toBe(409);
      expect(r.body.status).toBe('not_started');
    });
  });

  describe('during the window', () => {
    let agent: Agent;
    let close: () => Promise<void>;

    beforeAll(async () => {
      setSaleTestEnv({
        saleId: uniqueSaleId('win-open'),
        stock: 5,
        startOffsetMs: -1_000,
        endOffsetMs: 60_000,
      });
      const built = await buildApp(loadConfig());
      agent = request(built.app);
      close = async () => {
        await (built.deps.store as PostgresStore)._reset();
        await built.deps.store.close();
        await built.deps.redis.quit();
      };
    });

    afterAll(async () => { await close(); });

    it('accepts a first-time purchase', async () => {
      const r = await agent.post('/api/sale/purchase').send({ userId: 'boundary-open' });
      expect(r.status).toBe(201);
    });
  });

  describe('after the window closes', () => {
    let agent: Agent;
    let close: () => Promise<void>;

    beforeAll(async () => {
      setSaleTestEnv({
        saleId: uniqueSaleId('win-late'),
        stock: 5,
        startOffsetMs: -120_000,
        endOffsetMs: -60_000,
      });
      const built = await buildApp(loadConfig());
      agent = request(built.app);
      close = async () => {
        await (built.deps.store as PostgresStore)._reset();
        await built.deps.store.close();
        await built.deps.redis.quit();
      };
    });

    afterAll(async () => { await close(); });

    it('rejects with ended', async () => {
      const r = await agent.post('/api/sale/purchase').send({ userId: 'boundary-late' });
      expect(r.status).toBe(409);
      expect(r.body.status).toBe('ended');
    });
  });
});
