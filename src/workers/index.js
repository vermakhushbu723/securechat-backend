/** Standalone worker process: `npm run worker` (use with RUN_WORKERS=false on API nodes). */
import { logger } from '../config/logger.js';
import { connectDatabase, disconnectDatabase } from '../db/database.js';
import { closeRedis } from '../db/redis.js';
import { startPushWorker } from './push.worker.js';

await connectDatabase();
const worker = startPushWorker();
logger.info('Workers started');

const shutdown = async () => {
  await worker.close();
  await disconnectDatabase();
  await closeRedis();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
