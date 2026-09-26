import { redis } from '../db/redis.js';
import { Conversation } from '../modules/chat/conversation.model.js';
import { Block } from '../modules/users/block.model.js';
import { toPublicUser, User } from '../modules/users/user.model.js';

const USER_TTL = 600;
const PARTICIPANTS_TTL = 3600;
const BLOCK_TTL = 3600;
const EMPTY = '__empty__';

// ---------------------------------------------------------------------------
// Public user profiles (read heavy: every chat list / message render)
// ---------------------------------------------------------------------------
const userKey = (id) => `user:pub:${id}`;

export async function getPublicUsers(ids) {
  const unique = [...new Set(ids.map(String))];
  if (!unique.length) return new Map();
  const cached = await redis.mget(unique.map(userKey));
  const result = new Map();
  const missing = [];
  unique.forEach((id, i) => (cached[i] ? result.set(id, JSON.parse(cached[i])) : missing.push(id)));

  if (missing.length) {
    const users = await User.find({ _id: { $in: missing } })
      .select('name displayName username avatarUrl about lastSeenAt privacy accountType businessAddress')
      .lean();
    const pipe = redis.pipeline();
    for (const u of users) {
      const pub = toPublicUser(u);
      result.set(pub.id, pub);
      pipe.set(userKey(pub.id), JSON.stringify(pub), 'EX', USER_TTL);
    }
    await pipe.exec();
  }
  return result;
}

export async function getPublicUser(id) {
  return (await getPublicUsers([id])).get(String(id)) ?? null;
}

export const invalidateUser = (id) => redis.del(userKey(id));

// ---------------------------------------------------------------------------
// Conversation participants (checked on every socket event)
// ---------------------------------------------------------------------------
const partKey = (id) => `conv:p:${id}`;

/** Returns [userA, userB] or null when the conversation does not exist. */
export async function getParticipants(conversationId) {
  const cached = await redis.get(partKey(conversationId));
  if (cached) return cached === EMPTY ? null : cached.split(',');
  const conv = await Conversation.findById(conversationId).select('participants').lean();
  const value = conv ? conv.participants.map(String) : null;
  await redis.set(partKey(conversationId), value ? value.join(',') : EMPTY, 'EX', value ? PARTICIPANTS_TTL : 60);
  return value;
}

export async function cacheParticipants(conversationId, participants) {
  await redis.set(partKey(conversationId), participants.map(String).join(','), 'EX', PARTICIPANTS_TTL);
}

// ---------------------------------------------------------------------------
// Block lists (checked on every send / typing / presence subscribe)
// ---------------------------------------------------------------------------
const blockKey = (id) => `blk:${id}`;

async function ensureBlockSet(userId) {
  const key = blockKey(userId);
  if (await redis.exists(key)) return key;
  const rows = await Block.find({ blocker: userId }).select('blocked').lean();
  await redis
    .multi()
    .sadd(key, EMPTY, ...rows.map((r) => String(r.blocked)))
    .expire(key, BLOCK_TTL)
    .exec();
  return key;
}

export async function hasBlocked(blockerId, blockedId) {
  const key = await ensureBlockSet(blockerId);
  return (await redis.sismember(key, String(blockedId))) === 1;
}

/** True when either user blocked the other. */
export async function isBlockedBetween(a, b) {
  const [ab, ba] = await Promise.all([hasBlocked(a, b), hasBlocked(b, a)]);
  return ab || ba;
}

export const invalidateBlocks = (userId) => redis.del(blockKey(userId));

// ---------------------------------------------------------------------------
// Reverse block index: users who blocked X (they must not receive X's group messages)
// ---------------------------------------------------------------------------
const blockedByKey = (id) => `blkby:${id}`;

export async function getBlockers(userId) {
  const key = blockedByKey(userId);
  let members = await redis.smembers(key);
  if (!members.length) {
    const rows = await Block.find({ blocked: userId }).select('blocker').lean();
    members = [EMPTY, ...rows.map((r) => String(r.blocker))];
    await redis.multi().sadd(key, ...members).expire(key, BLOCK_TTL).exec();
  }
  return members.filter((m) => m !== EMPTY);
}

/** Users the given user blocked (their messages are hidden for them in groups). */
export async function getBlockedBy(userId) {
  const key = await ensureBlockSet(userId);
  return (await redis.smembers(key)).filter((m) => m !== EMPTY);
}

export const invalidateBlockers = (userId) => redis.del(blockedByKey(userId));
