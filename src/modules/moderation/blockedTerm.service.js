import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import { redis } from '../../db/redis.js';
import { getIO } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { compile, findBlocked, normalize, normalizeLink, typeOf } from '../../utils/blockedTerms.js';
import { escapeRegex } from '../../utils/validators.js';
import { audit } from '../audit/audit.service.js';

const { Schema } = mongoose;

/** Admin "Blocked Keywords": words / sentences / links that cannot be sent. */
const blockedTermSchema = new Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 300 },
    key: { type: String, required: true, unique: true }, // normalised text (no duplicates)
    type: { type: String, enum: ['word', 'sentence', 'link'], required: true },
    partial: { type: Boolean, default: false }, // also inside longer words
    scope: { type: String, enum: ['all', 'direct', 'groups'], default: 'all' },
    active: { type: Boolean, default: true },
    hits: { type: Number, default: 0 },
    lastHitAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
  },
  { timestamps: true },
);

blockedTermSchema.index({ active: 1 });

export const BlockedTerm = mongoose.model('BlockedTerm', blockedTermSchema);

const CACHE_KEY = 'blocked-terms:v1';
const VERSION_KEY = 'blocked-terms:version';
const keyOf = (text, type) => (type === 'link' ? `link:${normalizeLink(text)}` : `${type}:${normalize(text)}`);

// In-process compiled cache, refreshed when the version in Redis changes.
let local = { version: null, terms: [], compiled: [], checkedAt: 0 };

const publicTerm = (t) => ({ id: String(t._id), text: t.text, type: t.type, partial: t.partial, scope: t.scope });

async function loadActive() {
  const cached = await redis.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);
  const rows = await BlockedTerm.find({ active: true }).select('text type partial scope').sort({ _id: 1 }).lean();
  const value = { version: String(Date.now()), terms: rows.map(publicTerm) };
  await redis.set(CACHE_KEY, JSON.stringify(value), 'EX', 3600);
  await redis.set(VERSION_KEY, value.version, 'EX', 3600);
  return value;
}

/** Active terms for the app (cached): `{ version, terms }`. */
export async function activeTerms() {
  return loadActive();
}

async function compiled() {
  // Re-check the version at most every 5 s on the hot send path.
  if (local.version && Date.now() - local.checkedAt < 5_000) return local.compiled;
  const data = await loadActive();
  if (data.version !== local.version) {
    local = { version: data.version, terms: data.terms, compiled: data.terms.map((t) => ({ term: t, scope: t.scope, test: compile(t) })), checkedAt: Date.now() };
  } else {
    local.checkedAt = Date.now();
  }
  return local.compiled;
}

async function changed() {
  await redis.del(CACHE_KEY);
  local = { version: null, terms: [], compiled: [], checkedAt: 0 };
  const data = await loadActive();
  // Every open app refreshes its list (send button reacts immediately).
  getIO()?.emit('blocked-terms:updated', { version: data.version });
}

/**
 * Throws 422 CONTENT_BLOCKED (rule "keyword") when the text contains a blocked term.
 * scope: 'direct' (1-to-1) | 'groups'.
 */
export async function assertNoBlockedTerm(userId, text, scope, { groupId = null } = {}) {
  if (!text || !String(text).trim()) return;
  const hit = findBlocked(text, await compiled(), scope);
  if (!hit) return;
  BlockedTerm.updateOne({ _id: hit.id }, { $inc: { hits: 1 }, $set: { lastHitAt: new Date() } }).catch((err) => logger.warn({ err: err.message }, 'Blocked term hit count failed'));
  audit(userId, 'content_blocked', { group: groupId, meta: { rule: 'keyword', term: hit.text, scope, text: String(text).slice(0, 200) } });
  throw new ApiError(422, 'CONTENT_BLOCKED', 'Can not send. This message contains text that is not allowed.', { rule: 'keyword', term: hit.text });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
const adminDTO = (t) => ({ ...publicTerm(t), active: t.active, hits: t.hits, lastHitAt: t.lastHitAt, createdBy: t.createdBy, createdAt: t.createdAt });

export async function listTerms({ q, type, page = 1, limit = 50 } = {}) {
  const filter = {};
  if (type && type !== 'all') {
    if (type === 'inactive') filter.active = false;
    else filter.type = type;
  }
  if (q?.trim()) filter.text = new RegExp(escapeRegex(q.trim()), 'i');
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 50));
  const [rows, total, counts] = await Promise.all([
    BlockedTerm.find(filter).sort({ _id: -1 }).skip((p - 1) * l).limit(l).lean(),
    BlockedTerm.countDocuments(filter),
    BlockedTerm.aggregate([{ $group: { _id: { type: '$type', active: '$active' }, n: { $sum: 1 }, hits: { $sum: '$hits' } } }]),
  ]);
  const sum = (fn) => counts.filter(fn).reduce((s, c) => s + c.n, 0);
  return {
    items: rows.map(adminDTO),
    total,
    page: p,
    limit: l,
    stats: {
      active: sum((c) => c._id.active),
      words: sum((c) => c._id.active && c._id.type === 'word'),
      sentences: sum((c) => c._id.active && c._id.type === 'sentence'),
      links: sum((c) => c._id.active && c._id.type === 'link'),
      blockedMessages: counts.reduce((s, c) => s + c.hits, 0),
    },
  };
}

/** Adds one or many terms (one per line). Existing ones are skipped. */
export async function addTerms(texts, { partial = false, scope = 'all', createdBy = null } = {}) {
  const added = [];
  const skipped = [];
  for (const raw of texts) {
    const text = String(raw).trim();
    if (!text) continue;
    const type = typeOf(text);
    const key = keyOf(text, type);
    try {
      added.push(adminDTO((await BlockedTerm.create({ text, key, type, partial: type === 'link' ? false : partial, scope, createdBy })).toObject()));
    } catch (err) {
      if (err.code === 11000) skipped.push(text);
      else throw err;
    }
  }
  if (added.length) await changed();
  return { added, skipped };
}

export async function updateTerm(id, patch) {
  const t = await BlockedTerm.findByIdAndUpdate(id, { $set: patch }, { returnDocument: 'after', lean: true });
  if (!t) throw ApiError.notFound('Keyword not found');
  await changed();
  return adminDTO(t);
}

export async function deleteTerm(id) {
  const t = await BlockedTerm.findByIdAndDelete(id).lean();
  if (!t) throw ApiError.notFound('Keyword not found');
  await changed();
  return { deleted: true, text: t.text };
}

/** Admin "Test": which term (if any) blocks this text, for 1-to-1 and groups. */
export async function testText(text) {
  const c = await compiled();
  const direct = findBlocked(text, c, 'direct');
  const groups = findBlocked(text, c, 'groups');
  return { direct: direct?.text ?? null, groups: groups?.text ?? null, allowed: !direct && !groups };
}
