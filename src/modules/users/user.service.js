import {
  getPublicUser,
  getPublicUsers,
  hasBlocked,
  invalidateBlockers,
  invalidateBlocks,
  invalidateUser,
} from '../../services/cache.service.js';
import { onlineMap } from '../../services/presence.service.js';
import { emitToUser } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/validators.js';
import { Block } from './block.model.js';
import { toPublicUser, toSelfUser, User } from './user.model.js';

export async function getMe(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw ApiError.notFound('User not found');
  return toSelfUser(user);
}

export async function updateMe(userId, patch) {
  const set = {};
  for (const k of ['name', 'displayName', 'about', 'avatarUrl', 'username']) if (patch[k] !== undefined) set[k] = patch[k];
  if (set.name) set.searchName = set.name.toLowerCase();
  if (patch.privacy?.lastSeen) set['privacy.lastSeen'] = patch.privacy.lastSeen;
  if (patch.privacy?.readReceipts !== undefined) set['privacy.readReceipts'] = patch.privacy.readReceipts;

  const user = await User.findByIdAndUpdate(userId, { $set: set }, { returnDocument: 'after', runValidators: true }).lean();
  if (!user) throw ApiError.notFound('User not found');
  await invalidateUser(userId);
  const self = toSelfUser(user);
  emitToUser(userId, 'user:updated', self); // sync other devices
  return self;
}

/** Prefix search on username / name, or exact phone. Uses indexes only. */
export async function search(userId, q, limit) {
  const term = q.trim().toLowerCase();
  const rx = new RegExp(`^${escapeRegex(term)}`);
  const users = await User.find({
    _id: { $ne: userId },
    status: 'active',
    $or: [{ username: rx }, { searchName: rx }, { phone: q.trim() }],
  })
    .select('name displayName username avatarUrl about lastSeenAt privacy')
    .limit(limit)
    .lean();
  const online = await onlineMap(users.map((u) => u._id));
  return users.map((u) => ({ ...toPublicUser(u), online: online.get(String(u._id)) ?? false }));
}

export async function getProfile(viewerId, userId) {
  const pub = await getPublicUser(userId);
  if (!pub) throw ApiError.notFound('User not found');
  const [online, blockedByMe, blockedMe] = await Promise.all([
    onlineMap([userId]),
    hasBlocked(viewerId, userId),
    hasBlocked(userId, viewerId),
  ]);
  return {
    ...pub,
    // A user who blocked you does not share presence / last seen with you.
    online: blockedMe ? false : online.get(String(userId)),
    lastSeenAt: blockedMe ? null : pub.lastSeenAt,
    isBlocked: blockedByMe,
  };
}

export async function presence(viewerId, ids) {
  const [users, online] = await Promise.all([getPublicUsers(ids), onlineMap(ids)]);
  const result = [];
  for (const id of ids) {
    const u = users.get(String(id));
    if (!u) continue;
    const hidden = await hasBlocked(id, viewerId);
    result.push({ userId: String(id), online: hidden ? false : online.get(String(id)), lastSeenAt: hidden ? null : u.lastSeenAt });
  }
  return result;
}

export async function block(userId, targetId) {
  if (String(userId) === String(targetId)) throw ApiError.badRequest('You cannot block yourself');
  if (!(await User.exists({ _id: targetId }))) throw ApiError.notFound('User not found');
  await Block.updateOne(
    { blocker: userId, blocked: targetId },
    { $setOnInsert: { createdAt: new Date() } },
    { upsert: true, timestamps: false },
  );
  await Promise.all([invalidateBlocks(userId), invalidateBlockers(targetId)]);
  emitToUser(userId, 'user:blocked', { userId: String(targetId), blocked: true });
}

export async function unblock(userId, targetId) {
  await Block.deleteOne({ blocker: userId, blocked: targetId });
  await Promise.all([invalidateBlocks(userId), invalidateBlockers(targetId)]);
  emitToUser(userId, 'user:blocked', { userId: String(targetId), blocked: false });
}

export async function listBlocked(userId) {
  const rows = await Block.find({ blocker: userId }).sort({ _id: -1 }).select('blocked').lean();
  const users = await getPublicUsers(rows.map((r) => r.blocked));
  return rows.map((r) => users.get(String(r.blocked))).filter(Boolean);
}

export async function registerDevice(userId, { token, platform }) {
  await User.updateOne({ _id: userId }, { $pull: { devices: { token } } });
  await User.updateOne(
    { _id: userId },
    { $push: { devices: { $each: [{ token, platform, updatedAt: new Date() }], $slice: -10 } } },
  );
}
