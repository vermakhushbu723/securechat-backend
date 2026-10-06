import { Router } from 'express';
import { z } from 'zod';

import { limiters, rateLimit } from '../../middlewares/rateLimit.js';
import { validate } from '../../middlewares/validate.js';
import { objectId } from '../../utils/validators.js';
import { settingsInput } from '../groups/group.schema.js';
import { adminDeleteChain, adminFreezeChain } from '../groups/groupMessage.service.js';
import * as blocked from '../moderation/blockedTerm.service.js';
import { testPhone } from '../moderation/phoneGuard.service.js';
import { CONTENT_RULES, getSetting, updateSetting } from '../platform/platform.service.js';
import { decideRequest, grantExtension, grantPremium, setAccess, setTrial } from '../subscription/subscription.service.js';
import { setGroupPremium } from '../subscription/subscription.routes.js';
import { blockUser, deleteUser, forceLogout, restrictUser, suspendUser, unblockUser, warnUser } from '../users/moderation.service.js';
import { Group } from '../groups/group.model.js';
import { User } from '../users/user.model.js';
import { findUserRef, sendCsv } from './admin.common.js';
import * as authSvc from './admin.auth.js';
import { can, logAdmin, requireStaff, superAdminOnly } from './admin.auth.js';
import * as content from './admin.content.js';
import * as groups from './admin.groups.js';
import * as mail from './admin.mail.js';
import { AUDIENCES, CHANNELS, STAFF_ROLES } from './admin.models.js';
import * as reports from './admin.reports.js';
import * as search from './admin.search.js';
import * as subs from './admin.subscription.js';
import * as system from './admin.system.js';
import * as users from './admin.users.js';

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });
const idParam = z.object({ id: objectId });
const str = (max) => z.string().trim().max(max);
const listQuery = z.object({
  q: z.string().max(100).optional(),
  filter: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const bool = z.boolean().optional();
const userName = async (id) => (await User.findById(id).select('name').lean())?.name ?? String(id);
const groupName = async (id) => (await Group.findById(id).select('name').lean())?.name ?? String(id);

export const adminRouter = Router();

// ===========================================================================
// Auth (public)
// ===========================================================================
const ipLimit = rateLimit(limiters.auth, (req) => req.ip);

adminRouter.post('/auth/login', ipLimit, validate({ body: z.strictObject({ email: z.string().trim().email().max(120), password: z.string().min(1).max(128) }) }), async (req, res) =>
  ok(res, await authSvc.login(req.valid.body, req.ip)),
);

adminRouter.post('/auth/verify', ipLimit, validate({ body: z.strictObject({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }) }), async (req, res) =>
  ok(res, await authSvc.verify(req.valid.body, req.ip)),
);

// Everything below needs a staff session (or the x-admin-key).
adminRouter.use(requireStaff);

adminRouter.get('/auth/me', async (req, res) => ok(res, { ...req.staff, doc: undefined }));

adminRouter.patch('/auth/me', validate({ body: z.strictObject({ name: str(60).min(1).optional(), twoFactor: bool }) }), async (req, res) => {
  if (!req.staff.id) return ok(res, req.staff);
  const { staff } = await system.updateStaff(req.staff.id, req.valid.body, req.staff.id);
  logAdmin(req, req.valid.body.twoFactor === undefined ? 'Updated own profile' : `2-step verification ${req.valid.body.twoFactor ? 'on' : 'off'}`, 'auth');
  ok(res, { ...staff, permissions: req.staff.permissions });
});

adminRouter.post('/auth/password', validate({ body: z.strictObject({ current: z.string().min(1).max(128), next: z.string().min(8).max(128) }) }), async (req, res) => {
  const data = await authSvc.changePassword(req.staff.id, req.valid.body);
  logAdmin(req, 'Changed password', 'auth');
  ok(res, data);
});

adminRouter.post('/auth/logout', async (req, res) => {
  if (req.staff.id) {
    await authSvc.logoutEverywhere(req.staff.id);
    logAdmin(req, 'Logged out', 'auth');
  }
  ok(res, { loggedOut: true });
});

// ===========================================================================
// Dashboard + search (any staff)
// ===========================================================================
adminRouter.get('/dashboard', async (_req, res) => ok(res, await reports.dashboard()));
adminRouter.get('/search', validate({ query: z.object({ q: z.string().max(100).default('') }) }), async (req, res) => ok(res, await system.globalSearch(req.valid.query.q)));

// ===========================================================================
// Users
// ===========================================================================
adminRouter.get('/users', can('users'), validate({ query: listQuery }), async (req, res) => ok(res, await users.listUsers(req.valid.query)));

adminRouter.get('/users/export.csv', can('users'), validate({ query: listQuery }), async (req, res) => {
  const rows = await users.allUsersForExport(req.valid.query);
  logAdmin(req, 'Exported users (CSV)', 'users', { meta: { rows: rows.length, filter: req.valid.query.filter ?? 'all' } });
  sendCsv(
    res,
    `securechat-users-${new Date().toISOString().slice(0, 10)}.csv`,
    ['User ID', 'Name', 'Display name', 'Mobile', 'Email', 'Username', 'Access', 'Access until', 'Trial ends', 'Status', 'Warnings', 'Location', 'Joined'],
    rows.map((u) => [u.internalId, u.name, u.displayName, u.phone, u.email, u.username, u.access, u.accessUntil, u.trialEndsAt, u.status, u.warnings, u.locationMode, u.createdAt]),
  );
});

adminRouter.get('/users/blocked', can('users'), validate({ query: listQuery }), async (req, res) => ok(res, await users.listBlocked(req.valid.query)));

adminRouter.get('/users/:id', can('users'), validate({ params: idParam }), async (req, res) => {
  const data = await users.userDetail(req.valid.params.id);
  logAdmin(req, 'Viewed user profile', 'users', { target: data.name, targetId: data.id });
  ok(res, data);
});

adminRouter.patch(
  '/users/:id',
  can('users'),
  validate({ params: idParam, body: z.strictObject({ name: str(60).min(1).optional(), displayName: str(20).optional(), about: str(140).optional() }) }),
  async (req, res) => {
    const data = await users.updateUser(req.valid.params.id, req.valid.body);
    logAdmin(req, 'Edited user profile', 'users', { target: data.name, targetId: data.id, meta: req.valid.body });
    ok(res, data);
  },
);

const actionBody = z.strictObject({
  action: z.enum(['block', 'unblock', 'suspend', 'restrict', 'unrestrict', 'logout', 'warn', 'delete']),
  reason: str(300).optional(),
  days: z.number().int().min(1).max(365).optional(),
  hours: z.number().int().min(1).max(24 * 90).optional(),
});

adminRouter.post('/users/:id/action', can('users'), validate({ params: idParam, body: actionBody }), async (req, res) => {
  const { id } = req.valid.params;
  const { action, reason, days, hours } = req.valid.body;
  const name = await userName(id);
  const by = req.staff.name;
  const labels = {
    block: 'Blocked user',
    unblock: 'Unblocked user',
    suspend: `Suspended user for ${days ?? 7} days`,
    restrict: 'Restricted user to read only',
    unrestrict: 'Lifted read only restriction',
    logout: 'Forced logout on all devices',
    warn: 'Sent warning',
    delete: 'Deleted account',
  };
  let result = null;
  if (action === 'block') await blockUser(id, { reason, by });
  if (action === 'unblock') await unblockUser(id);
  if (action === 'suspend') await suspendUser(id, { days: days ?? 7, reason, by });
  if (action === 'restrict') await restrictUser(id, true, { hours: hours ?? null });
  if (action === 'unrestrict') await restrictUser(id, false);
  if (action === 'logout') await forceLogout(id);
  if (action === 'warn') result = await warnUser(id, reason || undefined);
  if (action === 'delete') result = await deleteUser(id, { by });
  logAdmin(req, labels[action], 'users', { target: name, targetId: id, meta: { reason, days, hours } });
  ok(res, action === 'delete' ? result : { ...(result ?? {}), user: await users.userDetail(id) });
});

adminRouter.get('/users/:id/activity', can('users'), validate({ params: idParam, query: z.object({ days: z.coerce.number().int().min(1).max(365).default(7), type: z.enum(['all', 'auth', 'messages', 'files', 'security']).default('all') }) }), async (req, res) => {
  const data = await users.userActivity(req.valid.params.id, req.valid.query);
  logAdmin(req, 'Viewed user activity', 'users', { target: await userName(req.valid.params.id), targetId: req.valid.params.id });
  ok(res, data);
});

adminRouter.get('/users/:id/location', can('users'), validate({ params: idParam }), async (req, res) => {
  const data = await users.userLocation(req.valid.params.id);
  logAdmin(req, 'Viewed user location', 'users', { target: data.name, targetId: req.valid.params.id });
  ok(res, data);
});

// User access (User Access screen + legacy CLI / e2e: kind premium | extension | trial)
adminRouter.post(
  '/users/access',
  can('subscriptions'),
  validate({
    body: z.strictObject({
      user: z.string().trim().min(3).max(100), // id, SC-XXXXXX, mobile number, email or username
      kind: z.enum(['premium', 'extension', 'extended', 'trial', 'free', 'locked']),
      days: z.number().int().min(0).max(3650).default(30),
    }),
  }),
  async (req, res) => {
    const { user, kind, days } = req.valid.body;
    const u = await findUserRef(user);
    let data;
    // Legacy semantics: premium / extension add days (0 removes), trial sets the end.
    if (kind === 'premium' && req.staff.id === null) data = await grantPremium(u._id, days);
    else if (kind === 'extension') data = await grantExtension(u._id, days);
    else if (kind === 'trial' && req.staff.id === null) data = await setTrial(u._id, days);
    else data = await setAccess(u._id, kind === 'extended' ? 'extended' : kind, days, req.staff.name);
    logAdmin(req, `Set access: ${kind}${['free', 'locked'].includes(kind) ? '' : ` (${days} days)`}`, 'subscriptions', { target: u.name, targetId: u._id });
    ok(res, data);
  },
);

// ===========================================================================
// Groups
// ===========================================================================
adminRouter.get('/groups', can('groups'), validate({ query: listQuery }), async (req, res) => ok(res, await groups.listGroups(req.valid.query)));

const groupBody = {
  name: str(50).min(1),
  description: str(300).optional(),
  category: str(40).optional(),
  rules: str(500).optional(),
  avatarUrl: z.string().max(500).nullable().optional(),
  settings: settingsInput.optional(),
};

adminRouter.post(
  '/groups',
  can('groups'),
  validate({
    body: z.strictObject({
      ...groupBody,
      creator: z.string().trim().min(3).max(100),
      invite: z.strictObject({ expiry: z.enum(['1h', '24h', '7d', '30d', 'never']).default('7d'), maxJoins: z.number().int().min(0).max(100_000).default(0), requireApproval: z.boolean().default(false) }).optional(),
    }),
  }),
  async (req, res) => {
    const body = { description: '', category: 'Other', rules: '', ...req.valid.body };
    const data = await groups.createGroupAsAdmin(body);
    logAdmin(req, 'Created group', 'groups', { target: data.group.name, targetId: data.group.id, meta: { creator: body.creator } });
    ok(res, data, 201);
  },
);

// Legacy: approve a group as premium by id or invite code.
adminRouter.post(
  '/groups/premium',
  can('subscriptions'),
  validate({ body: z.strictObject({ group: z.string().trim().min(3).max(40), approved: z.boolean(), days: z.number().int().min(1).max(3650).optional() }) }),
  async (req, res) => {
    const data = await setGroupPremium(req.valid.body.group, req.valid.body.approved, req.valid.body.days);
    logAdmin(req, req.valid.body.approved ? 'Approved group premium' : 'Removed group premium', 'subscriptions', { target: data.name, targetId: data.groupId });
    ok(res, data);
  },
);

adminRouter.get('/groups/:id', can('groups'), validate({ params: idParam }), async (req, res) => ok(res, await groups.groupDetail(req.valid.params.id)));

adminRouter.patch(
  '/groups/:id',
  can('groups'),
  validate({ params: idParam, body: z.strictObject({ ...groupBody, name: groupBody.name.optional(), creator: z.string().trim().min(3).max(100).optional() }) }),
  async (req, res) => {
    const data = await groups.updateGroup(req.valid.params.id, req.valid.body);
    logAdmin(req, 'Edited group', 'groups', { target: data.name, targetId: data.id, meta: Object.keys(req.valid.body) });
    ok(res, data);
  },
);

adminRouter.post('/groups/:id/status', can('groups'), validate({ params: idParam, body: z.strictObject({ suspended: z.boolean() }) }), async (req, res) => {
  const data = await groups.setGroupStatus(req.valid.params.id, req.valid.body.suspended);
  logAdmin(req, req.valid.body.suspended ? 'Suspended group' : 'Restored group', 'groups', { target: data.name, targetId: data.id });
  ok(res, data);
});

// Group-wise access: premium for every member ("Access for all members").
adminRouter.post(
  '/groups/:id/access',
  can('subscriptions'),
  validate({ params: idParam, body: z.strictObject({ premium: z.boolean(), days: z.number().int().min(1).max(3650).optional(), freeAccess: z.boolean().optional() }) }),
  async (req, res) => {
    const { premium, days, freeAccess } = req.valid.body;
    const data = await setGroupPremium(req.valid.params.id, premium, days);
    if (freeAccess !== undefined || premium) await groups.updateGroup(req.valid.params.id, { settings: { members: { freeAccess: freeAccess ?? premium } } });
    logAdmin(req, premium ? `Group premium for all members${days ? ` (${days} days)` : ''}` : 'Group access back to per user', 'subscriptions', { target: data.name, targetId: data.groupId });
    ok(res, data);
  },
);

adminRouter.delete('/groups/:id', can('groups'), validate({ params: idParam }), async (req, res) => {
  const data = await groups.deleteGroupAsAdmin(req.valid.params.id);
  logAdmin(req, 'Deleted group', 'groups', { target: data.name, targetId: req.valid.params.id });
  ok(res, data);
});

adminRouter.get('/groups/:id/members', can('groups'), validate({ params: idParam, query: z.object({ q: z.string().max(100).optional(), role: z.enum(['all', 'owner', 'admin', 'member']).optional() }) }), async (req, res) =>
  ok(res, await groups.listGroupMembers(req.valid.params.id, req.valid.query)),
);

adminRouter.post('/groups/:id/members', can('groups'), validate({ params: idParam, body: z.strictObject({ user: z.string().trim().min(3).max(100), role: z.enum(['member', 'admin']).default('member') }) }), async (req, res) => {
  const data = await groups.addGroupMember(req.valid.params.id, req.valid.body.user, req.valid.body.role);
  logAdmin(req, `Added member ${data.name}`, 'groups', { target: data.group, targetId: req.valid.params.id });
  ok(res, data, 201);
});

const memberParams = z.object({ id: objectId, userId: objectId });

adminRouter.patch('/groups/:id/members/:userId', can('groups'), validate({ params: memberParams, body: z.strictObject({ role: z.enum(['member', 'admin']).optional(), restricted: bool }) }), async (req, res) => {
  const data = await groups.updateGroupMember(req.valid.params.id, req.valid.params.userId, req.valid.body);
  const what = req.valid.body.role ? `Made ${data.name} ${req.valid.body.role}` : `${req.valid.body.restricted ? 'Muted' : 'Unmuted'} ${data.name}`;
  logAdmin(req, what, 'groups', { target: await groupName(req.valid.params.id), targetId: req.valid.params.id });
  ok(res, data);
});

adminRouter.delete('/groups/:id/members/:userId', can('groups'), validate({ params: memberParams }), async (req, res) => {
  const data = await groups.removeGroupMember(req.valid.params.id, req.valid.params.userId);
  logAdmin(req, `Removed member ${data.name}`, 'groups', { target: await groupName(req.valid.params.id), targetId: req.valid.params.id });
  ok(res, data);
});

adminRouter.get('/groups/:id/locations', can('groups'), validate({ params: idParam }), async (req, res) => {
  const data = await groups.groupLocations(req.valid.params.id);
  logAdmin(req, 'Viewed group locations', 'groups', { target: data.group.name, targetId: req.valid.params.id });
  ok(res, data);
});

// Invite links
adminRouter.get('/invites', can('groups'), validate({ query: listQuery }), async (req, res) => ok(res, await groups.listInvites(req.valid.query)));

adminRouter.post('/invites/:code/revoke', can('groups'), validate({ params: z.object({ code: z.string().trim().min(5).max(20) }) }), async (req, res) => {
  const data = await groups.revokeInviteAsAdmin(req.valid.params.code);
  logAdmin(req, `Revoked invite ${data.code}`, 'groups', { target: await groupName(data.groupId), targetId: data.groupId });
  ok(res, data);
});

// ===========================================================================
// Trial, plans, coupons, extension requests, access
// ===========================================================================
adminRouter.get('/trials', can('subscriptions'), validate({ query: listQuery }), async (req, res) => ok(res, await subs.trialOverview(req.valid.query)));

adminRouter.post(
  '/trials/:id',
  can('subscriptions'),
  validate({ params: idParam, body: z.strictObject({ action: z.enum(['extend', 'end', 'premium']), days: z.number().int().min(1).max(365).optional() }) }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { action, days } = req.valid.body;
    const cfg = await getSetting('subscription');
    let data;
    if (action === 'extend') data = await subs.extendTrial(id, days ?? cfg.defaultExtensionDays);
    if (action === 'end') data = await subs.endTrial(id);
    if (action === 'premium') data = { name: await userName(id), ...(await setAccess(id, 'premium', days ?? 30, req.staff.name)) };
    logAdmin(req, { extend: `Extended trial by ${days ?? cfg.defaultExtensionDays} days`, end: 'Ended trial', premium: `Granted premium (${days ?? 30} days)` }[action], 'subscriptions', { target: data.name, targetId: id });
    ok(res, data);
  },
);

const subscriptionSettings = z.strictObject({
  trialDays: z.number().int().min(1).max(90).optional(),
  afterExpiry: z.enum(['locked', 'limited']).optional(),
  remindBeforeExpiry: bool,
  allowExtensionRequests: bool,
  freeExtension: bool,
  premiumExtension: bool,
  defaultExtensionDays: z.number().int().min(1).max(365).optional(),
  maxExtensions: z.number().int().min(0).max(50).optional(),
});

adminRouter.get('/settings/subscription', can('subscriptions'), async (_req, res) => ok(res, await getSetting('subscription')));
adminRouter.put('/settings/subscription', can('subscriptions'), validate({ body: subscriptionSettings }), async (req, res) => {
  const data = await updateSetting('subscription', req.valid.body);
  logAdmin(req, 'Changed trial settings', 'settings', { meta: req.valid.body });
  ok(res, data);
});

const planBody = z.strictObject({
  name: str(40).min(1),
  price: z.number().min(0).max(1_000_000),
  currency: z.string().trim().length(3).default('INR'),
  period: z.enum(['month', 'year', 'week', 'custom']).default('month'),
  durationDays: z.number().int().min(1).max(3650),
  features: z.array(str(120).min(1)).max(20).default([]),
  visible: z.boolean().default(true),
  popular: z.boolean().default(false),
  archived: z.boolean().default(false),
});

adminRouter.get('/plans', can('subscriptions'), validate({ query: z.object({ archived: z.enum(['true', 'false']).optional() }) }), async (req, res) =>
  ok(res, await subs.listPlans({ includeArchived: req.valid.query.archived === 'true' })),
);
adminRouter.post('/plans', can('subscriptions'), validate({ body: planBody }), async (req, res) => {
  const data = await subs.createPlan(req.valid.body);
  logAdmin(req, 'Created plan', 'subscriptions', { target: data.name, targetId: data.id });
  ok(res, data, 201);
});
adminRouter.patch('/plans/:id', can('subscriptions'), validate({ params: idParam, body: planBody.partial() }), async (req, res) => {
  const data = await subs.updatePlan(req.valid.params.id, req.valid.body);
  logAdmin(req, req.valid.body.archived ? 'Archived plan' : 'Edited plan', 'subscriptions', { target: data.name, targetId: data.id });
  ok(res, data);
});

const couponBody = z.strictObject({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,20}$/, 'Code: 3-20 letters / digits'),
  description: str(120).default(''),
  percentOff: z.number().int().min(1).max(100),
  plan: objectId.nullable().default(null),
  expiresAt: z.coerce.date().nullable().default(null),
  maxUses: z.number().int().min(0).max(1_000_000).default(0),
  active: z.boolean().default(true),
});

