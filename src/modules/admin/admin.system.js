import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import mongoose from 'mongoose';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { redis } from '../../db/redis.js';
import { mailEnabled, sendNoticeEmail } from '../../services/mail.service.js';
import { enqueueBroadcast, queueCounts } from '../../services/queue.service.js';
import { emitToUsers, getIO } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { checkContent } from '../../utils/contentFilter.js';
import { Group, GroupMember, InviteLink } from '../groups/group.model.js';
import { LocationHistory } from '../location/location.model.js';
import { getSetting, updateSetting } from '../platform/platform.service.js';
import { User } from '../users/user.model.js';
import { accessQuery, DAY, internalId, like, paged, pageResult } from './admin.common.js';
import { hashPassword, logoutEverywhere } from './admin.auth.js';
import { AdminLog, Notification, PERMISSIONS, Staff, staffDTO } from './admin.models.js';

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
async function audienceIds(audience) {
  const base = { status: 'active' };
  let filter;
  if (audience === 'group_admins') {
    const ids = await GroupMember.distinct('user', { status: 'active', role: { $in: ['owner', 'admin'] } });
    filter = { ...base, _id: { $in: ids } };
  } else if (audience === 'trial') filter = { $and: [base, { $or: [accessQuery('trial'), accessQuery('unclaimed')] }] };
  else if (audience === 'premium') filter = { $and: [base, accessQuery('premium')] };
  else if (audience === 'expired') filter = { $and: [base, accessQuery('locked')] };
  else filter = base;
  return User.find(filter).select('_id email').limit(500_000).lean();
}

async function deliver(n) {
  await Notification.updateOne({ _id: n._id }, { $set: { status: 'sending' } });
  try {
    const users = await audienceIds(n.audience);
    const ids = users.map((u) => String(u._id));
    const payload = { id: String(n._id), title: n.title, body: n.body, at: new Date() };
    const skipped = [];
    let emailed = 0;
    if (n.channels.includes('in_app')) emitToUsers(ids, 'admin:notice', payload);
    if (n.channels.includes('push')) await enqueueBroadcast(ids, { notificationId: String(n._id), title: n.title, body: n.body });
    if (n.channels.includes('email')) {
      if (!mailEnabled()) skipped.push('email');
      else {
        for (const u of users.filter((x) => x.email)) {
          try {
            if (await sendNoticeEmail(u.email, n.title, n.body)) emailed += 1;
          } catch (err) {
            logger.warn({ err: err.message }, 'Notice email failed');
          }
        }
      }
    }
    if (n.channels.includes('sms')) skipped.push('sms'); // no SMS provider configured
    const reached = n.channels.some((c) => c === 'in_app' || c === 'push') ? ids.length : emailed;
    await Notification.updateOne({ _id: n._id }, { $set: { status: 'sent', sentAt: new Date(), recipients: ids.length, delivered: reached, emailed, skipped } });
  } catch (err) {
    logger.warn({ err: err.message }, 'Broadcast failed');
    await Notification.updateOne({ _id: n._id }, { $set: { status: 'failed' } });
  }
}

const notificationDTO = (n) => ({
  id: String(n._id),
  title: n.title,
  body: n.body,
  audience: n.audience,
  channels: n.channels,
  status: n.status,
  scheduledAt: n.scheduledAt,
  sentAt: n.sentAt,
  recipients: n.recipients,
  delivered: n.delivered,
  emailed: n.emailed,
  skipped: n.skipped,
  createdBy: n.createdBy,
  createdAt: n.createdAt,
});

export async function createNotification(input, staffName) {
  const scheduled = input.scheduledAt && new Date(input.scheduledAt) > new Date(Date.now() + 30_000);
  const n = await Notification.create({ ...input, status: scheduled ? 'scheduled' : 'sending', scheduledAt: scheduled ? input.scheduledAt : null, createdBy: staffName });
  if (!scheduled) await deliver(n.toObject());
  return notificationDTO(await Notification.findById(n._id).lean());
}

export async function listNotifications(query) {
  const p = paged(query);
  const [rows, total] = await Promise.all([Notification.find({}).sort({ _id: -1 }).skip(p.skip).limit(p.limit).lean(), Notification.countDocuments({})]);
  return pageResult(rows.map(notificationDTO), total, p);
}

export async function cancelNotification(id) {
  const n = await Notification.findOneAndUpdate({ _id: id, status: 'scheduled' }, { $set: { status: 'cancelled' } }, { returnDocument: 'after', lean: true });
  if (!n) throw ApiError.notFound('Scheduled notification not found');
  return notificationDTO(n);
}

/** Worker sweep: sends scheduled broadcasts that are due. */
export async function sendDueNotifications() {
  let sent = 0;
  for (;;) {
    const n = await Notification.findOneAndUpdate({ status: 'scheduled', scheduledAt: { $lte: new Date() } }, { $set: { status: 'sending' } }, { returnDocument: 'after', lean: true });
    if (!n) return sent;
    await deliver(n);
    sent += 1;
  }
}

