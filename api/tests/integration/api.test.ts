import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import type { Express } from 'express';
import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { PostgresStore } from '../../src/stores/postgresStore.js';
import { resolveDatabaseUrl, setSaleTestEnv, uniqueSaleId } from '../helpers/postgres.js';
import { resolveRedisUrl } from '../helpers/redis.js';

describe('flash-sale API (integration, Postgres)', () => {
  let app: Express;
  let agent: Agent;
  let close: () => Promise<void>;

  const STOCK = 100;

  beforeAll(async () => {
    await resolveDatabaseUrl();
    await resolveRedisUrl();
    setSaleTestEnv({
      saleId: uniqueSaleId('it'),
      stock: STOCK,
      rateLimitMax: '100000',
    });

    const config = loadConfig();
    const built = await buildApp(config);
    app = built.app;
    agent = request(app);
    close = async () => {
      await (built.deps.store as PostgresStore)._reset();
      await built.deps.store.close();
      await built.deps.redis.quit();
    };
  });

  afterAll(async () => { await close(); });

  it('GET /livez', async () => {
    const r = await agent.get('/livez');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('GET /readyz reports true when the store is up', async () => {
    const r = await agent.get('/readyz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('every response includes an x-request-id header', async () => {
    const r = await agent.get('/livez');
    expect(r.headers['x-request-id']).toBeTruthy();
  });

  it('passes through an inbound x-request-id', async () => {
    const r = await agent.get('/livez').set('x-request-id', 'client-trace-42');
    expect(r.headers['x-request-id']).toBe('client-trace-42');
  });

  it('GET /api/sale/status returns active with full stock', async () => {
    const r = await agent.get('/api/sale/status');
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('active');
    expect(r.body.remaining).toBe(STOCK);
  });

  it('POST /api/sale/purchase returns 201 for a new user', async () => {
    const r = await agent
      .post('/api/sale/purchase')
      .send({ userId: 'first-user' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('ok');
  });

  it('POST /api/sale/purchase returns 409 already_purchased on second attempt', async () => {
    await agent.post('/api/sale/purchase').send({ userId: 'twice' });
    const r = await agent.post('/api/sale/purchase').send({ userId: 'twice' });
    expect(r.status).toBe(409);
    expect(r.body.status).toBe('already_purchased');
  });

  it('POST /api/sale/purchase rejects missing or empty userId with 400', async () => {
    const empty = await agent.post('/api/sale/purchase').send({ userId: '' });
    expect(empty.status).toBe(400);
    const missing = await agent.post('/api/sale/purchase').send({});
    expect(missing.status).toBe(400);
  });

  it('POST /api/sale/purchase rejects additional properties', async () => {
    const r = await agent
      .post('/api/sale/purchase')
      .send({ userId: 'someone', extra: 'nope' });
    expect(r.status).toBe(400);
  });

  it('POST /api/sale/purchase rejects malformed JSON', async () => {
    const r = await agent
      .post('/api/sale/purchase')
      .set('content-type', 'application/json')
      .send('{"userId":');
    expect(r.status).toBe(400);
  });

  it('GET /api/sale/purchase/:userId reflects whether a user has bought', async () => {
    await agent.post('/api/sale/purchase').send({ userId: 'check-user' });
    const yes = await agent.get('/api/sale/purchase/check-user');
    expect(yes.body.purchased).toBe(true);
    const no = await agent.get('/api/sale/purchase/someone-else');
    expect(no.body.purchased).toBe(false);
  });

  it('GET unknown route → 404', async () => {
    const r = await agent.get('/nope');
    expect(r.status).toBe(404);
  });
});