adminRouter.get('/coupons', can('subscriptions'), async (_req, res) => ok(res, await subs.listCoupons()));
adminRouter.post('/coupons', can('subscriptions'), validate({ body: couponBody }), async (req, res) => {
  const data = await subs.createCoupon(req.valid.body);
  logAdmin(req, 'Created coupon', 'subscriptions', { target: data.code, targetId: data.id });
  ok(res, data, 201);
});
adminRouter.patch('/coupons/:id', can('subscriptions'), validate({ params: idParam, body: couponBody.partial() }), async (req, res) => {
  const data = await subs.updateCoupon(req.valid.params.id, req.valid.body);
  logAdmin(req, 'Edited coupon', 'subscriptions', { target: data.code, targetId: data.id });
  ok(res, data);
});
adminRouter.delete('/coupons/:id', can('subscriptions'), validate({ params: idParam }), async (req, res) => {
  const data = await subs.deleteCoupon(req.valid.params.id);
  logAdmin(req, 'Deleted coupon', 'subscriptions', { target: data.code, targetId: req.valid.params.id });
  ok(res, data);
});

adminRouter.get('/requests', can('subscriptions'), validate({ query: listQuery.extend({ status: z.enum(['pending', 'approved', 'rejected', 'all']).optional() }) }), async (req, res) =>
  ok(res, await subs.listRequests(req.valid.query)),
);

