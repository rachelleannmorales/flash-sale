import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { buildApp } from './server.js';

async function main() {
  const config = loadConfig();
  const { app, deps } = await buildApp(config);
  const { logger, store, redis } = deps;

  let server: Server | null = null;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const closed = new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((err) => (err ? reject(err) : resolve()));
    });
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('shutdown_timeout')), 10_000),
    );

    try {
      await Promise.race([closed, timeout]);
    } catch (err) {
      logger.warn({ err }, 'graceful shutdown timed out; forcing exit');
    } finally {
      await store.close().catch((err) => logger.error({ err }, 'store close failed'));
      await redis.quit().catch((err) => logger.error({ err }, 'redis close failed'));
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  server = app.listen(config.port, config.host, () => {
    logger.info(
      {
        saleId: config.saleId,
        totalStock: config.totalStock,
        startsAt: new Date(config.saleStartMs).toISOString(),
        endsAt: new Date(config.saleEndMs).toISOString(),
        addr: `http://${config.host}:${config.port}`,
      },
      'flash-sale API ready',
    );
  });

  server.on('error', (err) => {
    logger.error({ err }, 'server error');
    process.exit(1);
  });
}

void main();
