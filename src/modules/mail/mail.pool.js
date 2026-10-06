import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import mongoose from 'mongoose';
import nodemailer from 'nodemailer';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../db/redis.js';
import { ApiError } from '../../utils/ApiError.js';

/**
 * Outgoing email through a pool of mailboxes (otp0@ ... otp11@prosecurely.online on Hostinger).
 * Every email goes out from the next mailbox (round robin, shared through Redis across
 * servers). A mailbox that is busy, rate limited or failing is cooled down and the email
 * is sent from the next one right away. Each mailbox has a daily limit so no single account
 * hits the provider's sending limit.
 */
const { Schema } = mongoose;

const mailAccountSchema = new Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    host: { type: String, default: 'smtp.hostinger.com' },
    port: { type: Number, default: 465 },
    secure: { type: Boolean, default: true }, // 465 = SSL, 587 = STARTTLS
    pass: { type: String, required: true, select: false }, // AES-256-GCM: iv.tag.data (hex)
    active: { type: Boolean, default: true },
    dailyLimit: { type: Number, default: 500 },
    totalSent: { type: Number, default: 0 },
    lastSentAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const MailAccount = mongoose.model('MailAccount', mailAccountSchema);

// ---------------------------------------------------------------------------
// Password encryption (FILE_ENCRYPTION_KEY, 32 bytes hex)
// ---------------------------------------------------------------------------
const KEY = Buffer.from(env.FILE_ENCRYPTION_KEY, 'hex');

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('hex')}.${c.getAuthTag().toString('hex')}.${data.toString('hex')}`;
}

function decryptSecret(blob) {
  const [iv, tag, data] = String(blob).split('.');
  const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Accounts: admin panel (DB) + optional .env account (SMTP_HOST / SMTP_USER / SMTP_PASS)
// ---------------------------------------------------------------------------
const VERSION_KEY = 'mail:accounts:version';
let cache = { at: 0, version: null, accounts: [] };
const transports = new Map(); // id -> { key, transport }

const today = () => new Date().toISOString().slice(0, 10);
const sentKey = (id) => `mail:sent:${id}:${today()}`;
const coolKey = (id) => `mail:cool:${id}`;

export async function invalidateAccounts() {
  await redis.set(VERSION_KEY, String(Date.now()));
  cache = { at: 0, version: null, accounts: [] };
}

async function loadAccounts() {
  const version = await redis.get(VERSION_KEY);
  if (Date.now() - cache.at < 30_000 && cache.version === version) return cache.accounts;
  const rows = await MailAccount.find({ active: true }).select('+pass').sort({ email: 1 }).lean();
  const accounts = [];
  for (const r of rows) {
    try {
      accounts.push({ id: String(r._id), email: r.email, host: r.host, port: r.port, secure: r.secure, user: r.email, pass: decryptSecret(r.pass), dailyLimit: r.dailyLimit, source: 'admin', key: `${r.updatedAt?.getTime?.() ?? 0}` });
    } catch (err) {
      logger.warn({ email: r.email, err: err.message }, 'Mail account password could not be decrypted');
    }
  }
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && !accounts.some((a) => a.email === env.SMTP_USER.toLowerCase())) {
    accounts.push({ id: 'env', email: env.SMTP_USER.toLowerCase(), host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465, user: env.SMTP_USER, pass: env.SMTP_PASS, dailyLimit: 1_000_000, source: 'env', key: 'env' });
  }
  cache = { at: Date.now(), version, accounts };
  return accounts;
}

export async function mailEnabled() {
  return (await loadAccounts()).length > 0;
}

function transportFor(a) {
  const hit = transports.get(a.id);
  if (hit && hit.key === a.key) return hit.transport;
  const transport = nodemailer.createTransport({
    host: a.host,
    port: a.port,
    secure: a.secure,
    auth: { user: a.user, pass: a.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
    tls: { servername: a.host },
  });
  transports.set(a.id, { key: a.key, transport });
  return transport;
}

/**
 * How long a mailbox rests after an error, or null when the error is about the
 * recipient (the next mailbox would fail the same way).
 */
function classify(err) {
  const code = err?.code;
  const rc = Number(err?.responseCode) || 0;
  const text = `${err?.response ?? ''} ${err?.message ?? ''}`.toLowerCase();
  if (code === 'EAUTH' || rc === 535 || rc === 534) return { coolSec: 3600, reason: 'Login failed - check the mailbox password' };
  if (/rate|limit|too many|quota|throttl|try again later|busy/.test(text) || [421, 450, 451, 452, 454].includes(rc)) {
    return { coolSec: 600, reason: 'Busy / sending limit reached' };
  }
  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ECONNRESET', 'EPROTOCOL'].includes(code) || rc === 0) {
    return { coolSec: 300, reason: 'Could not connect to the mail server' };
  }
  if (rc === 550 || rc === 553 || rc === 501) return null; // bad / unknown recipient
  return { coolSec: 300, reason: `Mail server error ${rc || code || ''}`.trim() };
}

function recordError(a, reason) {
  if (a.source !== 'admin') return;
  MailAccount.updateOne({ _id: a.id }, { $set: { lastError: reason, lastErrorAt: new Date() } }).catch(() => {});
}

/**
 * Sends one email from the next available mailbox. Tries the other mailboxes when one
 * fails. Returns { from } or throws 503 EMAIL_UNAVAILABLE when none could send it.
 */
export async function sendFromPool({ to, subject, text, html }) {
  const accounts = await loadAccounts();
  if (!accounts.length) throw new ApiError(503, 'EMAIL_NOT_CONFIGURED', 'Email sending is not set up');
  const start = (await redis.incr('mail:rr')) % accounts.length;
  const order = [...accounts.slice(start), ...accounts.slice(0, start)];
  const cooling = await redis.mget(order.map((a) => coolKey(a.id)));
  const counts = await redis.mget(order.map((a) => sentKey(a.id)));
  const errors = [];
  for (const [i, a] of order.entries()) {
    if (cooling[i]) continue; // resting after an error
    if ((Number(counts[i]) || 0) >= a.dailyLimit) continue; // daily limit reached
    try {
      await transportFor(a).sendMail({ from: { name: env.MAIL_FROM_NAME || 'SecureChat', address: a.email }, to, subject, text, html });
      await redis.multi().incr(sentKey(a.id)).expire(sentKey(a.id), 172_800).exec();
      if (a.source === 'admin') MailAccount.updateOne({ _id: a.id }, { $inc: { totalSent: 1 }, $set: { lastSentAt: new Date() } }).catch(() => {});
      return { from: a.email };
    } catch (err) {
      const c = classify(err);
      logger.warn({ mailbox: a.email, code: err.code, responseCode: err.responseCode, err: err.message }, 'Mailbox failed, trying the next one');
      if (!c) throw new ApiError(400, 'EMAIL_REJECTED', 'This email address does not accept mail. Check the email ID.');
      await redis.set(coolKey(a.id), c.reason, 'EX', c.coolSec);
      recordError(a, c.reason);
      errors.push(`${a.email}: ${c.reason}`);
    }
  }
  logger.error({ errors }, 'No mailbox could send the email');
  throw new ApiError(503, 'EMAIL_UNAVAILABLE', 'We could not send the email right now. Please try again in a minute.');
}

/** Sends a test email from one specific mailbox (admin "Test"). */
export async function testAccount(id, to) {
  const accounts = await loadAccounts();
  let a = accounts.find((x) => x.id === String(id));
  if (!a) {
    const r = await MailAccount.findById(id).select('+pass').lean();
    if (!r) throw ApiError.notFound('Mailbox not found');
    a = { id: String(r._id), email: r.email, host: r.host, port: r.port, secure: r.secure, user: r.email, pass: decryptSecret(r.pass), dailyLimit: r.dailyLimit, source: 'admin', key: `test${Date.now()}` };
  }
  try {
    await transportFor(a).sendMail({
      from: { name: env.MAIL_FROM_NAME || 'SecureChat', address: a.email },
      to,
      subject: 'SecureChat test email',
      text: `This test email was sent from ${a.email}. Email sending works.`,
    });
    await redis.del(coolKey(a.id));
    MailAccount.updateOne({ _id: a.id }, { $set: { lastError: null, lastErrorAt: null, lastSentAt: new Date() }, $inc: { totalSent: 1 } }).catch(() => {});
    return { ok: true, from: a.email };
  } catch (err) {
    const c = classify(err) ?? { reason: 'The recipient address was rejected' };
    recordError(a, c.reason);
    return { ok: false, from: a.email, error: `${c.reason} (${err.responseCode ?? err.code ?? 'error'}: ${String(err.response ?? err.message).slice(0, 160)})` };
  }
}

/** Admin list: every mailbox with today's count and cooldown. */
export async function poolStatus() {
  const rows = await MailAccount.find({}).sort({ email: 1 }).lean();
  const ids = rows.map((r) => String(r._id));
  const [counts, cool, ttl] = await Promise.all([
    ids.length ? redis.mget(ids.map(sentKey)) : [],
    ids.length ? redis.mget(ids.map(coolKey)) : [],
    Promise.all(ids.map((id) => redis.ttl(coolKey(id)))),
  ]);
  return rows.map((r, i) => ({
    id: ids[i],
    email: r.email,
    host: r.host,
    port: r.port,
    secure: r.secure,
    active: r.active,
    dailyLimit: r.dailyLimit,
    sentToday: Number(counts[i]) || 0,
    totalSent: r.totalSent,
    lastSentAt: r.lastSentAt,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt,
    coolingReason: cool[i] ?? null,
    coolingSeconds: ttl[i] > 0 ? ttl[i] : 0,
    status: !r.active ? 'Off' : cool[i] ? 'Resting' : (Number(counts[i]) || 0) >= r.dailyLimit ? 'Daily limit' : 'Ready',
  }));
}

export async function clearCooldown(id) {
  await redis.del(coolKey(id));
}