adminRouter.post(
  '/requests/:id',
  can('subscriptions'),
  validate({ params: idParam, body: z.strictObject({ approve: z.boolean(), days: z.number().int().min(1).max(365).optional(), as: z.enum(['extension', 'premium']).optional() }) }),
  async (req, res) => {
    const { approve, days, as } = req.valid.body;
    const data = await decideRequest(req.valid.params.id, approve, days, { as, by: req.staff.name });
    const label = approve ? `Approved ${as === 'premium' ? 'premium' : data.kind} request${days ? ` (${days} days)` : ''}` : 'Rejected extension request';
    logAdmin(req, label, 'subscriptions', { targetId: req.valid.params.id });
    ok(res, data);
  },
);

adminRouter.get('/access', can('subscriptions'), validate({ query: listQuery }), async (req, res) => ok(res, await subs.accessOverview(req.valid.query)));
adminRouter.get('/access/groups', can('subscriptions'), validate({ query: listQuery }), async (req, res) => ok(res, await subs.groupAccessList(req.valid.query)));

// ===========================================================================
// Location management
// ===========================================================================
adminRouter.get(
  '/locations',
  can('groups'),
  validate({ query: listQuery.extend({ groupId: objectId.optional(), status: z.enum(['all', 'live', 'stale', 'join']).optional() }) }),
  async (req, res) => {
    const data = await content.locationOverview(req.valid.query);
    logAdmin(req, 'Viewed location dashboard', 'groups', { meta: { groupId: req.valid.query.groupId ?? null } });
    ok(res, data);
  },
);

