import { redis } from '../../db/redis.js';
import { emitToUser } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { getSetting } from '../platform/platform.service.js';
import { accountState, isRestricted, toSelfUser, User } from '../users/user.model.js';
import { accessOf, TRIAL_DAYS } from './access.js';
import { ExtensionRequest } from './extensionRequest.model.js';

export { accessOf, TRIAL_DAYS } from './access.js';

const TTL = 300;
const DAY = 86_400_000;
const key = (uid) => `sub:${uid}`;

const withModeration = (u) => ({ ...accessOf(u), restricted: isRestricted(u), accountState: accountState(u), overrides: u.securityOverrides ?? null });

/** Cached access of one user (checked on every send). */
export async function getAccess(userId) {
  const cached = await redis.get(key(userId));
  if (cached) {
    // Cache holds the raw dates; expiry is always evaluated against the clock.
    return withModeration(JSON.parse(cached));
  }
  const u = await User.findById(userId).select('createdAt subscription status moderation securityOverrides').lean();
  if (!u) throw ApiError.notFound('User not found');
  const raw = { createdAt: u.createdAt, subscription: u.subscription ?? {}, status: u.status, moderation: u.moderation ?? null, securityOverrides: u.securityOverrides ?? null };
  await redis.set(key(userId), JSON.stringify(raw), 'EX', TTL);
  return withModeration(raw);
}

const RESTRICTED_MESSAGE = 'The SecureChat team restricted your account to read only.';

/**
 * Admin Security Settings with scope "User": per user message rules
 * (private messages, public / private forwarding).
 */
export async function assertUserSecurity(userId, { visibility, forwarding = false }) {
  const o = (await getAccess(userId)).overrides;
  if (!o) return;
  if (!forwarding && visibility && visibility !== 'public' && o.privateMessages === false) {
    throw ApiError.forbidden('Private messages are turned off for your account', 'PRIVATE_DISABLED');
  }
  if (!forwarding && visibility === 'public' && o.publicMessages === false) {
    throw ApiError.forbidden('Public messages are turned off for your account', 'PUBLIC_DISABLED');
  }
  if (forwarding && visibility === 'public' && o.publicForwarding === false) {
    throw ApiError.forbidden('Forwarding is turned off for your account', 'FORWARD_NOT_ALLOWED');
  }
  if (forwarding && visibility !== 'public' && o.privateForwarding === false) {
    throw ApiError.forbidden('Forwarding private messages is turned off for your account', 'FORWARD_NOT_ALLOWED');
  }
}

