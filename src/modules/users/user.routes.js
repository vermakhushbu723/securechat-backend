import { Router } from 'express';
import { z } from 'zod';

import { validate } from '../../middlewares/validate.js';
import { objectId } from '../../utils/validators.js';
import { uploadPath } from '../chat/chat.schema.js';
import * as users from './user.service.js';

const schemas = {
  updateMe: z.strictObject({
    name: z.string().trim().min(1).max(60).optional(),
    displayName: z.string().trim().min(1).max(20).optional(),
    about: z.string().trim().max(140).optional(),
    businessAddress: z.string().trim().max(200).nullable().optional(),
    // Absolute URL or a file uploaded through /media/upload.
    avatarUrl: z.union([z.string().url().max(500), uploadPath]).nullable().optional(),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_.]{3,30}$/)
      .optional(),
    privacy: z
      .strictObject({
        lastSeen: z.enum(['everyone', 'nobody']).optional(),
        readReceipts: z.boolean().optional(),
        searchable: z.boolean().optional(),
      })
      .optional(),
  }),
  completeProfile: z.discriminatedUnion('accountType', [
    z.strictObject({ accountType: z.literal('personal'), name: z.string().trim().min(1).max(60) }),
    z.strictObject({
      accountType: z.literal('business'),
      businessName: z.string().trim().min(1).max(60),
      businessAddress: z.string().trim().min(3).max(200),
      bio: z.string().trim().max(140).default(''),
    }),
  ]),
  search: z.object({ q: z.string().trim().min(1).max(50), limit: z.coerce.number().int().min(1).max(50).default(20) }),
  presence: z.object({
    ids: z
      .string()
      .transform((s) => s.split(',').filter(Boolean))
      .pipe(z.array(objectId).min(1).max(100)),
  }),
  idParam: z.object({ id: objectId }),
  device: z.strictObject({ token: z.string().min(10).max(4096), platform: z.enum(['android', 'ios', 'web']) }),
};

const router = Router();

router.get('/me', async (req, res) => {
  res.json({ ok: true, data: await users.getMe(req.user.id) });
});

router.patch('/me', validate({ body: schemas.updateMe }), async (req, res) => {
  res.json({ ok: true, data: await users.updateMe(req.user.id, req.valid.body) });
});

router.post('/me/profile', validate({ body: schemas.completeProfile }), async (req, res) => {
  res.json({ ok: true, data: await users.completeProfile(req.user.id, req.valid.body) });
});

router.post('/me/devices', validate({ body: schemas.device }), async (req, res) => {
  await users.registerDevice(req.user.id, req.valid.body);
  res.json({ ok: true, data: null });
});

router.get('/search', validate({ query: schemas.search }), async (req, res) => {
  const { q, limit } = req.valid.query;
  res.json({ ok: true, data: await users.search(req.user.id, q, limit) });
});

router.get('/presence', validate({ query: schemas.presence }), async (req, res) => {
  res.json({ ok: true, data: await users.presence(req.user.id, req.valid.query.ids) });
});

router.get('/blocked', async (req, res) => {
  res.json({ ok: true, data: await users.listBlocked(req.user.id) });
});

router.get('/:id', validate({ params: schemas.idParam }), async (req, res) => {
  res.json({ ok: true, data: await users.getProfile(req.user.id, req.valid.params.id) });
});

router.post('/:id/block', validate({ params: schemas.idParam }), async (req, res) => {
  await users.block(req.user.id, req.valid.params.id);
  res.json({ ok: true, data: { blocked: true } });
});

router.delete('/:id/block', validate({ params: schemas.idParam }), async (req, res) => {
  await users.unblock(req.user.id, req.valid.params.id);
  res.json({ ok: true, data: { blocked: false } });
});

export default router;
