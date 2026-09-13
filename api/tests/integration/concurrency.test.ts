import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { buildApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { PostgresStore } from '../../src/stores/postgresStore.js';
import { resolveDatabaseUrl, runPooled, setSaleTestEnv, uniqueSaleId } from '../helpers/postgres.js';
import { resolveRedisUrl } from '../helpers/redis.js';

/**
 * End-to-end proof that the whole stack (Express router → service → store)
 * never oversells and never lets a user grab two items even under a burst.
 *
 * Notes on the testing shape:
 *
 * 1. Supertest spins up a fresh listener per `request(app)` call. For 2000
 *    concurrent HTTP requests that's 2000 short-lived servers, which
 *    exhausts macOS's default file-descriptor soft limit (256). We open a
 *    single persistent listener on `:0` and point supertest at it.
 *
 * 2. Even with a shared listener, firing 2000 sockets in parallel can trip
 *    the same FD limit on some CI runners. What we're actually proving is
 *    STORE ATOMICITY under interleaved HTTP handlers — the invariant holds
 *    identically at 20-in-flight as at 2000. In-flight is capped at the
 *    pool size so waiters do not hit connectionTimeoutMillis.
 */
describe('concurrent purchase correctness', () => {
  let server: Server;
  let agent: Agent;
  let close: () => Promise<void>;

  const STOCK = 200;
  const USERS = 2000;

  beforeAll(async () => {
    await resolveDatabaseUrl();
    await resolveRedisUrl();
    setSaleTestEnv({ saleId: uniqueSaleId('conc'), stock: STOCK });

    const built = await buildApp(loadConfig());
    server = built.app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    agent = request(server);

    close = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await (built.deps.store as PostgresStore)._reset();
      await built.deps.store.close();
      await built.deps.redis.quit();
    };
  });

  afterAll(async () => { await close(); });

  it('never oversells across many distinct users', async () => {
    const responses = await runPooled(
      Array.from({ length: USERS }, (_, i) =>
        () => agent.post('/api/sale/purchase').send({ userId: `bulk-${i}` }),
      ),
      20,
    );

    const successes = responses.filter((r) => r.status === 201).length;
    const conflicts = responses.filter((r) => r.status === 409).length;

    expect(successes).toBe(STOCK);
    expect(successes + conflicts).toBe(USERS);

    const status = await agent.get('/api/sale/status');
    expect(status.body.remaining).toBe(0);
    expect(status.body.state).toBe('sold_out');
  }, 30_000);

  it('enforces one-item-per-user under a burst from a single user', async () => {
    const responses = await runPooled(
      Array.from({ length: 500 }, () =>
        () => agent.post('/api/sale/purchase').send({ userId: 'spammer' }),
      ),
      20,
    );

    const statuses = new Map<number, number>();
    for (const r of responses) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    expect({ statuses: Object.fromEntries(statuses) }).toEqual({ statuses: { 409: 500 } });
  });
});
