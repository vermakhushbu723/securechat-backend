import http from 'node:http';

import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { closeRedis } from './db/redis.js';
import { closeQueues } from './services/queue.service.js';
import { createSocketServer } from './socket/index.js';
import { startPushWorker } from './workers/push.worker.js';

async function main() {
  await connectMongo();

  const app = createApp();
  const server = http.createServer(app);
  // Long-lived keep-alive behind a load balancer; must exceed the LB idle timeout.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const io = createSocketServer(server);
  const worker = env.RUN_WORKERS ? startPushWorker() : null;

  server.on('error', async (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    logger.fatal(
      `Port ${env.PORT} is already in use - another SecureChat server is probably running. ` +
        `Stop it (Windows: Get-NetTCPConnection -LocalPort ${env.PORT} | Stop-Process -Id {OwningProcess}) or set PORT in .env.`,
    );
    await worker?.close();
    await disconnectMongo();
    await closeRedis();
    process.exit(1);
  });
  server.listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, 'SecureChat API listening'));

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await new Promise((resolve) => io.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
      await worker?.close();
      await closeQueues();
      await disconnectMongo();
      await closeRedis();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