adminRouter.put(
  '/settings/location',
  can('settings'),
  validate({ body: z.strictObject({ showToAdmin: bool, showToMembers: bool, liveStatusVisible: bool, autoDeleteDays: z.number().int().min(0).max(365).optional() }) }),
  async (req, res) => {
    const data = await content.updateLocationSettings(req.valid.body);
    logAdmin(req, 'Changed location settings', 'settings', { meta: req.valid.body });
    ok(res, data);
  },
);

// ===========================================================================
// Message & content security
// ===========================================================================
adminRouter.get('/messages', can('messages'), validate({ query: listQuery.extend({ groupId: objectId.optional() }) }), async (req, res) => {
  const data = await content.monitorMessages(req.valid.query);
  logAdmin(req, 'Viewed message monitoring', 'messages', { meta: { filter: req.valid.query.filter ?? 'all', q: req.valid.query.q ?? null } });
  ok(res, data);
});

adminRouter.get('/forward-chains', can('messages'), validate({ query: listQuery }), async (req, res) => ok(res, await content.listChains(req.valid.query)));
adminRouter.get('/forward-chains/:id', can('messages'), validate({ params: idParam }), async (req, res) => ok(res, await content.chainDetail(req.valid.params.id)));

adminRouter.post('/forward-chains/:id/delete', can('messages'), validate({ params: idParam }), async (req, res) => {
  const data = await adminDeleteChain(req.valid.params.id);
  logAdmin(req, `Deleted chain from ${content.shortMsgId(req.valid.params.id)} (${data.deleted} copies)`, 'messages', { targetId: req.valid.params.id, meta: data });
  ok(res, data);
});

