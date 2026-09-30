import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../db/redis.js';
import { sendOtpEmail } from '../../services/mail.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { getSetting } from '../platform/platform.service.js';
import { AdminLog, PERMISSIONS, Staff, staffDTO } from './admin.models.js';

/**
 * Admin panel auth: email + password, then a 6 digit code sent to the staff email
 * (2-step verification). Staff tokens are separate from app user tokens (typ "staff").
 * The legacy `x-admin-key` header (CLI / scripts) acts as a super admin.
 */
const STAFF_TTL = '12h';
const CODE_TTL = 300;
const MAX_ATTEMPTS = 5;
const BCRYPT_ROUNDS = 10;
const challengeKey = (id) => `admin2fa:${id}`;
const hash = (v) => createHash('sha256').update(v).digest('hex');

export const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);

function signStaffToken(staff) {
  return jwt.sign({ typ: 'staff', v: staff.tokenVersion ?? 0, role: staff.role }, env.JWT_ACCESS_SECRET, {
    subject: String(staff._id),
    expiresIn: STAFF_TTL,
  });
}

async function session(staff) {
  await Staff.updateOne({ _id: staff._id }, { $set: { lastActiveAt: new Date() } });
  return { token: signStaffToken(staff), staff: { ...staffDTO(staff), permissions: await permissionsOf(staff.role) } };
}

export async function permissionsOf(role) {
  if (role === 'super_admin') return [...PERMISSIONS];
  const roles = await getSetting('roles');
  return (roles[role] ?? []).filter((p) => PERMISSIONS.includes(p));
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
export async function login({ email, password }, ip) {
  const staff = await Staff.findOne({ email: email.toLowerCase().trim() }).select('+passwordHash').lean();
  if (!staff || !(await bcrypt.compare(password, staff.passwordHash))) throw ApiError.unauthorized('Invalid email or password');
  if (staff.status !== 'active') throw ApiError.forbidden('This admin account is suspended', 'STAFF_SUSPENDED');
  if (!staff.twoFactor) {
    logAdmin({ staff, ip }, 'Logged in', 'auth');
    return { twoFactor: false, ...(await session(staff)) };
  }
  const challengeId = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await redis.set(challengeKey(challengeId), JSON.stringify({ s: String(staff._id), h: hash(code), a: 0 }), 'EX', CODE_TTL);
  const emailed = await sendOtpEmail(staff.email, code).catch((err) => {
    logger.warn({ err: err.message }, 'Admin 2-step email failed');
    return false;
  });
  return {
    twoFactor: true,
    challengeId,
    sentTo: staff.email.replace(/^(.).*(@.*)$/, '$1***$2'),
    emailed,
    expiresIn: CODE_TTL,
    ...(env.OTP_DEV_MODE ? { devCode: code } : {}),
  };
}

export async function verify({ challengeId, code }, ip) {
  const raw = await redis.get(challengeKey(challengeId));
  if (!raw) throw ApiError.badRequest('Code expired, sign in again');
  const state = JSON.parse(raw);
  if (state.a >= MAX_ATTEMPTS) {
    await redis.del(challengeKey(challengeId));
    throw ApiError.tooMany('Too many attempts, sign in again');
  }
  if (!timingSafeEqual(Buffer.from(state.h, 'hex'), Buffer.from(hash(code), 'hex'))) {
    state.a += 1;
    await redis.set(challengeKey(challengeId), JSON.stringify(state), 'KEEPTTL');
    throw ApiError.badRequest('Invalid code');
  }
  await redis.del(challengeKey(challengeId));
  const staff = await Staff.findById(state.s).lean();
  if (!staff || staff.status !== 'active') throw ApiError.forbidden('This admin account is suspended', 'STAFF_SUSPENDED');
  logAdmin({ staff, ip }, 'Logged in', 'auth');
  return session(staff);
}

export async function changePassword(staffId, { current, next }) {
  const staff = await Staff.findById(staffId).select('+passwordHash').lean();
  if (!staff || !(await bcrypt.compare(current, staff.passwordHash))) throw ApiError.badRequest('Current password is wrong');
  // New password logs out other sessions (token version +1) and returns a fresh token.
  const updated = await Staff.findByIdAndUpdate(staffId, { $set: { passwordHash: await hashPassword(next) }, $inc: { tokenVersion: 1 } }, { returnDocument: 'after', lean: true });
  return session(updated);
}

export async function logoutEverywhere(staffId) {
  await Staff.updateOne({ _id: staffId }, { $inc: { tokenVersion: 1 } });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
function apiKeyMatches(given) {
  const expected = env.ADMIN_API_KEY;
  if (!expected || !given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Staff token (Authorization: Bearer) or the legacy x-admin-key. Sets req.staff. */
export async function requireStaff(req, _res, next) {
  const key = String(req.get('x-admin-key') ?? '');
  if (key) {
    if (!apiKeyMatches(key)) throw ApiError.notFound('Not found');
    req.staff = { id: null, name: 'System (API key)', role: 'super_admin', permissions: [...PERMISSIONS] };
    return next();
  }
  const [scheme, token] = String(req.get('authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw ApiError.unauthorized('Sign in to the admin panel');
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (payload.typ !== 'staff') throw new Error('wrong token type');
  } catch {
    throw ApiError.unauthorized('Admin session expired, sign in again');
  }
  const staff = await Staff.findById(payload.sub).lean();
  if (!staff || staff.status !== 'active' || (staff.tokenVersion ?? 0) !== payload.v) throw ApiError.unauthorized('Admin session expired, sign in again');
  req.staff = { id: String(staff._id), name: staff.name, email: staff.email, role: staff.role, permissions: await permissionsOf(staff.role), doc: staff };
  // Last active (at most once a minute per staff).
  if (!staff.lastActiveAt || Date.now() - new Date(staff.lastActiveAt).getTime() > 60_000) {
    Staff.updateOne({ _id: staff._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
  }
  next();
}

/** Route guard: the staff role must include the permission (Role permissions table). */
export const can = (permission) => (req, _res, next) => {
  if (!req.staff?.permissions.includes(permission)) throw ApiError.forbidden(`Your role cannot manage ${permission}`, 'NO_PERMISSION');
  next();
};

export const superAdminOnly = (req, _res, next) => {
  if (req.staff?.role !== 'super_admin') throw ApiError.forbidden('Only a super admin can do this', 'NO_PERMISSION');
  next();
};

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
/** Fire-and-forget admin audit entry. `who` = req (uses req.staff / req.ip) or { staff, ip }. */
export function logAdmin(who, action, category, { target = null, targetId = null, meta } = {}) {
  const s = who.staff?.doc ?? who.staff ?? {};
  AdminLog.create({
    staff: s._id ?? (who.staff?.id || null),
    staffName: s.name ?? who.staff?.name ?? 'System',
    action,
    category,
    target,
    targetId: targetId ? String(targetId) : null,
    ip: who.ip ?? null,
    meta,
  }).catch((err) => logger.warn({ err: err.message, action }, 'Admin audit write failed'));
}
