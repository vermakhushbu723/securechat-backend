import { Worker } from 'bullmq';

import { logger } from '../config/logger.js';
import { createRedis } from '../db/redis.js';
import { GroupMember } from '../modules/groups/group.model.js';
import { expireDirectMessages } from '../modules/chat/chat.service.js';
import { expireMessages } from '../modules/groups/groupMessage.service.js';
import { pruneLocationHistory, sendDueNotifications } from '../modules/admin/admin.system.js';
import { pushToUsers } from '../services/push.service.js';
import { PUSH_QUEUE } from '../services/queue.service.js';

/**
 * Push notifications (Firebase Cloud Messaging) for 1-to-1 and group messages and admin
 * broadcasts. Sent to every device of the recipient: the app hides it while that chat is open.
 */
async function pushDirect({ recipientId, senderName, preview, conversationId }) {
  return pushToUsers([recipientId], { title: senderName, body: preview, link: `/dm/${conversationId}`, tag: `dm-${conversationId}`, data: { type: 'dm', conversationId } });
}

/** Group message: every active, unmuted member (never the sender). */
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
  return pushToUsers(
    members.map((m) => String(m.user)),
    { title: groupName, body: `${senderName}: ${preview}`, link: `/chat/${groupId}`, tag: `g-${groupId}`, data: { type: 'group', groupId } },
  );
}

export function startPushWorker() {
  const worker = new Worker(
    PUSH_QUEUE,
    async (job) => {
      if (job.data.kind === 'group') return pushGroup(job.data);
      if (job.data.kind === 'broadcast') {
        return pushToUsers(job.data.userIds, { title: job.data.title, body: job.data.body, link: '/', tag: `n-${job.data.notificationId}`, data: { type: 'notice', notificationId: job.data.notificationId } });
      }
      return pushDirect(job.data);
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
    expireDirectMessages()
      .then((n) => n && logger.info({ expired: n }, 'Expired direct messages'))
      .catch((err) => logger.warn({ err: err.message }, 'Direct expiry sweep failed'));
    // Admin panel: scheduled broadcasts + location history retention.
    sendDueNotifications()
      .then((n) => n && logger.info({ sent: n }, 'Scheduled notifications sent'))
      .catch((err) => logger.warn({ err: err.message }, 'Notification sweep failed'));
    pruneLocationHistory().catch((err) => logger.warn({ err: err.message }, 'Location retention sweep failed'));
  }, 60_000);
  sweeper.unref();
  const close = worker.close.bind(worker);
  worker.close = async () => {
    clearInterval(sweeper);
    await close();
  };
  return worker;
}
