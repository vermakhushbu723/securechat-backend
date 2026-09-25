import { Worker } from 'bullmq';

import { logger } from '../config/logger.js';
import { createRedis } from '../db/redis.js';
import { GroupMember } from '../modules/groups/group.model.js';
import { expireMessages } from '../modules/groups/groupMessage.service.js';
import { User } from '../modules/users/user.model.js';
import { onlineMap } from '../services/presence.service.js';
import { PUSH_QUEUE } from '../services/queue.service.js';

/**
 * Delivers push notifications for messages to offline users.
 * Plug an FCM / APNs client into `send()`; without one the payload is logged.
 */
async function send(device, payload) {
  logger.info({ platform: device.platform, title: payload.title }, 'Push notification (no provider configured)');
}

async function pushTo(userIds, payload) {
  if (!userIds.length) return 0;
  const users = await User.find({ _id: { $in: userIds } }).select('+devices').lean();
  const devices = users.flatMap((u) => u.devices ?? []);
  await Promise.all(devices.map((d) => send(d, payload)));
  return devices.length;
}

/** Group message: fan out to offline, unmuted members (never the sender). */
async function pushGroup({ groupId, senderId, senderName, groupName, preview }) {
  const now = new Date();
  const members = await GroupMember.find({
    group: groupId,
    status: 'active',
    user: { $ne: senderId },
    $or: [{ mutedUntil: null }, { mutedUntil: { $lte: now } }],
  })
    .select('user')
    .lean();
  const ids = members.map((m) => String(m.user));
  const online = await onlineMap(ids);
  const offline = ids.filter((id) => !online.get(id));
  return pushTo(offline, { title: groupName, body: `${senderName}: ${preview}`, data: { groupId } });
}

export function startPushWorker() {
  const worker = new Worker(
    PUSH_QUEUE,
    async (job) => {
      if (job.data.kind === 'group') return { delivered: await pushGroup(job.data) };
      const { recipientId, senderName, preview, conversationId } = job.data;
      return { delivered: await pushTo([recipientId], { title: senderName, body: preview, data: { conversationId } }) };
    },
    {
      connection: createRedis('bull:worker', { maxRetriesPerRequest: null }),
      concurrency: 50,
    },
  );
  worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message }, 'Push job failed'));

  // Message expiry (1h / 24h / 7d privacy option): wipe content + revoke files every minute.
  const sweeper = setInterval(() => {
    expireMessages()
      .then((n) => n && logger.info({ expired: n }, 'Expired group messages'))
      .catch((err) => logger.warn({ err: err.message }, 'Expiry sweep failed'));
  }, 60_000);
  sweeper.unref();
  const close = worker.close.bind(worker);
  worker.close = async () => {
    clearInterval(sweeper);
    await close();
  };
  return worker;
}
