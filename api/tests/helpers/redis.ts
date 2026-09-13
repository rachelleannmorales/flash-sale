import Redis from 'ioredis';

const DEFAULTS = [
  'redis://127.0.0.1:6379',
  'redis://127.0.0.1:6380',
];

async function reachable(url: string): Promise<boolean> {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    const pong = await redis.ping();
    await redis.quit();
    return pong === 'PONG';
  } catch {
    redis.disconnect();
    return false;
  }
}

/**
 * Resolve a live Redis URL. Honours `REDIS_URL` when set; otherwise
 * tries the CI default (:6379) then the Compose host port (:6380).
 */
export async function resolveRedisUrl(): Promise<string> {
  if (process.env.REDIS_URL) {
    if (await reachable(process.env.REDIS_URL)) return process.env.REDIS_URL;
    throw new Error(
      `REDIS_URL is set but Redis is not reachable at ${process.env.REDIS_URL}.\n` +
        'Start it with: docker compose up -d redis',
    );
  }
  for (const url of DEFAULTS) {
    if (await reachable(url)) {
      process.env.REDIS_URL = url;
      return url;
    }
  }
  throw new Error(
    'Redis is required for HTTP tests (shared rate-limit counter).\n' +
      '  docker compose up -d redis\n' +
      '  REDIS_URL=redis://127.0.0.1:6380 npm test',
  );
}
