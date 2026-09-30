import { ApiError } from '../../utils/ApiError.js';
import { AuditLog } from '../audit/audit.service.js';
import { Message } from '../chat/message.model.js';
import { Group, GroupMember } from '../groups/group.model.js';
import { GroupMessage } from '../groups/groupMessage.model.js';
import { Report } from '../reports/report.model.js';
import { ExtensionRequest } from '../subscription/extensionRequest.model.js';
import { blockUser, warnUser } from '../users/moderation.service.js';
import { User } from '../users/user.model.js';
import { countPerDay, DAY, idAt, internalId, like, paged, pageResult } from './admin.common.js';
import { accessCounts } from './admin.subscription.js';

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export async function dashboard() {
  const now = new Date();
  const week = new Date(now.getTime() - 7 * DAY);
  const [total, newThisWeek, active, groups, newGroups, blocked, locationOn, openReports, pendingRequests, blockedToday, flaggedChains, counts, chart, latestRequests, latestBlocked] =
    await Promise.all([
      User.countDocuments({ status: { $ne: 'deleted' } }),
      User.countDocuments({ status: { $ne: 'deleted' }, _id: { $gte: idAt(week) } }),
      User.countDocuments({ status: 'active', lastSeenAt: { $gte: week } }),
      Group.countDocuments({ status: 'active' }),
      Group.countDocuments({ status: 'active', _id: { $gte: idAt(week) } }),
      User.countDocuments({ status: { $in: ['blocked', 'suspended'] } }),
      User.countDocuments({ status: 'active', 'locationSettings.mode': { $in: ['live', 'join'] } }),
      Report.countDocuments({ status: { $in: ['open', 'reviewing'] } }),
      ExtensionRequest.countDocuments({ status: 'pending' }),
      AuditLog.countDocuments({ action: 'content_blocked', _id: { $gte: idAt(new Date(now.getTime() - DAY)) } }),
      Report.distinct('snapshot.forwardRootId', { status: { $in: ['open', 'reviewing'] }, 'snapshot.forwardRootId': { $ne: null } }),
      accessCounts(),
      countPerDay(AuditLog, { action: 'content_blocked' }, 7),
      ExtensionRequest.find({ status: 'pending' }).sort({ _id: -1 }).limit(3).populate('user', 'name createdAt subscription').lean(),
      AuditLog.find({ action: 'content_blocked' }).sort({ _id: -1 }).limit(3).lean(),
    ]);
  const [blockedUsers, blockedGroups] = await Promise.all([
    User.find({ _id: { $in: latestBlocked.map((b) => b.actor) } }).select('name').lean(),
    Group.find({ _id: { $in: latestBlocked.map((b) => b.group).filter(Boolean) } }).select('name').lean(),
  ]);
  const pct = (part, whole) => (whole > part && whole - part > 0 ? `+${Math.round((part / (whole - part)) * 1000) / 10}%` : null);
  return {
    date: now,
    stats: {
      totalUsers: total,
      totalUsersDelta: pct(newThisWeek, total),
      activeUsers: active,
      trialUsers: counts.trial,
      unclaimedUsers: counts.unclaimed,
      premiumUsers: counts.premium,
      activeGroups: groups,
      newGroupsThisWeek: newGroups,
      blockedUsers: blocked,
      locationEnabled: locationOn,
      openReports,
    },
    blockedChart: chart,
    pending: { extensionRequests: pendingRequests, moderationQueue: blockedToday, abuseReports: openReports, flaggedChains: flaggedChains.length },
    latestRequests: latestRequests.map((r) => ({ id: String(r._id), user: r.user?.name ?? 'Deleted user', kind: r.kind, days: r.days, createdAt: r.createdAt })),
    latestBlocked: latestBlocked.map((b) => ({
      id: String(b._id),
      user: blockedUsers.find((u) => String(u._id) === String(b.actor))?.name ?? 'Deleted user',
      group: blockedGroups.find((g) => String(g._id) === String(b.group))?.name ?? 'Direct chat',
      rule: b.meta?.rule ?? 'unknown',
      at: b.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Abuse reports
// ---------------------------------------------------------------------------
const REASON_TITLES = { spam: 'Spam', abuse: 'Abusive content', harassment: 'Harassment', fake: 'Fake account', scam: 'Scam / fraud', nudity: 'Inappropriate content', other: 'Other' };

async function reportDTOs(rows) {
  const userIds = rows.flatMap((r) => [r.reporter, r.targetUser]).filter(Boolean);
  const [users, groups] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('name warnings status').lean(),
    Group.find({ _id: { $in: rows.map((r) => r.group).filter(Boolean) } }).select('name').lean(),
  ]);
  const uname = (id) => users.find((u) => String(u._id) === String(id));
  const gname = (id) => groups.find((g) => String(g._id) === String(id))?.name;
  return rows.map((r) => {
    const target = r.targetUser ? uname(r.targetUser) : null;
    const reason = r.reasons?.[0];
    return {
      id: String(r._id),
      shortId: `RPT-${String(r._id).slice(-6).toUpperCase()}`,
      type: r.type,
      title: `${REASON_TITLES[reason] ?? (reason ? reason[0].toUpperCase() + reason.slice(1) : 'Report')} - ${r.type}`,
      reasons: r.reasons ?? [],
      details: r.details ?? '',
      status: r.status,
      resolution: r.resolution ?? '',
      reporter: { id: String(r.reporter), name: uname(r.reporter)?.name ?? 'Deleted user' },
      target: r.type === 'group' ? { id: r.group ? String(r.group) : null, name: gname(r.group) ?? r.snapshot?.groupName ?? 'Group', kind: 'group' } : { id: r.targetUser ? String(r.targetUser) : null, name: target?.name ?? 'Deleted user', internalId: r.targetUser ? internalId(r.targetUser) : null, warnings: target?.warnings ?? 0, status: target?.status ?? null, kind: 'user' },
      group: r.group ? { id: String(r.group), name: gname(r.group) ?? r.snapshot?.groupName ?? 'Group' } : null,
      message: r.message ? { id: String(r.message), text: r.snapshot?.text ?? null, type: r.snapshot?.type ?? null, visibility: r.snapshot?.visibility ?? null, rootId: r.snapshot?.forwardRootId ? String(r.snapshot.forwardRootId) : null } : null,
      alsoBlocked: r.alsoBlocked,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

export async function listReports(query) {
  const p = paged(query);
  const and = [];
  const type = (query.type ?? 'all').toLowerCase();
  if (['message', 'user', 'group'].includes(type)) and.push({ type });
  const status = (query.status ?? 'all').toLowerCase();
  if (status === 'pending') and.push({ status: { $in: ['open', 'reviewing'] } });
  else if (['open', 'reviewing', 'resolved', 'rejected'].includes(status)) and.push({ status });
  if (query.q?.trim()) {
    const users = await User.find({ name: like(query.q) }).select('_id').limit(200).lean();
    const ids = users.map((u) => u._id);
    and.push({ $or: [{ details: like(query.q) }, { 'snapshot.text': like(query.q) }, { 'snapshot.groupName': like(query.q) }, { reporter: { $in: ids } }, { targetUser: { $in: ids } }] });
  }
  const filter = and.length ? { $and: and } : {};
  const month = idAt(new Date(Date.now() - 30 * DAY));
  const [rows, total, open, reviewing, resolved30, rejected30] = await Promise.all([
    Report.find(filter).sort({ _id: -1 }).skip(p.skip).limit(p.limit).lean(),
    Report.countDocuments(filter),
    Report.countDocuments({ status: 'open' }),
    Report.countDocuments({ status: 'reviewing' }),
    Report.countDocuments({ status: 'resolved', _id: { $gte: month } }),
    Report.countDocuments({ status: 'rejected', _id: { $gte: month } }),
  ]);
  return { ...pageResult(await reportDTOs(rows), total, p), stats: { open, reviewing, resolved30, rejected30 } };
}

export async function reportDetail(id) {
  const r = await Report.findById(id).lean();
  if (!r) throw ApiError.notFound('Report not found');
  return (await reportDTOs([r]))[0];
}

/** resolve | reject | review | warn (warn target + resolve) | block (block target + resolve). */
export async function decideReport(id, { action, note = '' }, staffName) {
  const r = await Report.findById(id).lean();
  if (!r) throw ApiError.notFound('Report not found');
  let status = { resolve: 'resolved', reject: 'rejected', review: 'reviewing', warn: 'resolved', block: 'resolved' }[action];
  if (!status) throw ApiError.badRequest('Unknown action');
  let resolution = note.trim();
  if (action === 'warn' || action === 'block') {
    if (!r.targetUser) throw ApiError.badRequest('This report has no user to act on');
    if (action === 'warn') await warnUser(r.targetUser);
    else await blockUser(r.targetUser, { reason: `Report ${String(r._id).slice(-6).toUpperCase()}: ${r.reasons?.join(', ') || 'abuse'}`, by: staffName });
    resolution = [action === 'warn' ? 'User warned' : 'User blocked', resolution].filter(Boolean).join(' - ');
  }
  if (action === 'review') status = 'reviewing';
  await Report.updateOne({ _id: id }, { $set: { status, resolution } });
  return reportDetail(id);
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
export async function analytics(days = 14) {
  const from = new Date(Date.now() - (days - 1) * DAY);
  from.setUTCHours(0, 0, 0, 0);
  const since = { _id: { $gte: idAt(from) } };
  const [newUsers, groupMsgs, directMsgs, byRule, counts, topGroups, blockedByGroup, reportsByGroup, paid, everyone] = await Promise.all([
    countPerDay(User, {}, days),
    countPerDay(GroupMessage, { type: { $ne: 'system' } }, days),
    countPerDay(Message, {}, days),
    AuditLog.aggregate([{ $match: { action: 'content_blocked', ...since } }, { $group: { _id: '$meta.rule', n: { $sum: 1 } } }]),
    accessCounts(),
    GroupMessage.aggregate([{ $match: { type: { $ne: 'system' }, ...since } }, { $group: { _id: '$group', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 20 }]),
    AuditLog.aggregate([{ $match: { action: 'content_blocked', group: { $ne: null }, ...since } }, { $group: { _id: '$group', n: { $sum: 1 } } }]),
    Report.aggregate([{ $match: { group: { $ne: null }, ...since } }, { $group: { _id: '$group', n: { $sum: 1 } } }]),
    User.countDocuments({ status: { $ne: 'deleted' }, 'subscription.premiumUntil': { $ne: null } }),
    User.countDocuments({ status: { $ne: 'deleted' }, 'subscription.trialPending': { $ne: true } }),
  ]);
  const messages = groupMsgs.map((d, i) => ({ day: d.day, count: d.count + (directMsgs[i]?.count ?? 0) }));
  const groups = await Group.find({ _id: { $in: topGroups.map((g) => g._id) } }).select('name memberCount settings.location.requirement').lean();
  const totalMessages = messages.reduce((s, d) => s + d.count, 0);
  const totalBlocked = byRule.reduce((s, r) => s + r.n, 0);
  return {
    days,
    kpis: {
      newUsers: newUsers.reduce((s, d) => s + d.count, 0),
      messages: totalMessages,
      trialToPaid: everyone ? Math.round((paid / everyone) * 1000) / 10 : 0,
      blockedRate: totalMessages + totalBlocked ? Math.round((totalBlocked / (totalMessages + totalBlocked)) * 10_000) / 100 : 0,
    },
    newUsers,
    messages,
    blockedByRule: Object.fromEntries(byRule.map((r) => [r._id ?? 'unknown', r.n])),
    accessMix: counts,
    groups: topGroups.map((t) => {
      const g = groups.find((x) => String(x._id) === String(t._id));
      return {
        id: String(t._id),
        name: g?.name ?? 'Deleted group',
        members: g?.memberCount ?? 0,
        messages: t.n,
        blocked: blockedByGroup.find((b) => String(b._id) === String(t._id))?.n ?? 0,
        reports: reportsByGroup.find((b) => String(b._id) === String(t._id))?.n ?? 0,
        location: g?.settings?.location?.requirement ?? 'off',
      };
    }),
  };
}

export async function activeMembersCount() {
  return GroupMember.countDocuments({ status: 'active' });
}
