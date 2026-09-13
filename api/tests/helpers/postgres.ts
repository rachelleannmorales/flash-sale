import pg from 'pg';

const DEFAULTS = [
  'postgres://flash:flash@127.0.0.1:5432/flashsale',
  'postgres://flash:flash@127.0.0.1:5433/flashsale',
];

async function reachable(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 500 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch {
    try { await client.end(); } catch { /* noop */ }
    return false;
  }
}

/**
 * Resolve a live Postgres URL. Honours `DATABASE_URL` when set; otherwise
 * tries the CI default (:5432) then the Compose host port (:5433).
 */
export async function resolveDatabaseUrl(): Promise<string> {
  if (process.env.DATABASE_URL) {
    if (await reachable(process.env.DATABASE_URL)) return process.env.DATABASE_URL;
    throw new Error(
      `DATABASE_URL is set but Postgres is not reachable at ${process.env.DATABASE_URL}.\n` +
        'Start it with: docker compose up -d postgres',
    );
  }
  for (const url of DEFAULTS) {
    if (await reachable(url)) {
      process.env.DATABASE_URL = url;
      return url;
    }
  }
  throw new Error(
    'Postgres is required for the test suite.\n' +
      '  docker compose up -d postgres\n' +
      '  DATABASE_URL=postgres://flash:flash@127.0.0.1:5433/flashsale npm test',
  );
}

export function uniqueSaleId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Env that `loadConfig()` + `buildApp()` need for an isolated test sale. */
export function setSaleTestEnv(opts: {
  saleId: string;
  stock: number;
  startOffsetMs?: number;
  endOffsetMs?: number;
  rateLimitMax?: string;
}): void {
  const now = Date.now();
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  process.env.SALE_ID = opts.saleId;
  process.env.TOTAL_STOCK = String(opts.stock);
  process.env.SALE_START = String(now + (opts.startOffsetMs ?? -1_000));
  process.env.SALE_END = String(now + (opts.endOffsetMs ?? 5 * 60_000));
  process.env.RATE_LIMIT_MAX = opts.rateLimitMax ?? '1000000';
  process.env.RATE_LIMIT_WINDOW = '1 minute';
  process.env.DATABASE_POOL_MAX = '20';
}

/** Run `tasks` with at most `concurrency` in flight. */
export async function runPooled<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]!();
    }
  });
  await Promise.all(workers);
  return results;
}
