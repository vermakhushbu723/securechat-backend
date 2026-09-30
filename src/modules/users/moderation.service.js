import { invalidateUser } from '../../services/cache.service.js';
import { emitToUser, getIO, userRoom } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { revokeAll } from '../auth/auth.service.js';
import { invalidateAccess } from '../subscription/subscription.service.js';
import { toSelfUser, User } from './user.model.js';

/**
 * Platform moderation (admin panel + automatic content penalties):
 * block / suspend / restrict / force logout / delete / warn.
 */
const DAY = 86_400_000;

async function update(userId, set, unset = null) {
  const u = await User.findByIdAndUpdate(userId, { $set: set, ...(unset ? { $unset: unset } : {}) }, { returnDocument: 'after', lean: true });
  if (!u) throw ApiError.notFound('User not found');
  await Promise.all([invalidateAccess(userId), invalidateUser(userId)]);
  return u;
}

/** Ends every session: refresh tokens revoked, open sockets closed. */
export async function forceLogout(userId) {
  await revokeAll(String(userId));
  emitToUser(String(userId), 'session:revoked', { reason: 'admin' });
  getIO()?.in(userRoom(String(userId))).disconnectSockets(true);
}

export async function blockUser(userId, { reason = '', by = null } = {}) {
  const u = await update(userId, { status: 'blocked', 'moderation.reason': reason || null, 'moderation.at': new Date(), 'moderation.by': by, 'moderation.suspendedUntil': null });
  await forceLogout(userId);
  return u;
}

export async function suspendUser(userId, { days = 7, reason = '', by = null } = {}) {
  const u = await update(userId, {
    status: 'suspended',
    'moderation.reason': reason || `Suspended for ${days} days`,
    'moderation.at': new Date(),
    'moderation.by': by,
    'moderation.suspendedUntil': new Date(Date.now() + days * DAY),
  });
  await forceLogout(userId);
  return u;
}

export async function unblockUser(userId) {
  const u = await update(userId, { status: 'active', 'moderation.reason': null, 'moderation.at': null, 'moderation.by': null, 'moderation.suspendedUntil': null });
  emitToUser(String(userId), 'user:updated', toSelfUser(u));
  return u;
}

/** Read only everywhere. hours = null keeps it until the admin lifts it. */
export async function restrictUser(userId, restricted, { hours = null } = {}) {
  const set = restricted
    ? hours
      ? { 'moderation.restricted': false, 'moderation.restrictedUntil': new Date(Date.now() + hours * 3_600_000) }
      : { 'moderation.restricted': true, 'moderation.restrictedUntil': null }
    : { 'moderation.restricted': false, 'moderation.restrictedUntil': null };
  const u = await update(userId, set);
  emitToUser(String(userId), 'user:updated', toSelfUser(u));
  return u;
}

/** Soft delete: account can no longer sign in, personal data is removed. */
export async function deleteUser(userId, { by = null } = {}) {
  const u = await User.findById(userId).select('name').lean();
  if (!u) throw ApiError.notFound('User not found');
  await update(
    userId,
    {
      status: 'deleted',
      name: 'Deleted user',
      displayName: 'Deleted',
      avatarUrl: null,
      about: '',
      searchTokens: [],
      searchName: 'deleted user',
      'privacy.searchable': false,
      'moderation.reason': 'Account deleted by admin',
      'moderation.at': new Date(),
      'moderation.by': by,
    },
    { phone: 1, email: 1, username: 1, passwordHash: 1 },
  );
  await forceLogout(userId);
  return { deleted: true, name: u.name };
}

/** Admin "Send warning": warning count +1 and an in-app notice. */
export async function warnUser(userId, message = 'You received a warning from the SecureChat team for breaking the content rules.') {
  const next = await User.findByIdAndUpdate(userId, { $inc: { warnings: 1 } }, { returnDocument: 'after', lean: true });
  if (!next) throw ApiError.notFound('User not found');
  emitToUser(String(userId), 'admin:notice', { title: 'Warning', body: message, warnings: next.warnings });
  emitToUser(String(userId), 'user:updated', toSelfUser(next));
  return { warnings: next.warnings, name: next.name };
}

/**
 * Abuse filter penalties (Abuse Filter screen): `muteAfter` blocked messages within 24 hours ->
 * read only for 24 hours, `suspendAfter` within 7 days -> suspended for 7 days. 0 turns a step off.
 */
export async function applyContentPenalty(userId, counts, cfg) {
  try {
    if (cfg.suspendAfter > 0 && counts.week === cfg.suspendAfter) {
      await suspendUser(userId, { days: 7, reason: `${counts.week} blocked messages in 7 days`, by: 'Abuse filter' });
    } else if (cfg.muteAfter > 0 && counts.day === cfg.muteAfter) {
      await restrictUser(userId, true, { hours: 24 });
    }
  } catch {
    // Penalties must never break the send path.
  }
}
