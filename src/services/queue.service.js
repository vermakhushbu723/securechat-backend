import { Queue } from 'bullmq';

import { logger } from '../config/logger.js';
import { createRedis } from '../db/redis.js';

export const PUSH_QUEUE = 'push-notifications';

let pushQueue = null;

function queue() {
  pushQueue ??= new Queue(PUSH_QUEUE, {
    connection: createRedis('bull:producer', { maxRetriesPerRequest: null }),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    },
  });
  return pushQueue;
}

/** Offline recipients get a push notification through the background worker. */
export async function enqueuePush(data) {
  try {
    await queue().add('message', data);
  } catch (err) {
    // Push is best effort - never fail the message send because of it.
    logger.warn({ err: err.message }, 'Failed to enqueue push');
  }
}

/** Admin broadcast: push to many users (processed by the push worker). */
export async function enqueueBroadcast(userIds, payload) {
  for (let i = 0; i < userIds.length; i += 1000) {
    await queue().add('broadcast', { kind: 'broadcast', userIds: userIds.slice(i, i + 1000), ...payload });
  }
}

/** Queue health for the admin System Settings service table. */
export async function queueCounts() {
  return queue().getJobCounts('waiting', 'active', 'failed', 'delayed');
}

export async function closeQueues() {
  await pushQueue?.close();
}
