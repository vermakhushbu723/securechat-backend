import { invalidateUser } from '../../services/cache.service.js';
import { onlineMap } from '../../services/presence.service.js';
import { emitToUser } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { toObjectId } from '../../utils/validators.js';
import { AuditLog } from '../audit/audit.service.js';
import { Message } from '../chat/message.model.js';
import { SecureFile } from '../files/secureFile.model.js';
import { Group, GroupMember } from '../groups/group.model.js';
import { GroupMessage } from '../groups/groupMessage.model.js';
import { LocationHistory } from '../location/location.model.js';
import { Report } from '../reports/report.model.js';
import { searchTokensOf, toSelfUser, User } from '../users/user.model.js';
import { DAY, paged, pageResult, USER_FIELDS, userFilter, userRow, userRows } from './admin.common.js';

// ---------------------------------------------------------------------------
// List / detail / edit
// ---------------------------------------------------------------------------
export async function listUsers(query) {
  const p = paged(query);
  const filter = userFilter(query);
  const [rows, total] = await Promise.all([
    User.find(filter).select(USER_FIELDS).sort({ _id: -1 }).skip(p.skip).limit(p.limit).lean(),
    User.countDocuments(filter),
  ]);
  return pageResult(await userRows(rows), total, p);
}

export async function allUsersForExport(query) {
  const rows = await User.find(userFilter(query)).select(USER_FIELDS).sort({ _id: -1 }).limit(50_000).lean();
  return rows.map((u) => userRow(u));
}