function assertAccountCanSend(a) {
  if (a.accountState !== 'active') throw ApiError.forbidden('Your account is not active. Contact support.', 'ACCOUNT_BLOCKED');
  if (a.restricted) throw ApiError.forbidden(RESTRICTED_MESSAGE, 'ACCOUNT_RESTRICTED');
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

const locked = (message, details = {}) => new ApiError(402, 'SUBSCRIPTION_REQUIRED', message, { upgrade: true, ...details });

const CLAIM_MESSAGE = 'Claim your 7 day free trial to start chatting.';

/** Direct chats: the user needs their own trial / premium / extension. */
export async function requireOwnAccess(userId) {
  const a = await getAccess(userId);
  assertAccountCanSend(a);
  if (a.access === 'unclaimed') throw locked(CLAIM_MESSAGE, { claimTrial: true });
  if (!a.active) throw locked('Your free trial has ended. Upgrade to premium or request an extension to keep chatting.');
  return a;
}

/** "Claim free trial" popup after signup: the 7 days start now. */
export async function claimTrial(userId) {
  const { trialDays } = await getSetting('subscription');
  const until = new Date(Date.now() + (trialDays || TRIAL_DAYS) * DAY);
  const updated = await User.findOneAndUpdate(
    { _id: userId, 'subscription.trialPending': true },
    { $set: { 'subscription.trialPending': false, 'subscription.trialEndsAt': until } },
    { returnDocument: 'after', lean: true },
  );
  if (!updated) throw ApiError.conflict('Your free trial was already claimed', 'TRIAL_ALREADY_CLAIMED');
  await invalidateAccess(userId);
  emitToUser(String(userId), 'user:updated', toSelfUser(updated));
  return accessOf(updated);
}

/**
 * Groups: own access, or the group's premium when the creator lets members use it.
 * Returns null when allowed, otherwise [code, message] (for the "can send" flags).
 */
export async function groupAccessBlock(userId, group) {
  const a = await getAccess(userId);
  if (a.accountState !== 'active') return ['ACCOUNT_BLOCKED', 'Your account is not active. Contact support.'];
  if (a.restricted) return ['ACCOUNT_RESTRICTED', RESTRICTED_MESSAGE];
  if (a.active) return null;
  if (group.settings?.members?.freeAccess && (await groupPremiumSource(group))) return null;
  if (a.access === 'unclaimed') return ['SUBSCRIPTION_REQUIRED', CLAIM_MESSAGE];
  return ['SUBSCRIPTION_REQUIRED', 'Your free trial has ended. Upgrade to premium to reply and open protected files in this group.'];
}

export async function requireGroupAccessPlan(userId, group) {
  const block = await groupAccessBlock(userId, group);
  if (block && block[0] !== 'SUBSCRIPTION_REQUIRED') throw ApiError.forbidden(block[1], block[0]);
  if (block) throw locked(block[1], block[1] === CLAIM_MESSAGE ? { claimTrial: true } : {});
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
  const cfg = await getSetting('subscription');
  if (!cfg.allowExtensionRequests) throw ApiError.forbidden('Extension requests are turned off right now', 'REQUESTS_DISABLED');
  if (kind === 'extension' && cfg.maxExtensions > 0) {
    const u = await User.findById(userId).select('subscription.extensionCount').lean();
    if ((u?.subscription?.extensionCount ?? 0) >= cfg.maxExtensions) {
      throw ApiError.forbidden(`You already used ${cfg.maxExtensions} extensions. Upgrade to premium to keep chatting.`, 'EXTENSION_LIMIT');
    }
  }
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
    { $set: { 'subscription.trialEndsAt': new Date(Date.now() + days * DAY), 'subscription.trialPending': false } },
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

export async function decideRequest(requestId, approve, days, { as, by } = {}) {
  const r = await ExtensionRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending' },
    { $set: { status: approve ? 'approved' : 'rejected', decidedAt: new Date(), decidedBy: by ?? null, grantedAs: approve ? (as ?? null) : null } },
    { returnDocument: 'after', lean: true },
  );
  if (!r) throw ApiError.notFound('Request not found or already decided');
  if (approve) {
    const kind = as ?? r.kind;
    await (kind === 'premium' ? grantPremium : grantExtension)(r.user, days ?? r.days);
    await User.updateOne(
      { _id: r.user },
      {
        $set: { 'subscription.grantedBy': by ? `Admin: ${by}` : 'Admin approval' },
        ...(kind === 'extension' ? { $inc: { 'subscription.extensionCount': 1 } } : {}),
      },
    );
    await invalidateAccess(r.user);
  }
  return requestDTO(r);
}

export async function pendingRequests() {
  const rows = await ExtensionRequest.find({ status: 'pending' }).sort({ _id: 1 }).limit(200).populate('user', 'name phone email').lean();
  return rows.map((r) => ({ ...requestDTO(r), user: { id: String(r.user?._id), name: r.user?.name, phone: r.user?.phone, email: r.user?.email } }));
}

/**
 * Admin "User Access": trial | free | premium | extended | locked.
 * days: premium / extended / trial length (ignored for free / locked).
 */
export async function setAccess(userId, access, days, by = null) {
  const set = { 'subscription.grantedBy': by ? `Admin: ${by}` : 'Admin approval' };
  const now = new Date();
  const until = days > 0 ? new Date(now.getTime() + days * DAY) : null;
  switch (access) {
    case 'premium':
      Object.assign(set, { 'subscription.premiumUntil': until ?? new Date(now.getTime() + 30 * DAY) });
      break;
    case 'extended':
      Object.assign(set, { 'subscription.extendedUntil': until ?? new Date(now.getTime() + 7 * DAY) });
      break;
    case 'trial':
      Object.assign(set, { 'subscription.trialEndsAt': until ?? new Date(now.getTime() + TRIAL_DAYS * DAY), 'subscription.trialPending': false });
      break;
    case 'free':
      Object.assign(set, { 'subscription.freeAccess': true });
      break;
    case 'locked':
      Object.assign(set, {
        'subscription.premiumUntil': null,
        'subscription.extendedUntil': null,
        'subscription.freeAccess': false,
        'subscription.trialEndsAt': now,
        'subscription.trialPending': false,
      });
      break;
    default:
      throw ApiError.badRequest('Unknown access type');
  }
  // Switching away from free removes the free flag so the chosen access shows.
  if (access !== 'free' && access !== 'locked') set['subscription.freeAccess'] = false;
  const updated = await User.findByIdAndUpdate(userId, { $set: set }, { returnDocument: 'after', lean: true });
  if (!updated) throw ApiError.notFound('User not found');
  await invalidateAccess(userId);
  emitToUser(String(userId), 'user:updated', toSelfUser(updated));
  return accessOf(updated);
}
