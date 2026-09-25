import { Router } from 'express';
import { z } from 'zod';

import { limiters, rateLimit } from '../../middlewares/rateLimit.js';
import { validate } from '../../middlewares/validate.js';
import * as auth from './auth.service.js';

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
  otpRequest: z.strictObject({ phone }),
  otpVerify: z.strictObject({
    phone,
    code: z.string().regex(/^\d{6}$/),
    name: z.string().trim().min(1).max(60).optional(),
  }),
  refresh: z.strictObject({ refreshToken: z.string().min(10) }),
  logout: z.strictObject({ refreshToken: z.string().min(10), all: z.boolean().optional() }),
};

const router = Router();
const ipLimit = rateLimit(limiters.auth, (req) => req.ip);

router.post('/register', ipLimit, validate({ body: schemas.register }), async (req, res) => {
  res.status(201).json({ ok: true, data: await auth.register(req.valid.body) });
});

router.post('/login', ipLimit, validate({ body: schemas.login }), async (req, res) => {
  res.json({ ok: true, data: await auth.login(req.valid.body) });
});

router.post(
  '/otp/request',
  ipLimit,
  validate({ body: schemas.otpRequest }),
  rateLimit(limiters.otp, (req) => req.valid.body.phone),
  async (req, res) => {
    res.json({ ok: true, data: await auth.requestOtp(req.valid.body) });
  },
);

router.post('/otp/verify', ipLimit, validate({ body: schemas.otpVerify }), async (req, res) => {
  res.json({ ok: true, data: await auth.verifyOtp(req.valid.body) });
});

router.post('/refresh', ipLimit, validate({ body: schemas.refresh }), async (req, res) => {
  res.json({ ok: true, data: await auth.refresh(req.valid.body.refreshToken) });
});

router.post('/logout', validate({ body: schemas.logout }), async (req, res) => {
  await auth.logout(req.valid.body.refreshToken, { all: req.valid.body.all });
  res.json({ ok: true, data: null });
});

export default router;
