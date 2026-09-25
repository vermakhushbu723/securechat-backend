import { redis } from '../db/redis.js';
import { User } from '../modules/users/user.model.js';
import { emitToRoom, presenceRoom } from '../socket/emitter.js';
import { getPublicUser, invalidateUser } from './cache.service.js';

/**
 * Presence = Redis set of live socket ids per user (multi device / multi node).
 * Keys carry a TTL that every node refreshes for its own sockets, so a crashed
 * node's users fall back to offline automatically.
 */
const KEY_TTL = 120;
const key = (userId) => `presence:${userId}`;
const lastSeenKey = (userId) => `lastseen:${userId}`;

export async function markOnline(userId, socketId) {
  const [[, added], , [, count]] = await redis
    .multi()
    .sadd(key(userId), socketId)
    .expire(key(userId), KEY_TTL)
    .scard(key(userId))
    .exec();
  if (added === 1 && count === 1) {
    emitToRoom(presenceRoom(userId), 'presence', { userId: String(userId), online: true, lastSeenAt: null });
  }
}

export async function markOffline(userId, socketId) {
  const [, [, count]] = await redis.multi().srem(key(userId), socketId).scard(key(userId)).exec();
  if (count > 0) return;

  const now = new Date();
  await Promise.all([
    redis.set(lastSeenKey(userId), now.toISOString(), 'EX', 86_400 * 30),
    User.updateOne({ _id: userId }, { $set: { lastSeenAt: now } }),
  ]);
  await invalidateUser(userId);
  const pub = await getPublicUser(userId);
  emitToRoom(presenceRoom(userId), 'presence', {
    userId: String(userId),
    online: false,
    lastSeenAt: pub?.lastSeenAt ?? null,
  });
}

/** Called periodically by each node for the users it holds sockets of. */
export async function refreshTTL(userIds) {
  if (!userIds.length) return;
  const pipe = redis.pipeline();
  for (const id of userIds) pipe.expire(key(id), KEY_TTL);
  await pipe.exec();
}

export async function isOnline(userId) {
  return (await redis.scard(key(userId))) > 0;
}

/** Map userId -> online for many users in one round trip. */
export async function onlineMap(userIds) {
  const ids = [...new Set(userIds.map(String))];
  if (!ids.length) return new Map();
  const pipe = redis.pipeline();
  for (const id of ids) pipe.scard(key(id));
  const res = await pipe.exec();
  return new Map(ids.map((id, i) => [id, (res[i][1] ?? 0) > 0]));
}
