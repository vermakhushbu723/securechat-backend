import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';

import { env } from '../../config/env.js';
import { redis } from '../../db/redis.js';
import { ApiError } from '../../utils/ApiError.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt.js';
import { toSelfUser, User } from '../users/user.model.js';

const BCRYPT_ROUNDS = 10;
const refreshTtlSec = () => env.JWT_REFRESH_TTL_DAYS * 86_400;
const rtKey = (uid, jti) => `rt:${uid}:${jti}`;
const rtSetKey = (uid) => `rtset:${uid}`;

// ---------------------------------------------------------------------------
// Tokens: short lived access JWT + rotating refresh JWT tracked in Redis
// ---------------------------------------------------------------------------
async function issueTokens(userId) {
  const accessToken = signAccessToken(userId);
  const { token: refreshToken, jti } = signRefreshToken(userId);
  await redis
    .multi()
    .set(rtKey(userId, jti), '1', 'EX', refreshTtlSec())
    .sadd(rtSetKey(userId), jti)
    .expire(rtSetKey(userId), refreshTtlSec())
    .exec();
  return { accessToken, refreshToken };
}

async function revokeAll(userId) {
  const jtis = await redis.smembers(rtSetKey(userId));
  const pipe = redis.pipeline();
  for (const jti of jtis) pipe.del(rtKey(userId, jti));
  pipe.del(rtSetKey(userId));
  await pipe.exec();
}

export async function refresh(refreshToken) {
  const { sub, jti } = verifyRefreshToken(refreshToken);
  const removed = await redis.del(rtKey(sub, jti));
  if (!removed) {
    // A rotated token was presented again -> treat as theft, log out everywhere.
    await revokeAll(sub);
    throw ApiError.unauthorized('Refresh token reuse detected');
  }
  await redis.srem(rtSetKey(sub), jti);
  const user = await User.findById(sub).lean();
  if (!user || user.status !== 'active') throw ApiError.unauthorized('Account not available');
  return issueTokens(sub);
}

export async function logout(refreshToken, { all = false } = {}) {
  const { sub, jti } = verifyRefreshToken(refreshToken);
  if (all) return revokeAll(sub);
  await redis.multi().del(rtKey(sub, jti)).srem(rtSetKey(sub), jti).exec();
}

// ---------------------------------------------------------------------------
// Password auth
// ---------------------------------------------------------------------------
export async function register({ name, username, phone, email, password }) {
  const or = [username && { username }, phone && { phone }, email && { email }].filter(Boolean);
  if (or.length && (await User.exists({ $or: or }))) {
    throw ApiError.conflict('Username, phone or email already registered', 'ALREADY_REGISTERED');
  }
  const user = await User.create({
    name,
    username,
    phone,
    email,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
  });
  return { user: toSelfUser(user), ...(await issueTokens(user._id)) };
}

export async function login({ identifier, password }) {
  const id = identifier.trim().toLowerCase();
  const user = await User.findOne({ $or: [{ email: id }, { username: id }, { phone: identifier.trim() }] })
    .select('+passwordHash')
    .lean();
  // Same error for unknown user and wrong password (no account enumeration).
  if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    throw ApiError.unauthorized('Invalid credentials');
  }
  if (user.status !== 'active') throw ApiError.forbidden('Account is blocked', 'ACCOUNT_BLOCKED');
  return { user: toSelfUser(user), ...(await issueTokens(user._id)) };
}

// ---------------------------------------------------------------------------
// OTP auth (phone). Code is stored hashed in Redis with TTL + attempt limit.
// ---------------------------------------------------------------------------
const OTP_TTL = 300;
const OTP_MAX_ATTEMPTS = 5;
const otpKey = (phone) => `otp:${phone}`;
const hash = (v) => createHash('sha256').update(v).digest();

export async function requestOtp({ phone }) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await redis.set(otpKey(phone), JSON.stringify({ h: hash(code).toString('hex'), a: 0 }), 'EX', OTP_TTL);
  // Plug an SMS provider here. In dev mode the code is returned to the client.
  return { expiresIn: OTP_TTL, ...(env.OTP_DEV_MODE ? { devCode: code } : {}) };
}

export async function verifyOtp({ phone, code, name }) {
  const raw = await redis.get(otpKey(phone));
  if (!raw) throw ApiError.badRequest('Code expired, request a new one');
  const state = JSON.parse(raw);
  if (state.a >= OTP_MAX_ATTEMPTS) {
    await redis.del(otpKey(phone));
    throw ApiError.tooMany('Too many attempts, request a new code');
  }
  const ok = timingSafeEqual(Buffer.from(state.h, 'hex'), hash(code));
  if (!ok) {
    state.a += 1;
    await redis.set(otpKey(phone), JSON.stringify(state), 'KEEPTTL');
    throw ApiError.badRequest('Invalid code');
  }
  await redis.del(otpKey(phone));

  let user = await User.findOne({ phone }).lean();
  const isNew = !user;
  if (isNew) user = (await User.create({ phone, name: name ?? `User ${phone.slice(-4)}` })).toObject();
  if (user.status !== 'active') throw ApiError.forbidden('Account is blocked', 'ACCOUNT_BLOCKED');
  return { isNew, user: toSelfUser(user), ...(await issueTokens(user._id)) };
}
