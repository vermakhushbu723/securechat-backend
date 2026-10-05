import mongoose from 'mongoose';

import { onlineMap } from '../../services/presence.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/validators.js';
import { normalizeIdentifier } from '../auth/identifier.js';
import { accessOf, TRIAL_DAYS } from '../subscription/access.js';
import { accountState, displayNameOf, isRestricted, User } from '../users/user.model.js';

export const DAY = 86_400_000;

/** Page / limit from the query (1 based page, max 100 rows). */
export function paged(q = {}) {
  const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit ?? '25', 10) || 25));
  return { page, limit, skip: (page - 1) * limit };
}

export const pageResult = (items, total, { page, limit }) => ({ items, total, page, limit });

/** Short user ID shown to admins ("SC-4F2A9C"), derived from the Mongo id. */
export const internalId = (id) => `SC-${String(id).slice(-6).toUpperCase()}`;

/** Case insensitive "contains" regex for admin search boxes. */
export const like = (q) => new RegExp(escapeRegex(String(q).trim()), 'i');

/** Admin view of a user: full identity (members never see this). */
export function userRow(u, online = new Map()) {
  const a = accessOf(u);
  return {
    id: String(u._id),
    internalId: internalId(u._id),
    name: u.name,
    displayName: displayNameOf(u),
    username: u.username ?? null,
    phone: u.phone ?? null,
    email: u.email ?? null,
    avatarUrl: u.avatarUrl ?? null,
    accountType: u.accountType ?? 'personal',
    status: accountState(u),
    access: a.access,
    accessUntil: a.until,
    trialEndsAt: a.trialEndsAt,
    // Claimed / admin set trials store only the end; the start is shown as end - trial length.
    trialStartedAt: !a.trialEndsAt ? null : u.subscription?.trialEndsAt ? new Date(new Date(a.trialEndsAt).getTime() - TRIAL_DAYS * DAY) : u.createdAt,
    grantedBy: u.subscription?.grantedBy ?? (a.access === 'premium' ? 'Payment' : null),
    warnings: u.warnings ?? 0,
    locationEnabled: (u.locationSettings?.mode ?? 'join') !== 'none',
    locationMode: u.locationSettings?.mode ?? 'join',
    restricted: isRestricted(u),
    searchAllowed: !u.searchBlocked,
    searchHidden: Boolean(u.searchHidden),
    moderation: u.moderation
      ? { reason: u.moderation.reason ?? null, at: u.moderation.at ?? null, by: u.moderation.by ?? null, suspendedUntil: u.moderation.suspendedUntil ?? null, restrictedUntil: u.moderation.restrictedUntil ?? null }
      : null,
    online: online.get(String(u._id)) ?? false,
    lastSeenAt: u.lastSeenAt ?? null,
    createdAt: u.createdAt,
  };
}

export async function userRows(users) {
  const online = await onlineMap(users.map((u) => u._id));
  return users.map((u) => userRow(u, online));
}

export const USER_FIELDS = 'name displayName username phone email avatarUrl accountType status subscription warnings locationSettings moderation searchBlocked searchHidden lastSeenAt createdAt';

/**
 * Mongo filter for an access type (same rules as accessOf):
 * premium > extended > free > unclaimed > trial > locked.
 */
export function accessQuery(access, now = new Date()) {
  const premium = { 'subscription.premiumUntil': { $gt: now } };
  const extended = { 'subscription.extendedUntil': { $gt: now } };
  const free = { 'subscription.freeAccess': true };
  const unclaimed = { 'subscription.trialPending': true };
  const trialActive = {
    $or: [{ 'subscription.trialEndsAt': { $gt: now } }, { 'subscription.trialEndsAt': null, createdAt: { $gt: new Date(now.getTime() - TRIAL_DAYS * DAY) } }],
  };
  switch (access) {
    case 'premium':
      return premium;
    case 'extended':
      return { $and: [extended, { $nor: [premium] }] };
    case 'free':
      return { $and: [free, { $nor: [premium, extended] }] };
    case 'unclaimed':
      return { $and: [unclaimed, { $nor: [premium, extended, free] }] };
    case 'trial':
      return { $and: [trialActive, { $nor: [premium, extended, free, unclaimed] }] };
    case 'locked':
      return { $nor: [premium, extended, free, unclaimed, trialActive] };
    default:
      return {};
  }
}

