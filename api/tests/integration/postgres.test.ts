import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '../../src/stores/postgresStore.js';
import { resolveDatabaseUrl, runPooled, uniqueSaleId } from '../helpers/postgres.js';

let DATABASE_URL: string;

describe('PostgresStore', () => {
  const saleId = uniqueSaleId('test');
  const STOCK = 200;
  const START = Date.now() - 1000;
  const END = Date.now() + 60_000;
  let store: PostgresStore;

  beforeAll(async () => {
    DATABASE_URL = await resolveDatabaseUrl();
    store = new PostgresStore(DATABASE_URL, saleId, 20);
    await store.init({
      saleId,
      totalStock: STOCK,
      remaining: STOCK,
      startsAt: START,
      endsAt: END,
    });
  });

  afterAll(async () => {
    await store._reset();
    await store.close();
  });

  it('never oversells across a highly concurrent burst', async () => {
    const USERS = 1000;
    const results = await runPooled(
      Array.from({ length: USERS }, (_, i) => () => store.attemptPurchase(`user-${i}`)),
      20,
    );
    const successes = results.filter((r) => r.status === 'ok').length;
    const soldOut = results.filter((r) => r.status === 'sold_out').length;
    expect(successes).toBe(STOCK);
    expect(successes + soldOut).toBe(USERS);
    expect((await store.getSnapshot()).remaining).toBe(0);
  });

  it('enforces one-item-per-user under a burst from a single user', async () => {
    const results = await runPooled(
      Array.from({ length: 200 }, () => () => store.attemptPurchase('single-buyer')),
      20,
    );
    expect(results.filter((r) => r.status === 'ok').length).toBe(0);
  });

  it('does not refill stock on a second init (restart safety)', async () => {
    await store.init({
      saleId,
      totalStock: STOCK,
      remaining: STOCK,
      startsAt: START,
      endsAt: END,
    });
    expect((await store.getSnapshot()).remaining).toBe(0);
  });

  it('applies a new SALE_START/SALE_END on re-init without refilling stock', async () => {
    const newStart = START - 30_000;
    const newEnd = END + 120_000;
    await store.init({
      saleId,
      totalStock: STOCK,
      remaining: STOCK,
      startsAt: newStart,
      endsAt: newEnd,
    });
    const snap = await store.getSnapshot();
    expect(snap.remaining).toBe(0);
    expect(Math.abs(snap.startsAt - newStart)).toBeLessThan(1000);
    expect(Math.abs(snap.endsAt - newEnd)).toBeLessThan(1000);
  });

  it('pings healthy against a running Postgres', async () => {
    expect(await store.ping()).toBe(true);
  });

  it('now() returns database time, not process time', async () => {
    const dbNow = await store.now();
    expect(Math.abs(dbNow - Date.now())).toBeLessThan(60_000);
  });
});

describe('PostgresStore window uses database NOW(), not the caller clock', () => {
  const stores: PostgresStore[] = [];

  beforeAll(async () => {
    DATABASE_URL = await resolveDatabaseUrl();
  });

  afterAll(async () => {
    await Promise.all(stores.map(async (s) => {
      await s._reset();
      await s.close();
    }));
  });

  it('rejects purchases before the sale window opens', async () => {
    const now = Date.now();
    const saleId = `early-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const s = new PostgresStore(DATABASE_URL, saleId, 5);
    stores.push(s);
    await s.init({
      saleId,
      totalStock: 10,
      remaining: 10,
      startsAt: now + 60_000,
      endsAt: now + 120_000,
    });
    const r = await s.attemptPurchase('early-bird');
    expect(r).toEqual({ status: 'not_started' });
  });

  it('rejects purchases after the window closes', async () => {
    const now = Date.now();
    const saleId = `late-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const s = new PostgresStore(DATABASE_URL, saleId, 5);
    stores.push(s);
    await s.init({
      saleId,
      totalStock: 10,
      remaining: 10,
      startsAt: now - 120_000,
      endsAt: now - 60_000,
    });
    const r = await s.attemptPurchase('latecomer');
    expect(r).toEqual({ status: 'ended' });
  });
});

describe('PostgresStore defense-in-depth: schema enforces one-per-user', () => {
  const stores: PostgresStore[] = [];

  beforeAll(async () => {
    DATABASE_URL = await resolveDatabaseUrl();
  });

  afterAll(async () => {
    await Promise.all(stores.map(async (s) => {
      await s._reset();
      await s.close();
    }));
  });

  it('UNIQUE (sale_id, user_id) rejects duplicate purchases at the DB level (23505)', async () => {
    const now = Date.now();
    const saleId = `unique-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const s = new PostgresStore(DATABASE_URL, saleId, 5);
    stores.push(s);
    await s.init({
      saleId,
      totalStock: 5,
      remaining: 5,
      startsAt: now - 1000,
      endsAt: now + 60_000,
    });

    const pool = s._pool();
    await pool.query('INSERT INTO purchases (sale_id, user_id) VALUES ($1, $2)', [saleId, 'dup']);

    await expect(
      pool.query('INSERT INTO purchases (sale_id, user_id) VALUES ($1, $2)', [saleId, 'dup']),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
