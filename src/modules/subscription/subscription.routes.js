import { Router } from 'express';
import { z } from 'zod';

import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../utils/ApiError.js';
import { invalidateGroup } from '../groups/group.access.js';
import { Group, InviteLink } from '../groups/group.model.js';
import { publicPlans } from '../admin/admin.subscription.js';
import * as sub from './subscription.service.js';

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

// ---------------------------------------------------------------------------
// /subscription - the signed in user
// ---------------------------------------------------------------------------
export const subscriptionRouter = Router();

subscriptionRouter.get('/', async (req, res) => ok(res, await sub.status(req.user.id)));

// Premium plans created in the admin panel (visible ones).
subscriptionRouter.get('/plans', async (_req, res) => ok(res, await publicPlans()));

subscriptionRouter.post('/claim-trial', async (req, res) => ok(res, await sub.claimTrial(req.user.id)));

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