/** Users list filter: "all" | access type | "blocked" | "suspended" | "restricted". */
export function userFilter({ q, filter } = {}) {
  const and = [{ status: { $ne: 'deleted' } }];
  if (q?.trim()) {
    const term = q.trim();
    const or = [{ name: like(term) }, { username: like(term) }, { email: like(term) }, { phone: like(term.replace(/\s+/g, '')) }];
    if (/^[a-f0-9]{24}$/i.test(term)) or.push({ _id: term });
    const short = term.toUpperCase().replace(/^SC-/, '');
    if (/^[A-F0-9]{6}$/.test(short)) or.push({ $expr: { $eq: [{ $toUpper: { $substrCP: [{ $toString: '$_id' }, 18, 6] } }, short] } });
    and.push({ $or: or });
  }
  const f = (filter ?? 'all').toLowerCase();
  if (f === 'blocked') and.push({ status: { $in: ['blocked', 'suspended'] } });
  else if (f === 'suspended') and.push({ status: 'suspended' });
  else if (f === 'search_off') and.push({ searchBlocked: true });
  else if (f === 'search_hidden') and.push({ searchHidden: true });
  else if (f === 'restricted') and.push({ $or: [{ 'moderation.restricted': true }, { 'moderation.restrictedUntil': { $gt: new Date() } }] });
  else if (f !== 'all') and.push(accessQuery(f));
  return { $and: and };
}

/** User by id, "SC-XXXXXX", mobile number, email or username. */
export async function findUserRef(ref) {
  const id = String(ref ?? '').trim();
  if (!id) throw ApiError.badRequest('User is required');
  if (/^[a-f0-9]{24}$/i.test(id)) {
    const u = await User.findById(id).select('_id name').lean();
    if (u) return u;
  }
  const short = id.toUpperCase().replace(/^SC-/, '');
  if (/^SC-/i.test(id) && /^[A-F0-9]{6}$/.test(short)) {
    const u = await User.findOne({ $expr: { $eq: [{ $toUpper: { $substrCP: [{ $toString: '$_id' }, 18, 6] } }, short] } }).select('_id name').lean();
    if (u) return u;
  }
  const norm = normalizeIdentifier(id);
  const u = await User.findOne(norm ? { [norm.kind]: norm.value } : { username: id.toLowerCase() }).select('_id name').lean();
  if (!u) throw ApiError.notFound('User not found');
  return u;
}

/** RFC 4180 CSV. */
export function toCsv(columns, rows) {
  const cell = (v) => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
}

export function sendCsv(res, filename, columns, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${toCsv(columns, rows)}`);
}

/** Day buckets ("2026-09-24") for the last `days` days, oldest first. */
export function dayKeys(days, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(now.getTime() - i * DAY).toISOString().slice(0, 10));
  return out;
}

/** First ObjectId created at `date` (ObjectIds embed their creation time: indexed time range). */
export const idAt = (date) => mongoose.Types.ObjectId.createFromTime(Math.floor(new Date(date).getTime() / 1000));

/** Counts per day (UTC) for the last `days` days, using the _id time range. */
export async function countPerDay(model, match, days) {
  const from = new Date(Date.now() - (days - 1) * DAY);
  from.setUTCHours(0, 0, 0, 0);
  const rows = await model.aggregate([
    { $match: { ...match, _id: { $gte: idAt(from) } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
  ]);
  const map = new Map(rows.map((r) => [r._id, r.n]));
  return dayKeys(days).map((d) => ({ day: d, count: map.get(d) ?? 0 }));
}
