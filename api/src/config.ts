/**
 * Runtime configuration from the environment. The spec's "configurable start
 * and end time" is SALE_START / SALE_END (ISO or epoch ms), set via the
 * shell, Compose, or CI — same names as api/.env.example.
 */

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  logLevel: string;

  databaseUrl: string;
  databasePoolMax: number;
  redisUrl: string;

  saleId: string;
  totalStock: number;
  saleStartMs: number;
  saleEndMs: number;

  rateLimitMax: number;
  rateLimitWindow: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${name}=${raw} is not a valid number`);
  }
  return n;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function envStrRequired(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    throw new Error(`${name} is required in production.`);
  }
  return raw;
}

function parseTime(name: string, fallbackMs: number | null): number {
  const raw = process.env[name];
  if (!raw) {
    if (fallbackMs === null) {
      throw new Error(`${name} is required (set an ISO string or ms epoch).`);
    }
    return fallbackMs;
  }
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && String(asNum) === raw.trim()) return asNum;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name}=${raw} is not a valid time`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const nodeEnv = (envStr('NODE_ENV', 'development') as Config['nodeEnv']);
  const isProd = nodeEnv === 'production';

  // Spec: configurable sale window. Production must set both or we refuse
  // to boot (defaulting start to Date.now() would open the sale by accident).
  const now = Date.now();
  const start = parseTime('SALE_START', isProd ? null : now);
  const end = parseTime('SALE_END', isProd ? null : now + 60 * 60 * 1000);
  if (end <= start) {
    throw new Error(`SALE_END (${end}) must be strictly after SALE_START (${start}).`);
  }

  const totalStock = envInt('TOTAL_STOCK', 1000);
  if (totalStock < 1) {
    throw new Error(`TOTAL_STOCK must be >= 1, got ${totalStock}`);
  }

  return {
    nodeEnv,
    port: envInt('PORT', 3000),
    host: envStr('HOST', '0.0.0.0'),
    logLevel: envStr('LOG_LEVEL', 'info'),
    databaseUrl: isProd
      ? envStrRequired('DATABASE_URL')
      : envStr('DATABASE_URL', 'postgres://flash:flash@127.0.0.1:5432/flashsale'),
    databasePoolMax: envInt('DATABASE_POOL_MAX', 20),
    redisUrl: isProd
      ? envStrRequired('REDIS_URL')
      : envStr('REDIS_URL', 'redis://127.0.0.1:6379'),
    saleId: envStr('SALE_ID', 'flash-2026'),
    totalStock,
    saleStartMs: start,
    saleEndMs: end,
    rateLimitMax: envInt('RATE_LIMIT_MAX', 60),
    rateLimitWindow: envStr('RATE_LIMIT_WINDOW', '10 seconds'),
  };
}
