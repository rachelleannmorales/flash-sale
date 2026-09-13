import crypto from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import 'express-async-errors';
import type Redis from 'ioredis';
import { pino, type Logger } from 'pino';
import { RedisStore } from 'rate-limit-redis';
import { registerRoutes } from './routes/sale.js';
import { SaleService } from './services/saleService.js';
import type { Store } from './stores/types.js';
import { PostgresStore } from './stores/postgresStore.js';
import type { Config } from './config.js';
import { connectRedis } from './redis.js';

export interface AppDeps {
  store: Store;
  sale: SaleService;
  logger: Logger;
  redis: Redis;
}

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

/**
 * Open Postgres and seed the sale row
 */
export async function buildStore(config: Config): Promise<Store> {
  const snapshot = {
    saleId: config.saleId,
    totalStock: config.totalStock,
    remaining: config.totalStock,
    startsAt: config.saleStartMs,
    endsAt: config.saleEndMs,
  };

  const store = new PostgresStore(config.databaseUrl, config.saleId, config.databasePoolMax);
  await store.init(snapshot);
  return store;
}

function parseWindowMs(s: string): number {
  const m = s.trim().match(/^(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|minute|minutes|h|hour|hours)$/i);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(`Invalid RATE_LIMIT_WINDOW: ${s} (try "10 seconds", "1 minute", "500 ms")`);
  }
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'ms') return n;
  if (unit.startsWith('s')) return n * 1_000;
  if (unit === 'm' || unit.startsWith('min')) return n * 60_000;
  return n * 60 * 60_000;
}

function isStoreUnavailable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; code?: string };
  const code = e.code ?? '';
  const msg = `${e.name ?? ''} ${e.message ?? ''} ${code}`;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === '57P01' || // admin_shutdown
    code === '57P03' || // cannot_connect_now
    code === '55P03' || // lock_not_available (lock_timeout)
    code === '57014' || // query_canceled (statement_timeout)
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout exceeded when trying to connect|Connection terminated|database system is starting up|too many clients|canceling statement due to (statement|lock) timeout/i.test(msg)
  );
}

export async function buildApp(config: Config, deps?: Partial<AppDeps>): Promise<{
  app: Express;
  deps: AppDeps;
}> {
  const logger =
    deps?.logger ??
    pino({
      level: config.logLevel,
      transport:
        config.nodeEnv === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { colorize: true, singleLine: true } },
    });

  const store = deps?.store ?? (await buildStore(config));
  const sale = deps?.sale ?? new SaleService(store);
  const redis = deps?.redis ?? (await connectRedis(config.redisUrl));

  const app = express();

  app.disable('x-powered-by');

  // Correlation id: pass through inbound X-Request-Id, otherwise generate.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const inbound = req.headers['x-request-id'];
    const id =
      typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 128
        ? inbound
        : crypto.randomUUID();
    req.id = id;
    res.setHeader('x-request-id', id);
    next();
  });

  // JSON body parsing with a small size limit.
  app.use(express.json({ limit: '1kb', strict: true }));

  // Routes
  registerRoutes(app, {
    sale,
    rateLimit: {
      windowMs: parseWindowMs(config.rateLimitWindow),
      max: config.rateLimitMax,
      store: new RedisStore({
        prefix: `rl:${config.saleId}:`,
        sendCommand: ((...args: string[]) => redis.call(args[0]!, ...args.slice(1))) as (
          ...args: string[]
        ) => Promise<boolean | number | string>,
      }),
    },
  });

  // 404 for unknown routes
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Error handler (must have 4 parameters or Express won't recognise it)
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    if (err instanceof SyntaxError) {
      return res.status(400).json({ error: 'invalid_json' });
    }
    if (isStoreUnavailable(err)) {
      logger.warn({ err, reqId: req.id, method: req.method, url: req.originalUrl }, 'store_unavailable');
      return res.status(503).json({ error: 'store_unavailable' });
    }
    logger.error({ err, reqId: req.id, method: req.method, url: req.originalUrl }, 'unhandled_error');
    res.status(500).json({ error: 'internal_server_error' });
  });

  return { app, deps: { store, sale, logger, redis } };
}