adminRouter.post('/forward-chains/:id/freeze', can('messages'), validate({ params: idParam, body: z.strictObject({ frozen: z.boolean().default(true) }) }), async (req, res) => {
  const detail = await content.chainDetail(req.valid.params.id);
  const data = await adminFreezeChain(detail.rootId, req.valid.body.frozen);
  logAdmin(req, `${req.valid.body.frozen ? 'Stopped' : 'Allowed'} forwarding of ${detail.shortRootId}`, 'messages', { targetId: detail.rootId });
  ok(res, data);
});

// Search Permissions: 1-to-1 user search + group member search (platform, user and group level).
adminRouter.get('/search-permissions', can('users'), validate({ query: listQuery }), async (req, res) => ok(res, await search.overview(req.valid.query)));
adminRouter.put('/search-permissions', can('users'), validate({ body: z.strictObject({ userSearch: bool, groupMemberSearch: bool }) }), async (req, res) => {
  const data = await search.setGlobal(req.valid.body);
  const what = Object.entries(req.valid.body).map(([k, v]) => `${k === 'userSearch' ? '1-to-1 user search' : 'Group member search'} ${v ? 'on' : 'off'}`).join(', ');
  logAdmin(req, `Search permissions: ${what}`, 'settings', { target: 'Everyone', meta: req.valid.body });
  ok(res, data);
});
adminRouter.post('/users/:id/search', can('users'), validate({ params: idParam, body: z.strictObject({ allowed: z.boolean() }) }), async (req, res) => {
  const data = await search.setUserSearch(req.valid.params.id, req.valid.body.allowed);
  logAdmin(req, req.valid.body.allowed ? 'Allowed search' : 'Turned off search', 'users', { target: data.name, targetId: data.id });
  ok(res, data);
});
adminRouter.post('/users/:id/search-visibility', can('users'), validate({ params: idParam, body: z.strictObject({ hidden: z.boolean() }) }), async (req, res) => {
  const data = await search.setUserHidden(req.valid.params.id, req.valid.body.hidden);
  logAdmin(req, req.valid.body.hidden ? 'Hid user from search' : 'Showed user in search again', 'users', { target: data.name, targetId: data.id });
  ok(res, data);
});
adminRouter.post('/groups/:id/member-search', can('groups'), validate({ params: idParam, body: z.strictObject({ enabled: z.boolean() }) }), async (req, res) => {
  const data = await search.setGroupMemberSearch(req.valid.params.id, req.valid.body.enabled);
  logAdmin(req, `Member search ${req.valid.body.enabled ? 'on' : 'off'}`, 'groups', { target: data.name, targetId: data.id });
  ok(res, data);
});

