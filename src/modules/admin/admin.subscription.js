import { ApiError } from '../../utils/ApiError.js';
import { Group } from '../groups/group.model.js';
import { getSetting } from '../platform/platform.service.js';
import { ExtensionRequest } from '../subscription/extensionRequest.model.js';
import { accessOf, TRIAL_DAYS } from '../subscription/access.js';
import { invalidateAccess, setTrial } from '../subscription/subscription.service.js';
import { toSelfUser, User } from '../users/user.model.js';
import { emitToUser } from '../../socket/emitter.js';
import { accessQuery, DAY, findUserRef, internalId, like, paged, pageResult, USER_FIELDS, userRows } from './admin.common.js';
import { Coupon, Plan } from './admin.models.js';
import { listUsers } from './admin.users.js';

const notDeleted = { status: { $ne: 'deleted' } };

// ---------------------------------------------------------------------------
// Access counts (dashboard, trial page, user access page, analytics)
// ---------------------------------------------------------------------------
export async function accessCounts() {
  const types = ['trial', 'free', 'premium', 'extended', 'locked', 'unclaimed'];
  const counts = await Promise.all(types.map((t) => User.countDocuments({ $and: [notDeleted, accessQuery(t)] })));
  return Object.fromEntries(types.map((t, i) => [t, counts[i]]));
}

// ---------------------------------------------------------------------------
// Trial management
// ---------------------------------------------------------------------------
function trialWindow(filter, now = new Date()) {
  const in2 = new Date(now.getTime() + 2 * DAY);
  const ago30 = new Date(now.getTime() - 30 * DAY);
  const endsBetween = (a, b) => ({
    $or: [
      { 'subscription.trialEndsAt': { $gt: a, $lte: b } },
      { 'subscription.trialEndsAt': null, createdAt: { $gt: new Date(a.getTime() - TRIAL_DAYS * DAY), $lte: new Date(b.getTime() - TRIAL_DAYS * DAY) } },
    ],
  });
  const noPlan = { $nor: [accessQuery('premium'), accessQuery('extended'), accessQuery('free'), accessQuery('unclaimed')] };
  switch (filter) {
    case 'expiring':
      return { $and: [notDeleted, noPlan, endsBetween(now, in2)] };
    case 'expired':
      return { $and: [notDeleted, noPlan, endsBetween(ago30, now)] };
    case 'unclaimed':
      return { $and: [notDeleted, accessQuery('unclaimed')] };
    case 'active':
    case 'all':
    default:
      return { $and: [notDeleted, accessQuery('trial')] };
  }
}

export async function trialOverview(query) {
  const p = paged(query);
  const f = (query.filter ?? 'all').toLowerCase();
  const filter = trialWindow(f);
  if (query.q?.trim()) filter.$and.push({ $or: [{ name: like(query.q) }, { phone: like(query.q) }, { email: like(query.q) }] });
  const [rows, total, active, expiring, expired30, paid, everyone] = await Promise.all([
    User.find(filter).select(USER_FIELDS).sort({ _id: -1 }).skip(p.skip).limit(p.limit).lean(),
    User.countDocuments(filter),
    User.countDocuments(trialWindow('active')),
    User.countDocuments(trialWindow('expiring')),
    User.countDocuments(trialWindow('expired')),
    User.countDocuments({ ...notDeleted, 'subscription.premiumUntil': { $ne: null } }),
    User.countDocuments({ ...notDeleted, 'subscription.trialPending': { $ne: true } }),
  ]);
  return {
    ...pageResult(await userRows(rows), total, p),
    stats: { active, expiring, expired30, trialToPaid: everyone ? Math.round((paid / everyone) * 1000) / 10 : 0 },
    settings: await getSetting('subscription'),
  };
}

/** Trial page "Extend": adds days to the current trial end (or starts a new trial from now). */
export async function extendTrial(userRef, days) {
  const ref = await findUserRef(userRef);
  const u = await User.findById(ref._id).select('createdAt subscription').lean();
  const a = accessOf(u);
  const end = a.trialEndsAt ? Math.max(Date.now(), new Date(a.trialEndsAt).getTime()) : Date.now();
  const until = new Date(end + days * DAY);
  const updated = await User.findByIdAndUpdate(ref._id, { $set: { 'subscription.trialEndsAt': until, 'subscription.trialPending': false } }, { returnDocument: 'after', lean: true });
  await invalidateAccess(ref._id);
  emitToUser(String(ref._id), 'user:updated', toSelfUser(updated));
  return { name: ref.name, ...accessOf(updated) };
}

export async function endTrial(userRef) {
  const ref = await findUserRef(userRef);
  return { name: ref.name, ...(await setTrial(ref._id, 0)) };
}

// ---------------------------------------------------------------------------
// Plans + coupons
// ---------------------------------------------------------------------------
async function planDTO(p) {
  const subscribers = await User.countDocuments({ 'subscription.plan': String(p._id), 'subscription.premiumUntil': { $gt: new Date() } });
  return {
    id: String(p._id),
    name: p.name,
    price: p.price,
    currency: p.currency,
    period: p.period,
    durationDays: p.durationDays,
    features: p.features,
    visible: p.visible,
    popular: p.popular,
    archived: p.archived,
    subscribers,
  };
}

export async function listPlans({ includeArchived = false } = {}) {
  const rows = await Plan.find(includeArchived ? {} : { archived: false }).sort({ sort: 1, price: 1 }).lean();
  return Promise.all(rows.map(planDTO));
}

