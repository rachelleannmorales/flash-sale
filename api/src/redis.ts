import Redis from 'ioredis';

export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
}

export async function connectRedis(url: string): Promise<Redis> {
  const redis = createRedis(url);
  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== 'PONG') {
      throw new Error(`Redis PING returned ${String(pong)}`);
    }
    return redis;
  } catch (err) {
    redis.disconnect();
    throw new Error(
      `Redis is not reachable at ${url}. Start it with: docker compose up -d redis`,
      { cause: err },
    );
  }
}