// Blocked Keywords: words / sentences / links that cannot be sent in 1-to-1 chats or groups.
adminRouter.get('/blocked-terms', can('messages'), validate({ query: listQuery.extend({ type: z.enum(['all', 'word', 'sentence', 'link', 'inactive']).optional() }) }), async (req, res) =>
  ok(res, await blocked.listTerms({ q: req.valid.query.q, type: req.valid.query.type, page: req.valid.query.page, limit: req.valid.query.limit })),
);
adminRouter.post(
  '/blocked-terms',
  can('messages'),
  validate({
    body: z.strictObject({
      texts: z.array(z.string().trim().min(1).max(300)).min(1).max(500),
      partial: z.boolean().default(false),
      scope: z.enum(['all', 'direct', 'groups']).default('all'),
    }),
  }),
  async (req, res) => {
    const data = await blocked.addTerms(req.valid.body.texts, { partial: req.valid.body.partial, scope: req.valid.body.scope, createdBy: req.staff.name });
    if (data.added.length) logAdmin(req, `Added ${data.added.length} blocked keyword${data.added.length === 1 ? '' : 's'}`, 'messages', { target: data.added.map((t) => t.text).join(', ').slice(0, 200) });
    ok(res, data, 201);
  },
);
// Mobile number protection (always on): score + reasons for a sample message.
adminRouter.post('/phone/test', can('messages'), validate({ body: z.strictObject({ text: z.string().max(4096) }) }), async (req, res) => ok(res, testPhone(req.valid.body.text)));
adminRouter.post('/blocked-terms/test', can('messages'), validate({ body: z.strictObject({ text: z.string().max(4096) }) }), async (req, res) => ok(res, await blocked.testText(req.valid.body.text)));
adminRouter.patch(
  '/blocked-terms/:id',
  can('messages'),
  validate({ params: idParam, body: z.strictObject({ active: bool, partial: bool, scope: z.enum(['all', 'direct', 'groups']).optional() }) }),
  async (req, res) => {
    const data = await blocked.updateTerm(req.valid.params.id, req.valid.body);
    logAdmin(req, req.valid.body.active === false ? 'Turned off blocked keyword' : req.valid.body.active ? 'Turned on blocked keyword' : 'Edited blocked keyword', 'messages', { target: data.text, targetId: data.id });
    ok(res, data);
  },
);
adminRouter.delete('/blocked-terms/:id', can('messages'), validate({ params: idParam }), async (req, res) => {
  const data = await blocked.deleteTerm(req.valid.params.id);
  logAdmin(req, 'Removed blocked keyword', 'messages', { target: data.text, targetId: req.valid.params.id });
  ok(res, data);
});

adminRouter.get('/moderation/log', can('messages'), validate({ query: listQuery.extend({ rule: z.enum(['all', 'keyword', 'phone', ...CONTENT_RULES]).optional() }) }), async (req, res) =>
  ok(res, await content.blockedLog(req.valid.query)),
);

// Moderation actions from the blocked log: warn / restrict in group / block / restrict group.
adminRouter.post(
  '/moderation/action',
  can('messages'),
  validate({ body: z.strictObject({ action: z.enum(['warn', 'restrict_member', 'block_user', 'suspend_group']), userId: objectId.optional(), groupId: objectId.optional() }) }),
  async (req, res) => {
    const { action, userId, groupId } = req.valid.body;
    let data;
    if (action === 'warn') data = await warnUser(userId);
    if (action === 'restrict_member') data = await groups.updateGroupMember(groupId, userId, { restricted: true });
    if (action === 'block_user') data = await blockUser(userId, { reason: 'Content policy violations', by: req.staff.name }).then((u) => ({ name: u.name }));
    if (action === 'suspend_group') data = await groups.setGroupStatus(groupId, true);
    const labels = { warn: 'Sent warning', restrict_member: 'Restricted member in group', block_user: 'Blocked user', suspend_group: 'Suspended group' };
    logAdmin(req, labels[action], action === 'suspend_group' ? 'groups' : 'users', { target: data?.name ?? null, targetId: userId ?? groupId });
    ok(res, data);
  },
);

const contentBody = z.strictObject({
  globalRules: z.array(z.enum(CONTENT_RULES)).max(CONTENT_RULES.length).optional(),
  abuseEnabled: bool,
  abuseWords: z.array(z.string().trim().min(1).max(60)).max(2000).optional(),
  hinglish: bool,
  misspellings: bool,
  sensitivity: z.number().int().min(1).max(3).optional(),
  hindiNumbers: bool,
  normalization: bool,
  maxWarnings: z.number().int().min(1).max(50).optional(),
  muteAfter: z.number().int().min(0).max(50).optional(),
  suspendAfter: z.number().int().min(0).max(50).optional(),
  phoneRestrictAfter: z.number().int().min(0).max(50).optional(),
});

adminRouter.get('/settings/content', can('messages'), async (_req, res) => ok(res, await content.getContent()));
adminRouter.put('/settings/content', can('messages'), validate({ body: contentBody }), async (req, res) => {
  const data = await content.updateContent(req.valid.body);
  logAdmin(req, 'Changed content policy', 'settings', { meta: Object.keys(req.valid.body) });
  ok(res, data);
});

adminRouter.post('/content/test', can('messages'), validate({ body: z.strictObject({ text: z.string().max(2000), rules: z.array(z.enum(CONTENT_RULES)).optional() }) }), async (req, res) =>
  ok(res, await content.testContent(req.valid.body.text, req.valid.body.rules)),
);

