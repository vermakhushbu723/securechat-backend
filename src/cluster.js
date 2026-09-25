/**
 * Runs one API process per CPU core on the same port (`npm run start:cluster`).
 * Socket.IO uses WebSocket-only transport + Redis adapter, so no sticky
 * sessions are needed. For many machines use PM2 / Kubernetes instead.
 */
import cluster from 'node:cluster';
import os from 'node:os';

import { env } from './config/env.js';
import { logger } from './config/logger.js';

if (cluster.isPrimary) {
  const count = env.CLUSTER_WORKERS || os.availableParallelism();
  logger.info({ workers: count }, 'Starting cluster');
  for (let i = 0; i < count; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    if (signal === 'SIGTERM' || signal === 'SIGINT') return;
    logger.warn({ pid: worker.process.pid, code }, 'Worker died, restarting');
    cluster.fork();
  });

  const stop = () => {
    for (const w of Object.values(cluster.workers)) w?.process.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else {
  await import('./server.js');
}
