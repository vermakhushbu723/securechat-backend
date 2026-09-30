import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';

import { env } from '../../config/env.js';
import { redis } from '../../db/redis.js';
import { sendOtpEmail } from '../../services/mail.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt.js';
import { getSetting } from '../platform/platform.service.js';
import { accountState, toSelfUser, User } from '../users/user.model.js';

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

export async function revokeAll(userId) {
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
  if (!user || accountState(user) !== 'active') throw ApiError.unauthorized('Account not available');
  return issueTokens(sub);
}

export async function logout(refreshToken, { all = false } = {}) {
  const { sub, jti } = verifyRefreshToken(refreshToken);
  if (all) return revokeAll(sub);
  await redis.multi().del(rtKey(sub, jti)).srem(rtSetKey(sub), jti).exec();
}

function assertCanSignIn(user) {
  const state = accountState(user);
  if (state === 'suspended') {
    const until = user.moderation?.suspendedUntil ? new Date(user.moderation.suspendedUntil).toDateString() : 'further notice';
    throw ApiError.forbidden(`Your account is suspended until ${until}`, 'ACCOUNT_SUSPENDED');
  }
  if (state !== 'active') throw ApiError.forbidden('Account is blocked', 'ACCOUNT_BLOCKED');
}

/** Admin System Settings "Open registration" off: no new accounts. */
async function assertRegistrationOpen() {
  const sys = await getSetting('system');
  if (!sys.openRegistration) throw ApiError.forbidden('New registrations are closed right now', 'REGISTRATION_CLOSED');
}

// ---------------------------------------------------------------------------
// Password auth
// ---------------------------------------------------------------------------
export async function register({ name, username, phone, email, password }) {
  const or = [username && { username }, phone && { phone }, email && { email }].filter(Boolean);
  if (or.length && (await User.exists({ $or: or }))) {
    throw ApiError.conflict('Username, phone or email already registered', 'ALREADY_REGISTERED');
  }
  await assertRegistrationOpen();
  const user = await User.create({
    name,
    username,
    phone,
    email,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    subscription: { trialPending: true },
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
  assertCanSignIn(user);
  return { user: toSelfUser(user), ...(await issueTokens(user._id)) };
}

// ---------------------------------------------------------------------------
// OTP auth (mobile number or email ID). Code is stored hashed in Redis with TTL + attempt limit.
// ---------------------------------------------------------------------------
const OTP_TTL = 300;
const OTP_MAX_ATTEMPTS = 5;
const otpKey = (value) => `otp:${value}`;
const hash = (v) => createHash('sha256').update(v).digest();

/** j***a@gmail.com */
function maskEmail(email) {
  const [name, domain] = email.split('@');
  return `${name[0]}${'*'.repeat(Math.max(1, name.length - 2))}${name.length > 1 ? name.at(-1) : ''}@${domain}`;
}

/** Mobile number + email must belong to the same account (or both be new). */
async function checkPair(phone, email) {
  const [byPhone, byEmail] = await Promise.all([
    User.findOne({ phone }).select('email').lean(),
    User.findOne({ email }).select('phone').lean(),
  ]);
  if (byPhone?.email && byPhone.email !== email) {
    throw ApiError.conflict(`This mobile number is linked to ${maskEmail(byPhone.email)}. Enter that email ID.`, 'EMAIL_MISMATCH');
  }
  if (byEmail && String(byEmail._id) !== String(byPhone?._id)) {
    throw ApiError.conflict('This email ID is linked to another mobile number.', 'EMAIL_IN_USE');
  }
  return byPhone;
}

export async function requestOtp(target) {
  const { kind, value } = target;
  if (kind === 'pair') await checkPair(target.phone, target.email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await redis.set(otpKey(value), JSON.stringify({ h: hash(code).toString('hex'), a: 0 }), 'EX', OTP_TTL);
  // Mobile + email login: the code goes to the email. (Plug an SMS provider here for phone-only login.)
  const emailTo = kind === 'pair' ? target.email : kind === 'email' ? value : null;
  const emailed = emailTo ? await sendOtpEmail(emailTo, code) : false;
  return {
    kind: kind === 'pair' ? 'email' : kind,
    sentTo: emailTo ?? value,
    emailed,
    expiresIn: OTP_TTL,
    ...(env.OTP_DEV_MODE ? { devCode: code } : {}),
  };
}

/** Existing account -> login. New account -> created with profileCompleted=false (Personal / Business step next). */
export async function verifyOtp({ kind, value, code, name, phone, email }) {
  const raw = await redis.get(otpKey(value));
  if (!raw) throw ApiError.badRequest('Code expired, request a new one');
  const state = JSON.parse(raw);
  if (state.a >= OTP_MAX_ATTEMPTS) {
    await redis.del(otpKey(value));
    throw ApiError.tooMany('Too many attempts, request a new code');
  }
  const ok = timingSafeEqual(Buffer.from(state.h, 'hex'), hash(code));
  if (!ok) {
    state.a += 1;
    await redis.set(otpKey(value), JSON.stringify(state), 'KEEPTTL');
    throw ApiError.badRequest('Invalid code');
  }
  await redis.del(otpKey(value));

  let user;
  let isNew = false;
  if (kind === 'pair') {
    user = await checkPair(phone, email);
    if (user && !user.email) await User.updateOne({ _id: user._id }, { $set: { email } });
    user = user ? await User.findById(user._id).lean() : null;
    if (!user) {
      await assertRegistrationOpen();
      isNew = true;
      user = (await User.create({ phone, email, name: name ?? `User ${phone.slice(-4)}`, profileCompleted: false, subscription: { trialPending: true } })).toObject();
    }
  } else {
    user = await User.findOne({ [kind]: value }).lean();
    isNew = !user;
    if (isNew) {
      await assertRegistrationOpen();
      const fallback = kind === 'phone' ? `User ${value.slice(-4)}` : value.split('@')[0].slice(0, 60);
      user = (await User.create({ [kind]: value, name: name ?? fallback, profileCompleted: false, subscription: { trialPending: true } })).toObject();
    }
  }
  assertCanSignIn(user);
  const self = toSelfUser(user);
  return { isNew, profileCompleted: self.profileCompleted, user: self, ...(await issueTokens(user._id)) };
}