export async function userDetail(userId) {
  const u = await User.findById(userId).select(USER_FIELDS).lean();
  if (!u) throw ApiError.notFound('User not found');
  const uid = toObjectId(userId);
  const [online, memberships, groupMessages, directMessages, reportsAgainst, reportsBy] = await Promise.all([
    onlineMap([userId]),
    GroupMember.find({ user: uid, status: 'active' }).select('group role joinedAt location').sort({ joinedAt: -1 }).limit(50).lean(),
    GroupMessage.countDocuments({ sender: uid, type: { $ne: 'system' } }),
    Message.countDocuments({ sender: uid }),
    Report.countDocuments({ targetUser: uid }),
    Report.countDocuments({ reporter: uid }),
  ]);
  const groups = await Group.find({ _id: { $in: memberships.map((m) => m.group) }, status: { $ne: 'deleted' } })
    .select('name memberCount status settings.location.requirement avatarUrl')
    .lean();
  const gmap = new Map(groups.map((g) => [String(g._id), g]));
  return {
    ...userRow(u, online),
    about: u.about ?? '',
    stats: { groups: groups.length, messages: groupMessages + directMessages, warnings: u.warnings ?? 0, reportsAgainst, reportsBy },
    subscription: {
      premiumUntil: u.subscription?.premiumUntil ?? null,
      extendedUntil: u.subscription?.extendedUntil ?? null,
      freeAccess: Boolean(u.subscription?.freeAccess),
      extensionCount: u.subscription?.extensionCount ?? 0,
    },
    groups: memberships
      .filter((m) => gmap.has(String(m.group)))
      .map((m) => {
        const g = gmap.get(String(m.group));
        return {
          id: String(g._id),
          name: g.name,
          avatarUrl: g.avatarUrl ?? null,
          memberCount: g.memberCount,
          status: g.status,
          location: g.settings?.location?.requirement ?? 'off',
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }),
  };
}

export async function updateUser(userId, { name, displayName, about }) {
  const u = await User.findById(userId);
  if (!u) throw ApiError.notFound('User not found');
  if (name !== undefined) u.name = name;
  if (displayName !== undefined) u.displayName = displayName || null;
  if (about !== undefined) u.about = about;
  u.searchTokens = searchTokensOf(u.name, u.username);
  await u.save();
  await invalidateUser(userId);
  emitToUser(String(userId), 'user:updated', toSelfUser(u.toObject()));
  return userDetail(userId);
}

// ---------------------------------------------------------------------------
// Blocked users
// ---------------------------------------------------------------------------
export async function listBlocked(query) {
  const p = paged(query);
  const f = (query.filter ?? 'all').toLowerCase();
  const status = f === 'blocked' ? ['blocked'] : f === 'suspended' ? ['suspended'] : ['blocked', 'suspended'];
  const filter = { ...userFilter({ q: query.q }), status: { $in: status } };
  const [rows, total] = await Promise.all([
    User.find(filter).select(USER_FIELDS).sort({ 'moderation.at': -1 }).skip(p.skip).limit(p.limit).lean(),
    User.countDocuments(filter),
  ]);
  return pageResult(await userRows(rows), total, p);
}

// ---------------------------------------------------------------------------
// Activity timeline
// ---------------------------------------------------------------------------
const ACTIVITY = {
  login: ['auth', 'login', 'Logged in'],
  content_blocked: ['security', 'gpp_maybe', 'Message blocked by content filter'],
  report_created: ['security', 'flag', 'Reported content'],
  group_created: ['messages', 'group_add', 'Created a group'],
  message_deleted_for_everyone: ['messages', 'delete', 'Deleted a message for everyone'],
  member_removed: ['messages', 'person_remove', 'Removed a member'],
  member_updated: ['messages', 'admin', 'Changed a member role'],
  group_settings_updated: ['messages', 'settings', 'Changed group settings'],
  invite_created: ['messages', 'link', 'Created an invite link'],
  join_approved: ['messages', 'how_to_reg', 'Approved a join request'],
};

export async function userActivity(userId, { days = 7, type = 'all' } = {}) {
  const uid = toObjectId(userId);
  const since = new Date(Date.now() - days * DAY);
  const [audits, joins, files, locations, forwards, groupMsgs, dms] = await Promise.all([
    AuditLog.find({ actor: uid, createdAt: { $gte: since } }).sort({ _id: -1 }).limit(300).lean(),
    GroupMember.find({ user: uid, joinedAt: { $gte: since }, status: { $in: ['active', 'left', 'removed'] } }).select('group joinedAt via').limit(100).lean(),
    SecureFile.find({ owner: uid, createdAt: { $gte: since } }).select('name kind createdAt').sort({ _id: -1 }).limit(100).lean(),
    LocationHistory.find({ user: uid, createdAt: { $gte: since } }).select('place source group createdAt lat lng').sort({ _id: -1 }).limit(100).lean(),
    GroupMessage.find({ sender: uid, 'forward.rootId': { $exists: true }, createdAt: { $gte: since } }).select('group createdAt').sort({ _id: -1 }).limit(100).lean(),
    GroupMessage.countDocuments({ sender: uid, type: { $ne: 'system' }, createdAt: { $gte: since } }),
    Message.countDocuments({ sender: uid, createdAt: { $gte: since } }),
  ]);
  const groupIds = [...new Set([...joins.map((j) => j.group), ...locations.map((l) => l.group), ...forwards.map((f) => f.group), ...audits.map((a) => a.group)].filter(Boolean).map(String))];
  const groups = await Group.find({ _id: { $in: groupIds } }).select('name').lean();
  const gname = (id) => (id ? groups.find((g) => String(g._id) === String(id))?.name ?? 'Group' : null);

  const events = [];
  for (const a of audits) {
    const [cat, icon, title] = ACTIVITY[a.action] ?? ['messages', 'history', a.action.replace(/_/g, ' ')];
    let detail = gname(a.group) ?? '';
    if (a.action === 'login') detail = [a.meta?.ua?.includes('Dart') ? 'Android app' : a.meta?.ua ? 'Web browser' : null, a.meta?.ip].filter(Boolean).join('  |  ');
    if (a.action === 'content_blocked') detail = `Rule: ${a.meta?.rule ?? '-'}${gname(a.group) ? `  |  ${gname(a.group)}` : ''}`;
    events.push({ type: cat, icon, title, detail, at: a.createdAt });
  }
  for (const j of joins) events.push({ type: 'messages', icon: 'group_add', title: 'Joined a group', detail: `${gname(j.group)}${j.via === 'invite' ? ' (invite link)' : ''}`, at: j.joinedAt });
  for (const f of files) events.push({ type: 'files', icon: 'upload_file', title: 'Uploaded protected file', detail: f.name, at: f.createdAt });
  for (const l of locations) {
    events.push({ type: 'security', icon: 'share_location', title: l.source === 'live' ? 'Shared live location' : l.source === 'join' ? 'Shared location to join' : 'Shared location', detail: l.place ?? gname(l.group) ?? `${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}`, at: l.createdAt });
  }
  for (const f of forwards) events.push({ type: 'messages', icon: 'shortcut', title: 'Forwarded a message', detail: `To ${gname(f.group)}`, at: f.createdAt });
  events.sort((a, b) => new Date(b.at) - new Date(a.at));

  return {
    days,
    stats: {
      logins: audits.filter((a) => a.action === 'login').length,
      messages: groupMsgs + dms,
      forwards: forwards.length,
      violations: audits.filter((a) => a.action === 'content_blocked').length,
    },
    events: (type === 'all' ? events : events.filter((e) => e.type === type)).slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------
export async function userLocation(userId) {
  const u = await User.findById(userId).select('name locationSettings').lean();
  if (!u) throw ApiError.notFound('User not found');
  const uid = toObjectId(userId);
  const [history, memberships] = await Promise.all([
    LocationHistory.find({ user: uid }).sort({ _id: -1 }).limit(100).lean(),
    GroupMember.find({ user: uid, status: 'active' }).select('group location').lean(),
  ]);
  const groups = await Group.find({ _id: { $in: memberships.map((m) => m.group) }, status: { $ne: 'deleted' } }).select('name settings.location').lean();
  const required = groups.filter((g) => g.settings?.location?.requirement === 'mandatory').length;
  const gname = (id) => groups.find((g) => String(g._id) === String(id))?.name ?? null;
  const latest = history[0] ?? null;
  const s = u.locationSettings ?? {};
  const live = s.mode === 'live' && (!s.liveUntil || new Date(s.liveUntil) > new Date());
  return {
    name: u.name,
    current: latest && { lat: latest.lat, lng: latest.lng, place: latest.place, accuracy: latest.accuracy, source: latest.source, at: latest.createdAt, group: gname(latest.group) },
    sharing: {
      mode: s.mode ?? 'join',
      live,
      intervalMin: s.intervalMin ?? 10,
      liveUntil: s.liveUntil ?? null,
      groupsRequiring: required,
      groupsWithLocation: groups.filter((g) => (g.settings?.location?.requirement ?? 'off') !== 'off').length,
    },
    history: history.map((h) => ({ lat: h.lat, lng: h.lng, place: h.place, accuracy: h.accuracy, source: h.source, group: gname(h.group), at: h.createdAt })),
  };
}
