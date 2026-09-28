import { redis } from '../../db/redis.js';
import { emitToUser } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { toSelfUser, User } from '../users/user.model.js';
import { accessOf } from './access.js';
import { ExtensionRequest } from './extensionRequest.model.js';

export { accessOf, TRIAL_DAYS } from './access.js';

const TTL = 300;
const DAY = 86_400_000;
const key = (uid) => `sub:${uid}`;

/** Cached access of one user (checked on every send). */
export async function getAccess(userId) {
  const cached = await redis.get(key(userId));
  if (cached) {
    // Cache holds the raw dates; expiry is always evaluated against the clock.
    return accessOf(JSON.parse(cached));
  }
  const u = await User.findById(userId).select('createdAt subscription').lean();
  if (!u) throw ApiError.notFound('User not found');
  await redis.set(key(userId), JSON.stringify({ createdAt: u.createdAt, subscription: u.subscription ?? {} }), 'EX', TTL);
  return accessOf(u);
}

export const invalidateAccess = (userId) => redis.del(key(userId));

/** 'approved' | 'owner' | null */
export async function groupPremiumSource(group) {
  const p = group.premium ?? {};
  if (p.approved && (!p.approvedUntil || new Date(p.approvedUntil) > new Date())) return 'approved';
  const owner = await getAccess(group.createdBy);
  return owner.paid ? 'owner' : null;
}

export async function groupPremiumInfo(group) {
  const source = await groupPremiumSource(group);
  return { active: Boolean(source), source, freeAccess: Boolean(group.settings?.members?.freeAccess) };
}

const locked = (message) => new ApiError(402, 'SUBSCRIPTION_REQUIRED', message, { upgrade: true });

/** Direct chats: the user needs their own trial / premium / extension. */
export async function requireOwnAccess(userId) {
  const a = await getAccess(userId);
  if (!a.active) throw locked('Your free trial has ended. Upgrade to premium or request an extension to keep chatting.');
  return a;
}

/**
 * Groups: own access, or the group's premium when the creator lets members use it.
 * Returns null when allowed, otherwise [code, message] (for the "can send" flags).
 */
export async function groupAccessBlock(userId, group) {
  const a = await getAccess(userId);
  if (a.active) return null;
  if (group.settings?.members?.freeAccess && (await groupPremiumSource(group))) return null;
  return ['SUBSCRIPTION_REQUIRED', 'Your free trial has ended. Upgrade to premium to reply and open protected files in this group.'];
}

export async function requireGroupAccessPlan(userId, group) {
  const block = await groupAccessBlock(userId, group);
  if (block) throw locked(block[1]);
}

// ---------------------------------------------------------------------------
// User facing: status + extension / premium request
// ---------------------------------------------------------------------------
function requestDTO(r) {
  return { id: String(r._id), kind: r.kind, reason: r.reason, days: r.days, status: r.status, createdAt: r.createdAt, decidedAt: r.decidedAt };
}

export async function status(userId) {
  const [a, requests] = await Promise.all([
    getAccess(userId),
    ExtensionRequest.find({ user: userId }).sort({ _id: -1 }).limit(10).lean(),
  ]);
  return { ...a, requests: requests.map(requestDTO) };
}

export async function requestExtension(userId, { kind, reason, days }) {
  const pending = await ExtensionRequest.findOne({ user: userId, status: 'pending' }).lean();
  if (pending) throw ApiError.conflict('You already have a pending request', 'REQUEST_PENDING');
  const r = await ExtensionRequest.create({ user: userId, kind, reason, days });
  return requestDTO(r.toObject());
}

// ---------------------------------------------------------------------------
// Admin (admin API key / CLI script)
// ---------------------------------------------------------------------------
async function extendField(userId, field, days) {
  const u = await User.findById(userId).select('subscription').lean();
  if (!u) throw ApiError.notFound('User not found');
  const current = u.subscription?.[field] ? new Date(u.subscription[field]).getTime() : 0;
  const from = Math.max(Date.now(), current);
  const until = days > 0 ? new Date(from + days * DAY) : null;
  const updated = await User.findByIdAndUpdate(userId, { $set: { [`subscription.${field}`]: until } }, { returnDocument: 'after', lean: true });
  await invalidateAccess(userId);
  emitToUser(String(userId), 'user:updated', toSelfUser(updated));
  return accessOf(updated);
}

/** Sets the end of the free trial to now + days (0 ends it now). */
export async function setTrial(userId, days) {
  const updated = await User.findByIdAndUpdate(
    userId,
    { $set: { 'subscription.trialEndsAt': new Date(Date.now() + days * DAY) } },
    { returnDocument: 'after', lean: true },
  );
  if (!updated) throw ApiError.notFound('User not found');
  await invalidateAccess(userId);
  emitToUser(String(userId), 'user:updated', toSelfUser(updated));
  return accessOf(updated);
}

/** days > 0 adds days, days = 0 removes it. */
export const grantPremium = (userId, days) => extendField(userId, 'premiumUntil', days);
export const grantExtension = (userId, days) => extendField(userId, 'extendedUntil', days);

export async function decideRequest(requestId, approve, days) {
  const r = await ExtensionRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending' },
    { $set: { status: approve ? 'approved' : 'rejected', decidedAt: new Date() } },
    { returnDocument: 'after', lean: true },
  );
  if (!r) throw ApiError.notFound('Request not found or already decided');
  if (approve) await (r.kind === 'premium' ? grantPremium : grantExtension)(r.user, days ?? r.days);
  return requestDTO(r);
}

export async function pendingRequests() {
  const rows = await ExtensionRequest.find({ status: 'pending' }).sort({ _id: 1 }).limit(200).populate('user', 'name phone email').lean();
  return rows.map((r) => ({ ...requestDTO(r), user: { id: String(r.user?._id), name: r.user?.name, phone: r.user?.phone, email: r.user?.email } }));
}