/** Worker sweep: location history older than the admin retention setting. */
export async function pruneLocationHistory() {
  const { autoDeleteDays } = await getSetting('location');
  if (!autoDeleteDays) return 0;
  const r = await LocationHistory.deleteMany({ createdAt: { $lt: new Date(Date.now() - autoDeleteDays * DAY) } });
  return r.deletedCount;
}

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------
function auditFilter({ q, category, days }) {
  const and = [];
  if (category && category !== 'all') and.push({ category });
  if (days) and.push({ createdAt: { $gte: new Date(Date.now() - Number(days) * DAY) } });
  if (q?.trim()) and.push({ $or: [{ staffName: like(q) }, { action: like(q) }, { target: like(q) }, { ip: like(q) }] });
  return and.length ? { $and: and } : {};
}

const auditDTO = (l) => ({ id: String(l._id), at: l.createdAt, actor: l.staffName, action: l.action, category: l.category, target: l.target, targetId: l.targetId, ip: l.ip, meta: l.meta ?? null });

export async function listAudit(query) {
  const p = paged(query);
  const filter = auditFilter(query);
  const [rows, total] = await Promise.all([AdminLog.find(filter).sort({ _id: -1 }).skip(p.skip).limit(p.limit).lean(), AdminLog.countDocuments(filter)]);
  return pageResult(rows.map(auditDTO), total, p);
}

export async function auditForExport(query) {
  return (await AdminLog.find(auditFilter(query)).sort({ _id: -1 }).limit(50_000).lean()).map(auditDTO);
}

// ---------------------------------------------------------------------------
// Staff + roles
// ---------------------------------------------------------------------------
export async function listStaff() {
  return (await Staff.find({}).sort({ role: 1, name: 1 }).lean()).map(staffDTO);
}

export async function createStaff({ name, email, role, password }, createdBy) {
  if (await Staff.exists({ email: email.toLowerCase() })) throw ApiError.conflict('A staff account with this email already exists');
  const temp = password || randomBytes(6).toString('base64url');
  const s = await Staff.create({ name, email, role, passwordHash: await hashPassword(temp), createdBy });
  return { staff: staffDTO(s.toObject()), ...(password ? {} : { tempPassword: temp }) };
}

async function assertKeepsSuperAdmin(staffId, next) {
  const s = await Staff.findById(staffId).lean();
  if (!s) throw ApiError.notFound('Staff not found');
  const losing = s.role === 'super_admin' && (next.role && next.role !== 'super_admin' || next.status === 'suspended' || next.delete);
  if (losing && (await Staff.countDocuments({ role: 'super_admin', status: 'active', _id: { $ne: staffId } })) === 0) {
    throw ApiError.badRequest('Keep at least one active super admin');
  }
  return s;
}

export async function updateStaff(staffId, { name, role, status, twoFactor, resetPassword }, meId) {
  await assertKeepsSuperAdmin(staffId, { role, status });
  if (String(staffId) === String(meId) && status === 'suspended') throw ApiError.badRequest('You cannot suspend your own account');
  const set = {};
  for (const [k, v] of Object.entries({ name, role, status, twoFactor })) if (v !== undefined) set[k] = v;
  let tempPassword;
  if (resetPassword) {
    tempPassword = randomBytes(6).toString('base64url');
    set.passwordHash = await hashPassword(tempPassword);
  }
  const s = await Staff.findByIdAndUpdate(staffId, { $set: set, ...(status === 'suspended' || resetPassword ? { $inc: { tokenVersion: 1 } } : {}) }, { returnDocument: 'after', lean: true });
  return { staff: staffDTO(s), ...(tempPassword ? { tempPassword } : {}) };
}

export async function deleteStaff(staffId, meId) {
  if (String(staffId) === String(meId)) throw ApiError.badRequest('You cannot delete your own account');
  const s = await assertKeepsSuperAdmin(staffId, { delete: true });
  await Staff.deleteOne({ _id: staffId });
  await logoutEverywhere(staffId);
  return { deleted: true, name: s.name };
}

export async function getRoles() {
  const roles = await getSetting('roles');
  return { permissions: PERMISSIONS, roles: { ...roles, super_admin: [...PERMISSIONS] } };
}

export async function updateRoles(roles) {
  const clean = {};
  for (const role of ['moderator', 'support']) if (roles[role]) clean[role] = roles[role].filter((p) => PERMISSIONS.includes(p));
  await updateSetting('roles', clean);
  return getRoles();
}

// ---------------------------------------------------------------------------
// System settings + service health
// ---------------------------------------------------------------------------
export const getSystem = () => getSetting('system');
export const updateSystem = (patch) => updateSetting('system', patch);