/** Public list for the app (visible, not archived). */
export async function publicPlans() {
  const rows = await Plan.find({ archived: false, visible: true }).sort({ sort: 1, price: 1 }).lean();
  return rows.map((p) => ({ id: String(p._id), name: p.name, price: p.price, currency: p.currency, period: p.period, durationDays: p.durationDays, features: p.features, popular: p.popular }));
}

export async function createPlan(input) {
  if (input.popular) await Plan.updateMany({}, { $set: { popular: false } });
  return planDTO((await Plan.create(input)).toObject());
}

export async function updatePlan(planId, patch) {
  if (patch.popular) await Plan.updateMany({ _id: { $ne: planId } }, { $set: { popular: false } });
  const p = await Plan.findByIdAndUpdate(planId, { $set: patch }, { returnDocument: 'after', lean: true });
  if (!p) throw ApiError.notFound('Plan not found');
  return planDTO(p);
}

const couponDTO = (c) => ({
  id: String(c._id),
  code: c.code,
  description: c.description,
  percentOff: c.percentOff,
  plan: c.plan ? String(c.plan) : null,
  expiresAt: c.expiresAt,
  maxUses: c.maxUses,
  uses: c.uses,
  active: c.active,
  state: !c.active ? 'Paused' : c.expiresAt && c.expiresAt <= new Date() ? 'Expired' : c.maxUses > 0 && c.uses >= c.maxUses ? 'Used up' : 'Active',
});

export async function listCoupons() {
  return (await Coupon.find({}).sort({ _id: -1 }).limit(200).lean()).map(couponDTO);
}

export async function createCoupon(input) {
  if (await Coupon.exists({ code: input.code.toUpperCase() })) throw ApiError.conflict('This coupon code already exists');
  return couponDTO((await Coupon.create(input)).toObject());
}

export async function updateCoupon(id, patch) {
  const c = await Coupon.findByIdAndUpdate(id, { $set: patch }, { returnDocument: 'after', lean: true });
  if (!c) throw ApiError.notFound('Coupon not found');
  return couponDTO(c);
}

export async function deleteCoupon(id) {
  const c = await Coupon.findByIdAndDelete(id).lean();
  if (!c) throw ApiError.notFound('Coupon not found');
  return { deleted: true, code: c.code };
}

// ---------------------------------------------------------------------------
// Extension requests
// ---------------------------------------------------------------------------
export async function listRequests(query) {
  const p = paged(query);
  const f = (query.status ?? 'pending').toLowerCase();
  const filter = f === 'all' ? {} : { status: f };
  if (query.q?.trim()) {
    const users = await User.find({ $or: [{ name: like(query.q) }, { phone: like(query.q) }, { email: like(query.q) }] }).select('_id').limit(500).lean();
    filter.user = { $in: users.map((u) => u._id) };
  }
  const [rows, total, pending] = await Promise.all([
    ExtensionRequest.find(filter).sort({ status: -1, _id: -1 }).skip(p.skip).limit(p.limit).lean(),
    ExtensionRequest.countDocuments(filter),
    ExtensionRequest.countDocuments({ status: 'pending' }),
  ]);
  const users = await User.find({ _id: { $in: rows.map((r) => r.user) } }).select('name phone email createdAt subscription avatarUrl').lean();
  const umap = new Map(users.map((u) => [String(u._id), u]));
  const items = rows.map((r) => {
    const u = umap.get(String(r.user));
    const a = u ? accessOf(u) : null;
    return {
      id: String(r._id),
      kind: r.kind,
      reason: r.reason,
      days: r.days,
      status: r.status,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      decidedBy: r.decidedBy ?? null,
      grantedAs: r.grantedAs ?? null,
      user: u
        ? { id: String(u._id), name: u.name, internalId: internalId(u._id), phone: u.phone ?? null, email: u.email ?? null, avatarUrl: u.avatarUrl ?? null, access: a.access, trialEndsAt: a.trialEndsAt, extensionCount: u.subscription?.extensionCount ?? 0 }
        : { id: String(r.user), name: 'Deleted user', internalId: internalId(r.user) },
    };
  });
  return { ...pageResult(items, total, p), pending };
}

// ---------------------------------------------------------------------------
// User access & group access
// ---------------------------------------------------------------------------
export async function accessOverview(query) {
  const [users, counts] = await Promise.all([listUsers({ ...query, filter: query.filter ?? 'all' }), accessCounts()]);
  return { ...users, counts };
}

export async function groupAccessList(query) {
  const p = paged(query);
  const filter = { status: { $ne: 'deleted' } };
  if (query.q?.trim()) filter.name = like(query.q);
  if (query.filter === 'premium') filter['premium.approved'] = true;
  const [rows, total] = await Promise.all([
    Group.find(filter).select('name memberCount premium settings.members.freeAccess createdBy status').sort({ 'premium.approved': -1, memberCount: -1 }).skip(p.skip).limit(p.limit).lean(),
    Group.countDocuments(filter),
  ]);
  return pageResult(
    rows.map((g) => ({
      id: String(g._id),
      name: g.name,
      memberCount: g.memberCount,
      status: g.status,
      premiumApproved: Boolean(g.premium?.approved),
      premiumUntil: g.premium?.approvedUntil ?? null,
      freeAccess: Boolean(g.settings?.members?.freeAccess),
    })),
    total,
    p,
  );
}
