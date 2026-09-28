import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { objectId } from '../../utils/validators.js';
import { normalizeIdentifier } from '../auth/identifier.js';
import { invalidateGroup } from '../groups/group.access.js';
import { Group, InviteLink } from '../groups/group.model.js';
import { User } from '../users/user.model.js';
import * as sub from './subscription.service.js';

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

// ---------------------------------------------------------------------------
// /subscription - the signed in user
// ---------------------------------------------------------------------------
export const subscriptionRouter = Router();

subscriptionRouter.get('/', async (req, res) => ok(res, await sub.status(req.user.id)));

subscriptionRouter.post(
  '/requests',
  validate({
    body: z.strictObject({
      kind: z.enum(['extension', 'premium']).default('extension'),
      reason: z.string().trim().max(500).default(''),
      days: z.number().int().min(1).max(365).default(7),
    }),
  }),
  async (req, res) => ok(res, await sub.requestExtension(req.user.id, req.valid.body), 201),
);

// ---------------------------------------------------------------------------
// /admin - platform admin (header x-admin-key = ADMIN_API_KEY). Disabled when no key is set.
// ---------------------------------------------------------------------------
export const adminRouter = Router();

adminRouter.use((req, _res, next) => {
  const expected = env.ADMIN_API_KEY;
  const given = String(req.get('x-admin-key') ?? '');
  if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return next(ApiError.notFound('Not found'));
  }
  next();
});

async function findUser(identifier) {
  const id = String(identifier).trim();
  const byId = /^[a-f0-9]{24}$/i.test(id) ? await User.findById(id).select('_id').lean() : null;
  if (byId) return byId._id;
  const norm = normalizeIdentifier(id);
  const u = await User.findOne(norm ? { [norm.kind]: norm.value } : { username: id.toLowerCase() }).select('_id').lean();
  if (!u) throw ApiError.notFound('User not found');
  return u._id;
}

adminRouter.get('/requests', async (_req, res) => ok(res, await sub.pendingRequests()));

adminRouter.post(
  '/requests/:id',
  validate({ params: z.object({ id: objectId }), body: z.strictObject({ approve: z.boolean(), days: z.number().int().min(1).max(365).optional() }) }),
  async (req, res) => ok(res, await sub.decideRequest(req.valid.params.id, req.valid.body.approve, req.valid.body.days)),
);

adminRouter.post(
  '/users/access',
  validate({
    body: z.strictObject({
      user: z.string().trim().min(3).max(100), // id, mobile number, email or username
      kind: z.enum(['premium', 'extension', 'trial']),
      days: z.number().int().min(0).max(3650), // 0 removes
    }),
  }),
  async (req, res) => {
    const { user, kind, days } = req.valid.body;
    const uid = await findUser(user);
    const fn = { premium: sub.grantPremium, extension: sub.grantExtension, trial: sub.setTrial }[kind];
    ok(res, await fn(uid, days));
  },
);

/** Approve a group as premium: its members can use it without their own plan (if the creator allows). */
export async function setGroupPremium(groupOrCode, approved, days) {
  const ref = String(groupOrCode).trim();
  let groupId = /^[a-f0-9]{24}$/i.test(ref) ? ref : null;
  if (!groupId) groupId = (await InviteLink.findOne({ code: ref.toUpperCase() }).select('group').lean())?.group;
  if (!groupId) throw ApiError.notFound('Group not found');
  const g = await Group.findByIdAndUpdate(
    groupId,
    { $set: { 'premium.approved': approved, 'premium.approvedAt': approved ? new Date() : null, 'premium.approvedUntil': approved && days ? new Date(Date.now() + days * 86_400_000) : null } },
    { returnDocument: 'after', lean: true },
  );
  if (!g) throw ApiError.notFound('Group not found');
  await invalidateGroup(groupId);
  return { groupId: String(g._id), name: g.name, premium: g.premium };
}

adminRouter.post(
  '/groups/premium',
  validate({ body: z.strictObject({ group: z.string().trim().min(3).max(40), approved: z.boolean(), days: z.number().int().min(1).max(3650).optional() }) }),
  async (req, res) => ok(res, await setGroupPremium(req.valid.body.group, req.valid.body.approved, req.valid.body.days)),
);
