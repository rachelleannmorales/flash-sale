import pg from 'pg';
import type { PurchaseOutcome, SaleSnapshot, Store } from './types.js';

const { Pool } = pg;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sales (
  sale_id     TEXT PRIMARY KEY,
  total_stock INTEGER NOT NULL CHECK (total_stock >= 1),
  remaining   INTEGER NOT NULL CHECK (remaining >= 0),
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK (remaining <= total_stock)
);

CREATE TABLE IF NOT EXISTS purchases (
  sale_id      TEXT NOT NULL REFERENCES sales (sale_id),
  user_id      TEXT NOT NULL,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sale_id, user_id)
);
`;

/**
 * Deterministic key for the schema-migration advisory lock. 
 */
const SCHEMA_LOCK_KEY = 4_919_170_927n;

export class PostgresStore implements Store {
  private readonly pool: pg.Pool;
  private readonly saleId: string;

  constructor(databaseUrl: string, saleId: string, poolMax = 20) {
    this.saleId = saleId;
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: poolMax,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
      options:
        '-c statement_timeout=3000ms ' +
        '-c lock_timeout=5000ms ' +
        '-c idle_in_transaction_session_timeout=10000ms',
    });

    this.pool.on('error', (err) => {
      console.error({ err, saleId: this.saleId }, 'postgres idle client error');
    });
  }

  async init(snapshot: SaleSnapshot): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY.toString()]);
      await client.query(SCHEMA_SQL);
      await client.query(
        `INSERT INTO sales (sale_id, total_stock, remaining, starts_at, ends_at)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0))
         ON CONFLICT (sale_id) DO UPDATE SET
           starts_at = EXCLUDED.starts_at,
           ends_at   = EXCLUDED.ends_at`,
        [snapshot.saleId, snapshot.totalStock, snapshot.totalStock, snapshot.startsAt, snapshot.endsAt],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getSnapshot(): Promise<SaleSnapshot> {
    const { rows } = await this.pool.query<{
      sale_id: string;
      total_stock: number;
      remaining: number;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT sale_id, total_stock, remaining, starts_at, ends_at
       FROM sales WHERE sale_id = $1`,
      [this.saleId],
    );
    const row = rows[0];
    if (!row) {
      return {
        saleId: this.saleId,
        totalStock: 0,
        remaining: 0,
        startsAt: 0,
        endsAt: 0,
      };
    }
    return {
      saleId: row.sale_id,
      totalStock: row.total_stock,
      remaining: row.remaining,
      startsAt: row.starts_at.getTime(),
      endsAt: row.ends_at.getTime(),
    };
  }

  async attemptPurchase(userId: string): Promise<PurchaseOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const locked = await client.query<{
        remaining: number;
        starts_at: Date;
        ends_at: Date;
        now_ms: string;
      }>(
        `SELECT remaining, starts_at, ends_at,
                (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS now_ms
         FROM sales
         WHERE sale_id = $1
         FOR UPDATE`,
        [this.saleId],
      );

      const sale = locked.rows[0];
      if (!sale) {
        await client.query('ROLLBACK');
        throw new Error(`sale ${this.saleId} is not initialised`);
      }

      const now = Number(sale.now_ms);
      const startsAt = sale.starts_at.getTime();
      const endsAt = sale.ends_at.getTime();

      if (now < startsAt) {
        await client.query('ROLLBACK');
        return { status: 'not_started' };
      }
      if (now >= endsAt) {
        await client.query('ROLLBACK');
        return { status: 'ended' };
      }

      const existing = await client.query(
        `SELECT 1 FROM purchases WHERE sale_id = $1 AND user_id = $2`,
        [this.saleId, userId],
      );
      if ((existing.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return { status: 'already_purchased' };
      }

      if (sale.remaining <= 0) {
        await client.query('ROLLBACK');
        return { status: 'sold_out' };
      }

      const updated = await client.query<{ remaining: number }>(
        `UPDATE sales
         SET remaining = remaining - 1
         WHERE sale_id = $1 AND remaining > 0
         RETURNING remaining`,
        [this.saleId],
      );
      const remaining = updated.rows[0]?.remaining;
      if (remaining === undefined) {
        await client.query('ROLLBACK');
        return { status: 'sold_out' };
      }

      await client.query(
        `INSERT INTO purchases (sale_id, user_id) VALUES ($1, $2)`,
        [this.saleId, userId],
      );

      await client.query('COMMIT');
      return { status: 'ok', remaining };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      // 23505 = unique_violation
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
        return { status: 'already_purchased' };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async hasPurchased(userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM purchases WHERE sale_id = $1 AND user_id = $2`,
      [this.saleId, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  async now(): Promise<number> {
    const { rows } = await this.pool.query<{ now_ms: string }>(
      'SELECT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS now_ms',
    );
    return Number(rows[0]?.now_ms ?? Date.now());
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.pool.query('SELECT 1 AS ok');
      return Number(r.rows[0]?.ok) === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Test helper: wipe this sale. Not exposed via API. */
  async _reset(): Promise<void> {
    await this.pool.query('DELETE FROM purchases WHERE sale_id = $1', [this.saleId]);
    await this.pool.query('DELETE FROM sales WHERE sale_id = $1', [this.saleId]);
  }

  /** Test-only escape hatch to hit the pool directly (integration tests). */
  _pool(): pg.Pool {
    return this.pool;
  }
}
