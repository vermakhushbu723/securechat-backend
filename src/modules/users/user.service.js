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
import { normalizeIdentifier } from '../auth/identifier.js';
import { assertUserSearch } from '../moderation/searchPermission.service.js';
import { searchTokensOf, toPublicUser, toSelfUser, User } from './user.model.js';

export async function getMe(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw ApiError.notFound('User not found');
  return toSelfUser(user);
}

export async function updateMe(userId, patch) {
  const set = {};
  for (const k of ['name', 'displayName', 'about', 'avatarUrl', 'username', 'businessAddress']) if (patch[k] !== undefined) set[k] = patch[k];
  if (set.name) set.searchName = set.name.toLowerCase();
  if (set.name !== undefined || set.username !== undefined) {
    const cur = await User.findById(userId).select('name username').lean();
    set.searchTokens = searchTokensOf(set.name ?? cur?.name, set.username ?? cur?.username);
  }
  if (patch.privacy?.lastSeen) set['privacy.lastSeen'] = patch.privacy.lastSeen;
  if (patch.privacy?.readReceipts !== undefined) set['privacy.readReceipts'] = patch.privacy.readReceipts;
  if (patch.privacy?.searchable === true) {
    const cur = await User.findById(userId).select('searchHidden').lean();
    if (cur?.searchHidden) throw ApiError.forbidden('The SecureChat team hid your profile from search.', 'SEARCH_HIDDEN');
  }
  if (patch.privacy?.searchable !== undefined) set['privacy.searchable'] = patch.privacy.searchable;
  if (patch.privacy?.showContact !== undefined) set['privacy.showContact'] = patch.privacy.showContact;

  const user = await User.findByIdAndUpdate(userId, { $set: set }, { returnDocument: 'after', runValidators: true }).lean();
  if (!user) throw ApiError.notFound('User not found');
  await invalidateUser(userId);
  const self = toSelfUser(user);
  emitToUser(userId, 'user:updated', self); // sync other devices
  return self;
}

/**
 * Signup step after the first OTP login.
 * Personal: name only. Business: business name (shown as the name), business address and bio.
 */
export async function completeProfile(userId, input) {
  const business = input.accountType === 'business';
  const name = business ? input.businessName : input.name;
  const set = {
    accountType: input.accountType,
    name,
    searchName: name.toLowerCase(),
    displayName: name.slice(0, 20),
    searchTokens: searchTokensOf(name, (await User.findById(userId).select('username').lean())?.username),
    businessAddress: business ? input.businessAddress : null,
    profileCompleted: true,
  };
  if (business && input.bio !== undefined) set.about = input.bio;
  const user = await User.findByIdAndUpdate(userId, { $set: set }, { returnDocument: 'after', runValidators: true }).lean();
  if (!user) throw ApiError.notFound('User not found');
  await invalidateUser(userId);
  const self = toSelfUser(user);
  emitToUser(userId, 'user:updated', self);
  return self;
}

/**
 * Search by any word of the name / business name / username (prefix, so "tes" finds
 * "AB TEST COMPANY"), or by the exact mobile number (with or without +91) / email ID.
 * Users who turned off "Anyone can find me" are never listed. Uses indexes only.
 */
export async function search(userId, q, limit) {
  await assertUserSearch(userId);
  // A full mobile number / email ID is an exact lookup; anything else searches names.
  const id = normalizeIdentifier(q);
  const words = id ? [] : searchTokensOf(q.trim(), '').slice(0, 5);
  const or = id ? [{ [id.kind]: id.value }] : [];
  if (words.length) or.push({ searchTokens: { $all: words.map((w) => new RegExp(`^${escapeRegex(w)}`)) } });
  if (!or.length) return [];
  const users = await User.find({
    _id: { $ne: userId },
    status: 'active',
    'privacy.searchable': { $ne: false },
    searchHidden: { $ne: true }, // hidden from search by the admin
    $or: or,
  })
    .select('name displayName username avatarUrl about lastSeenAt privacy accountType businessAddress phone email')
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
