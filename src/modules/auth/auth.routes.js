import { Router } from 'express';
import { z } from 'zod';

import { limiters, rateLimit } from '../../middlewares/rateLimit.js';
import { validate } from '../../middlewares/validate.js';
import { audit } from '../audit/audit.service.js';
import * as auth from './auth.service.js';
import { normalizeIdentifier } from './identifier.js';

const phone = z.string().trim().regex(/^\+?[0-9]{8,15}$/, 'Invalid phone number');
const password = z.string().min(8, 'Password must be at least 8 characters').max(128);

const schemas = {
  register: z
    .strictObject({
      name: z.string().trim().min(1).max(60),
      username: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9_.]{3,30}$/, 'Username: 3-30 chars, a-z 0-9 _ .')
        .optional(),
      phone: phone.optional(),
      email: z.string().trim().toLowerCase().email().optional(),
      password,
    })
    .refine((b) => b.username || b.phone || b.email, { message: 'Provide username, phone or email' }),
  login: z.strictObject({ identifier: z.string().trim().min(3).max(100), password: z.string().min(1).max(128) }),
  // Login: mobile number + email ID -> code sent to the email (`identifier` alone = one field login,
  // `phone` alone kept for older app builds).
  otpRequest: z
    .strictObject({
      identifier: z.string().trim().min(3).max(100).optional(),
      phone: z.string().trim().min(3).max(20).optional(),
      email: z.string().trim().min(3).max(100).optional(),
    })
    .refine((b) => b.identifier || b.phone, { message: 'Enter your mobile number' })
    .transform((b, ctx) => toTarget(b, ctx)),
  otpVerify: z
    .strictObject({
      identifier: z.string().trim().min(3).max(100).optional(),
      phone: z.string().trim().min(3).max(20).optional(),
      email: z.string().trim().min(3).max(100).optional(),
      code: z.string().regex(/^\d{6}$/),
      name: z.string().trim().min(1).max(60).optional(),
    })
    .refine((b) => b.identifier || b.phone, { message: 'Enter your mobile number' })
    .transform((b, ctx) => {
      const t = toTarget(b, ctx);
      return t === z.NEVER ? t : { ...t, code: b.code, name: b.name };
    }),
  refresh: z.strictObject({ refreshToken: z.string().min(10) }),
  logout: z.strictObject({ refreshToken: z.string().min(10), all: z.boolean().optional() }),
};

/**
 * `{ kind, value }` for one field login, or `{ kind: 'pair', phone, email, value }` when both the
 * mobile number and the email ID are given (the code goes to the email).
 */
function toTarget(b, ctx) {
  if (b.phone && b.email) {
    const p = normalizeIdentifier(b.phone);
    const e = normalizeIdentifier(b.email);
    if (p?.kind !== 'phone') ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Enter a valid mobile number' });
    if (e?.kind !== 'email') ctx.addIssue({ code: 'custom', path: ['email'], message: 'Enter a valid email ID' });
    if (p?.kind !== 'phone' || e?.kind !== 'email') return z.NEVER;
    return { kind: 'pair', phone: p.value, email: e.value, value: `${p.value}|${e.value}` };
  }
  const id = normalizeIdentifier(b.identifier ?? b.phone ?? b.email);
  if (!id) {
    ctx.addIssue({ code: 'custom', path: ['identifier'], message: 'Enter a valid mobile number or email ID' });
    return z.NEVER;
  }
  return id;
}

/** Login events for the admin "User Activity" timeline. */
function logLogin(req, data) {
  if (data?.user?.id) audit(data.user.id, 'login', { meta: { ip: req.ip, ua: String(req.get('user-agent') ?? '').slice(0, 160) } });
  return data;
}

const router = Router();
const ipLimit = rateLimit(limiters.auth, (req) => req.ip);

router.post('/register', ipLimit, validate({ body: schemas.register }), async (req, res) => {
  res.status(201).json({ ok: true, data: logLogin(req, await auth.register(req.valid.body)) });
});

router.post('/login', ipLimit, validate({ body: schemas.login }), async (req, res) => {
  res.json({ ok: true, data: logLogin(req, await auth.login(req.valid.body)) });
});

router.post(
  '/otp/request',
  ipLimit,
  validate({ body: schemas.otpRequest }),
  rateLimit(limiters.otp, (req) => req.valid.body.value),
  async (req, res) => {
    res.json({ ok: true, data: await auth.requestOtp(req.valid.body) });
  },
);

router.post('/otp/verify', ipLimit, validate({ body: schemas.otpVerify }), async (req, res) => {
  res.json({ ok: true, data: logLogin(req, await auth.verifyOtp(req.valid.body)) });
});

router.post('/refresh', ipLimit, validate({ body: schemas.refresh }), async (req, res) => {
  res.json({ ok: true, data: await auth.refresh(req.valid.body.refreshToken) });
});

router.post('/logout', validate({ body: schemas.logout }), async (req, res) => {
  await auth.logout(req.valid.body.refreshToken, { all: req.valid.body.all });
  res.json({ ok: true, data: null });
});

export default router;