const securityValues = z.strictObject(Object.fromEntries(
  ['publicMessages', 'privateMessages', 'publicForwarding', 'privateForwarding', 'chainDeletion', 'deleteForwardedCopies', 'downloadDisabled', 'externalShareDisabled', 'copyDisabled', 'secureViewer', 'noPublicFileUrl', 'screenshotProtection', 'screenRecordingProtection', 'blockCasting', 'printRestriction', 'dynamicWatermark'].map((k) => [k, bool]),
));
const securityQuery = z.object({ scope: z.enum(['global', 'group', 'user']).default('global'), targetId: objectId.optional() });

adminRouter.get('/settings/security', can('settings'), validate({ query: securityQuery }), async (req, res) => ok(res, await content.getSecurity(req.valid.query.scope, req.valid.query.targetId)));
adminRouter.put('/settings/security', can('settings'), validate({ query: securityQuery, body: securityValues }), async (req, res) => {
  const { scope, targetId } = req.valid.query;
  const data = await content.updateSecurity(scope, targetId, req.valid.body);
  logAdmin(req, `Changed ${scope} security settings`, 'settings', { target: data.target?.name ?? 'Global', targetId: targetId ?? null, meta: req.valid.body });
  ok(res, data);
});

// ===========================================================================
// Reports + analytics
// ===========================================================================
adminRouter.get('/reports', can('reports'), validate({ query: listQuery.extend({ type: z.string().max(20).optional(), status: z.string().max(20).optional() }) }), async (req, res) =>
  ok(res, await reports.listReports(req.valid.query)),
);
adminRouter.get('/reports/:id', can('reports'), validate({ params: idParam }), async (req, res) => ok(res, await reports.reportDetail(req.valid.params.id)));
adminRouter.post('/reports/:id', can('reports'), validate({ params: idParam, body: z.strictObject({ action: z.enum(['resolve', 'reject', 'review', 'warn', 'block']), note: str(500).optional() }) }), async (req, res) => {
  const data = await reports.decideReport(req.valid.params.id, req.valid.body, req.staff.name);
  logAdmin(req, `Report ${data.shortId}: ${req.valid.body.action}`, 'reports', { target: data.target?.name ?? null, targetId: req.valid.params.id, meta: { note: req.valid.body.note } });
  ok(res, data);
});

const daysQuery = z.object({ days: z.coerce.number().int().min(7).max(90).default(14) });
adminRouter.get('/analytics', can('reports'), validate({ query: daysQuery }), async (req, res) => ok(res, await reports.analytics(req.valid.query.days)));
adminRouter.get('/analytics/export.csv', can('reports'), validate({ query: daysQuery }), async (req, res) => {
  const a = await reports.analytics(req.valid.query.days);
  logAdmin(req, 'Exported analytics (CSV)', 'reports', { meta: { days: a.days } });
  sendCsv(res, `securechat-analytics-${a.days}d.csv`, ['Day', 'New users', 'Messages'], a.newUsers.map((d, i) => [d.day, d.count, a.messages[i]?.count ?? 0]));
});

// ===========================================================================
// Notifications, audit logs, staff, system
// ===========================================================================
adminRouter.get('/notifications', can('settings'), validate({ query: listQuery }), async (req, res) => ok(res, await system.listNotifications(req.valid.query)));
adminRouter.post(
  '/notifications',
  can('settings'),
  validate({
    body: z.strictObject({
      title: str(80).min(1),
      body: str(500).min(1),
      audience: z.enum(AUDIENCES).default('all'),
      channels: z.array(z.enum(CHANNELS)).min(1).max(4),
      scheduledAt: z.coerce.date().nullable().optional(),
    }),
  }),
  async (req, res) => {
    const data = await system.createNotification(req.valid.body, req.staff.name);
    logAdmin(req, data.status === 'scheduled' ? 'Scheduled notification' : 'Sent notification', 'settings', { target: data.title, targetId: data.id, meta: { audience: data.audience, recipients: data.recipients } });
    ok(res, data, 201);
  },
);
adminRouter.post('/notifications/:id/cancel', can('settings'), validate({ params: idParam }), async (req, res) => {
  const data = await system.cancelNotification(req.valid.params.id);
  logAdmin(req, 'Cancelled scheduled notification', 'settings', { target: data.title, targetId: data.id });
  ok(res, data);
});

const auditQuery = listQuery.extend({ category: z.string().max(20).optional(), days: z.coerce.number().int().min(1).max(3650).optional() });
adminRouter.get('/audit-logs', can('settings'), validate({ query: auditQuery }), async (req, res) => ok(res, await system.listAudit(req.valid.query)));
adminRouter.get('/audit-logs/export.csv', can('settings'), validate({ query: auditQuery }), async (req, res) => {
  const rows = await system.auditForExport(req.valid.query);
  logAdmin(req, 'Exported audit logs (CSV)', 'settings', { meta: { rows: rows.length } });
  sendCsv(res, 'securechat-audit-logs.csv', ['Time', 'Actor', 'Action', 'Category', 'Target', 'IP address'], rows.map((l) => [l.at, l.actor, l.action, l.category, l.target, l.ip]));
});

