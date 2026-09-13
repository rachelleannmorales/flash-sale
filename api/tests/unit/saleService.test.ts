import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SaleService } from '../../src/services/saleService.js';
import { PostgresStore } from '../../src/stores/postgresStore.js';
import { resolveDatabaseUrl, uniqueSaleId } from '../helpers/postgres.js';

const stores: PostgresStore[] = [];

async function build({
  stock = 5,
  startsAtOffsetMs = -1000,
  endsAtOffsetMs = 60_000,
}: {
  stock?: number;
  startsAtOffsetMs?: number;
  endsAtOffsetMs?: number;
} = {}) {
  const now = Date.now();
  const saleId = uniqueSaleId('svc');
  const store = new PostgresStore(process.env.DATABASE_URL!, saleId, 5);
  stores.push(store);
  await store.init({
    saleId,
    totalStock: stock,
    remaining: stock,
    startsAt: now + startsAtOffsetMs,
    endsAt: now + endsAtOffsetMs,
  });
  return { store, service: new SaleService(store) };
}

describe('SaleService', () => {
  beforeAll(async () => {
    await resolveDatabaseUrl();
  });

  afterAll(async () => {
    await Promise.all(stores.map(async (s) => {
      await s._reset();
      await s.close();
    }));
  });

  it('reports upcoming before start', async () => {
    const { service } = await build({ startsAtOffsetMs: 10_000 });
    expect((await service.getStatus()).state).toBe('upcoming');
  });

  it('reports active during window with stock', async () => {
    const { service } = await build();
    expect((await service.getStatus()).state).toBe('active');
  });

  it('reports ended after end time', async () => {
    const { service } = await build({ startsAtOffsetMs: -60_000, endsAtOffsetMs: -1_000 });
    expect((await service.getStatus()).state).toBe('ended');
  });

  it('reports sold_out when remaining is 0', async () => {
    const { service, store } = await build({ stock: 1 });
    await store.attemptPurchase('a');
    expect((await service.getStatus()).state).toBe('sold_out');
  });

  it('rejects purchases before start', async () => {
    const { service } = await build({ startsAtOffsetMs: 10_000 });
    expect(await service.attemptPurchase('a')).toEqual({ status: 'not_started' });
  });

  it('rejects purchases after end', async () => {
    const { service } = await build({ startsAtOffsetMs: -60_000, endsAtOffsetMs: -1_000 });
    expect(await service.attemptPurchase('a')).toEqual({ status: 'ended' });
  });

  it('reflects the database clock in getStatus.now', async () => {
    const { service } = await build();
    const now = Date.parse((await service.getStatus()).now);
    expect(Math.abs(now - Date.now())).toBeLessThan(60_000);
  });

  it('exposes ping() from the underlying store', async () => {
    const { service } = await build();
    expect(await service.ping()).toBe(true);
  });
});
