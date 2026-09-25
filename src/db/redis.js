import { Redis } from 'ioredis';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const clients = new Set();

/**
 * Creates a named Redis connection. Pub/sub and blocking (BullMQ) usage need
 * dedicated connections, so every consumer asks for its own.
 */
export function createRedis(name, extra = {}) {
  const client = new Redis(env.REDIS_URL, {
    connectionName: `securechat:${name}`,
    enableAutoPipelining: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    connectTimeout: 10_000,
    // Fail a command after a few retries instead of hanging the HTTP request.
    maxRetriesPerRequest: 3,
    ...extra,
  });
  client.on('error', (err) => logger.error({ err: err.message, name }, 'Redis error'));
  clients.add(client);
  return client;
}

/** Shared command connection for caching, presence and rate limiting. */
export const redis = createRedis('main');

export async function closeRedis() {
  await Promise.allSettled([...clients].map((c) => c.quit()));
}