adminRouter.get('/staff', async (_req, res) => ok(res, await system.listStaff()));
adminRouter.post(
  '/staff',
  superAdminOnly,
  validate({ body: z.strictObject({ name: str(60).min(1), email: z.string().trim().toLowerCase().email().max(120), role: z.enum(STAFF_ROLES), password: z.string().min(8).max(128).optional() }) }),
  async (req, res) => {
    const data = await system.createStaff(req.valid.body, req.staff.name);
    logAdmin(req, `Added staff (${data.staff.role})`, 'staff', { target: data.staff.name, targetId: data.staff.id });
    ok(res, data, 201);
  },
);
adminRouter.patch(
  '/staff/:id',
  superAdminOnly,
  validate({ params: idParam, body: z.strictObject({ name: str(60).min(1).optional(), role: z.enum(STAFF_ROLES).optional(), status: z.enum(['active', 'suspended']).optional(), twoFactor: bool, resetPassword: bool }) }),
  async (req, res) => {
    const data = await system.updateStaff(req.valid.params.id, req.valid.body, req.staff.id);
    logAdmin(req, req.valid.body.resetPassword ? 'Reset staff password' : 'Edited staff', 'staff', { target: data.staff.name, targetId: data.staff.id, meta: { ...req.valid.body, resetPassword: undefined } });
    ok(res, data);
  },
);
adminRouter.delete('/staff/:id', superAdminOnly, validate({ params: idParam }), async (req, res) => {
  const data = await system.deleteStaff(req.valid.params.id, req.staff.id);
  logAdmin(req, 'Removed staff', 'staff', { target: data.name, targetId: req.valid.params.id });
  ok(res, data);
});

adminRouter.get('/roles', async (_req, res) => ok(res, await system.getRoles()));
adminRouter.put(
  '/roles',
  superAdminOnly,
  validate({ body: z.strictObject({ roles: z.record(z.enum(['moderator', 'support']), z.array(z.enum(['users', 'groups', 'messages', 'subscriptions', 'reports', 'settings']))) }) }),
  async (req, res) => {
    const data = await system.updateRoles(req.valid.body.roles);
    logAdmin(req, 'Changed role permissions', 'staff', { meta: req.valid.body.roles });
    ok(res, data);
  },
);

const systemBody = z.strictObject({
  verification: z.enum(['mobile', 'email', 'mobile_email']).optional(),
  openRegistration: bool,
  maxDevices: z.number().int().min(1).max(20).optional(),
  otpExpiryMin: z.number().int().min(1).max(30).optional(),
  directChat: bool,
  userSearch: bool,
  groupMemberSearch: bool,
  hideContactFromMembers: bool,
  autoStartingName: bool,
  pwaInstallable: bool,
  flagSecure: bool,
  minAppVersion: z.string().trim().regex(/^\d+\.\d+\.\d+$/).optional(),
  maxFileMb: z.number().int().min(1).max(500).optional(),
  fileTokenMin: z.number().int().min(1).max(1440).optional(),
  auditRetentionDays: z.number().int().min(30).max(3650).optional(),
  maintenance: bool,
  maintenanceMessage: str(200).optional(),
});

adminRouter.get('/settings/system', can('settings'), async (_req, res) => ok(res, await system.getSystem()));
adminRouter.put('/settings/system', can('settings'), validate({ body: systemBody }), async (req, res) => {
  const data = await system.updateSystem(req.valid.body);
  logAdmin(req, req.valid.body.maintenance === undefined ? 'Changed system settings' : `Maintenance mode ${req.valid.body.maintenance ? 'on' : 'off'}`, 'settings', { meta: req.valid.body });
  ok(res, data);
});
// Email Accounts: mailbox pool for OTP codes and notices (rotation + failover).
adminRouter.get('/mail-accounts', can('settings'), async (_req, res) => ok(res, await mail.listAccounts()));
adminRouter.post(
  '/mail-accounts',
  can('settings'),
  validate({
    body: z.strictObject({
      accounts: z.array(z.strictObject({ email: z.string().trim().toLowerCase().email().max(120), password: z.string().min(1).max(200) })).min(1).max(100),
      host: z.string().trim().min(3).max(120).default('smtp.hostinger.com'),
      port: z.number().int().min(1).max(65535).default(465), // Hostinger: 465 (SSL) or 587 (STARTTLS)
      dailyLimit: z.number().int().min(1).max(100_000).default(500),
    }),
  }),
  async (req, res) => {
    const { accounts, ...opts } = req.valid.body;
    const data = await mail.addAccounts(accounts, opts);
    logAdmin(req, `Email accounts: ${data.added.length} added, ${data.updated.length} updated`, 'settings', { target: [...data.added, ...data.updated].join(', ').slice(0, 200) });
    ok(res, data, 201);
  },
);
adminRouter.patch(
  '/mail-accounts/:id',
  can('settings'),
  validate({
    params: idParam,
    body: z.strictObject({ active: bool, dailyLimit: z.number().int().min(1).max(100_000).optional(), password: z.string().min(1).max(200).optional(), host: z.string().trim().min(3).max(120).optional(), port: z.number().int().min(1).max(65535).optional() }),
  }),
  async (req, res) => {
    const data = await mail.updateAccount(req.valid.params.id, req.valid.body);
    logAdmin(req, req.valid.body.password ? 'Changed mailbox password' : 'Edited mailbox', 'settings', { target: data.email, targetId: data.id });
    ok(res, data);
  },
);
adminRouter.delete('/mail-accounts/:id', can('settings'), validate({ params: idParam }), async (req, res) => {
  const data = await mail.deleteAccount(req.valid.params.id);
  logAdmin(req, 'Removed mailbox', 'settings', { target: data.email, targetId: req.valid.params.id });
  ok(res, data);
});
adminRouter.post('/mail-accounts/:id/test', can('settings'), validate({ params: idParam, body: z.strictObject({ to: z.string().trim().toLowerCase().email().max(120) }) }), async (req, res) =>
  ok(res, await mail.sendTest(req.valid.params.id, req.valid.body.to)),
);
adminRouter.post('/mail-accounts/:id/ready', can('settings'), validate({ params: idParam }), async (req, res) => ok(res, await mail.makeReady(req.valid.params.id)));

adminRouter.get('/system/health', can('settings'), async (_req, res) => ok(res, await system.systemHealth()));