async function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = async (d) => {
    let entries = [];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          total += (await fs.stat(p)).size;
          files += 1;
        } catch {
          // file removed meanwhile
        }
      }
    }
  };
  await walk(path.resolve(dir));
  return { bytes: total, files };
}

async function storageUsage() {
  const cached = await redis.get('admin:storage');
  if (cached) return JSON.parse(cached);
  const [pub, sec] = await Promise.all([dirSize(env.UPLOAD_DIR), dirSize(env.SECURE_UPLOAD_DIR)]);
  const value = { bytes: pub.bytes + sec.bytes, files: pub.files + sec.files, secureFiles: sec.files };
  await redis.set('admin:storage', JSON.stringify(value), 'EX', 600);
  return value;
}

const timed = async (fn) => {
  const t = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - t) / 1e6 };
};

export async function systemHealth() {
  const [mongo, redisPing, queue, storage, live] = await Promise.all([
    timed(() => mongoose.connection.db.admin().ping()).catch(() => null),
    timed(() => redis.ping()).catch(() => null),
    queueCounts().catch(() => null),
    storageUsage().catch(() => null),
    User.countDocuments({ status: 'active', 'locationSettings.mode': 'live' }),
  ]);
  const cs = await getSetting('content');
  const sample = 'Hello team, meeting at the office tomorrow. Please bring the report.';
  const t = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) checkContent(sample, { enabled: ['abuse', 'numbers', 'numberWords', 'spam', 'links', 'personalInfo', 'externalContact'], abuseWords: cs.abuseWords, hinglish: cs.hinglish, misspellings: cs.misspellings });
  const perMessage = Number(process.hrtime.bigint() - t) / 1e6 / 200;
  const io = getIO();
  const waiting = queue ? queue.waiting + queue.delayed : null;
  const mb = storage ? storage.bytes / 1024 / 1024 : null;
  return {
    uptimeSec: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    node: process.version,
    services: [
      { name: 'REST API + MongoDB', status: mongo ? 'Healthy' : 'Down', metric: mongo ? `${mongo.ms.toFixed(1)} ms database ping` : 'Database not reachable' },
      { name: 'Redis cache', status: redisPing ? 'Healthy' : 'Down', metric: redisPing ? `${redisPing.ms.toFixed(1)} ms ping` : 'Not reachable' },
      { name: 'WebSocket (real-time)', status: io ? 'Healthy' : 'Down', metric: io ? `${io.of('/').sockets.size} connections on this server` : 'Not started' },
      { name: 'Moderation engine', status: 'Healthy', metric: `${perMessage.toFixed(3)} ms / message` },
      { name: 'Location service', status: 'Healthy', metric: `${live} users sharing live` },
      { name: 'File storage', status: storage ? 'Healthy' : 'Unknown', metric: storage ? `${mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`} in ${storage.files} files` : 'Not available' },
      {
        name: 'Notification queue',
        status: waiting == null ? 'Unknown' : waiting > 1000 || (queue?.failed ?? 0) > 100 ? 'Degraded' : 'Healthy',
        metric: queue ? `${waiting} waiting, ${queue.failed} failed` : 'Not available',
      },
      { name: 'Email (SMTP)', status: mailEnabled() ? 'Healthy' : 'Not configured', metric: mailEnabled() ? env.SMTP_HOST : 'OTP codes shown in test mode' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Top bar search
// ---------------------------------------------------------------------------
export async function globalSearch(q) {
  const term = String(q ?? '').trim();
  if (term.length < 2) return { users: [], groups: [], invites: [] };
  const rx = like(term);
  const short = term.toUpperCase().replace(/^SC-/, '');
  const userOr = [{ name: rx }, { username: rx }, { email: rx }, { phone: like(term.replace(/\s+/g, '')) }];
  if (/^[A-F0-9]{6}$/.test(short)) userOr.push({ $expr: { $eq: [{ $toUpper: { $substrCP: [{ $toString: '$_id' }, 18, 6] } }, short] } });
  const [users, groups, invites] = await Promise.all([
    User.find({ status: { $ne: 'deleted' }, $or: userOr }).select('name phone email').limit(6).lean(),
    Group.find({ status: { $ne: 'deleted' }, name: rx }).select('name memberCount').limit(6).lean(),
    InviteLink.find({ code: like(term.toUpperCase()) }).select('code group').limit(6).lean(),
  ]);
  const igroups = await Group.find({ _id: { $in: invites.map((i) => i.group) } }).select('name').lean();
  return {
    users: users.map((u) => ({ id: String(u._id), name: u.name, internalId: internalId(u._id), phone: u.phone ?? null, email: u.email ?? null })),
    groups: groups.map((g) => ({ id: String(g._id), name: g.name, memberCount: g.memberCount })),
    invites: invites.map((i) => ({ code: i.code, groupId: String(i.group), groupName: igroups.find((g) => String(g._id) === String(i.group))?.name ?? 'Group' })),
  };
}
