import { getPublicUser } from '../../services/cache.service.js';
import { onlineMap } from '../../services/presence.service.js';
import { emitToUser } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { toObjectId } from '../../utils/validators.js';
import { AuditLog } from '../audit/audit.service.js';
import { emitToGroup, invalidateGroup, invalidateMembership, leaveGroupRoom } from '../groups/group.access.js';
import { Group, GroupMember, InviteLink, inviteState } from '../groups/group.model.js';
import { activateMember, createGroup, deactivateMember, flattenSettings, inviteDTO } from '../groups/group.service.js';
import { GroupMessage } from '../groups/groupMessage.model.js';
import { pointerAt, postSystemMessage } from '../groups/groupMessage.service.js';
import { groupPremiumInfo } from '../subscription/subscription.service.js';
import { User } from '../users/user.model.js';
import { DAY, findUserRef, internalId, like, paged, pageResult, USER_FIELDS, userRow } from './admin.common.js';

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
function groupFilter({ q, filter } = {}) {
  const and = [{ status: { $ne: 'deleted' } }];
  if (q?.trim()) {
    const or = [{ name: like(q) }, { description: like(q) }];
    if (/^[a-f0-9]{24}$/i.test(q.trim())) or.push({ _id: q.trim() });
    and.push({ $or: or });
  }
  switch ((filter ?? 'all').toLowerCase()) {
    case 'location_mandatory':
      and.push({ 'settings.location.requirement': 'mandatory' });
      break;
    case 'location_optional':
      and.push({ 'settings.location.requirement': 'optional' });
      break;
    case 'private':
      and.push({ 'settings.messages.messageMode': 'private' });
      break;
    case 'suspended':
      and.push({ status: 'suspended' });
      break;
    case 'premium':
      and.push({ 'premium.approved': true });
      break;
    default:
  }
  return { $and: and };
}

async function groupRows(groups) {
  const creators = await User.find({ _id: { $in: groups.map((g) => g.createdBy) } }).select('name').lean();
  const cmap = new Map(creators.map((c) => [String(c._id), c.name]));
  return Promise.all(
    groups.map(async (g) => ({
      id: String(g._id),
      name: g.name,
      description: g.description,
      avatarUrl: g.avatarUrl ?? null,
      memberCount: g.memberCount,
      status: g.status,
      location: g.settings?.location?.requirement ?? 'off',
      locationVisibility: g.settings?.location?.visibility ?? 'adminOnly',
      messageMode: g.settings?.messages?.messageMode ?? 'user_select',
      createdBy: { id: String(g.createdBy), name: cmap.get(String(g.createdBy)) ?? 'Deleted user', internalId: internalId(g.createdBy) },
      premium: await groupPremiumInfo(g),
      premiumApproved: Boolean(g.premium?.approved),
      premiumUntil: g.premium?.approvedUntil ?? null,
      createdAt: g.createdAt,
      lastMessageAt: g.lastMessageAt,
    })),
  );
}

export async function listGroups(query) {
  const p = paged(query);
  let filter = groupFilter(query);
  // Invite code search ("ABC-XY12Z3").
  if (query.q && /^[A-Z]{3}-[A-Z0-9]{6,8}$/i.test(query.q.trim())) {
    const c = query.q.trim().toUpperCase();
    const link = await InviteLink.findOne({ $or: [{ code: c }, { legacyCode: c }] }).select('group').lean();
    if (link) filter = { _id: link.group };
  }
  const [rows, total] = await Promise.all([
    Group.find(filter).sort({ _id: -1 }).skip(p.skip).limit(p.limit).lean(),
    Group.countDocuments(filter),
  ]);
  return pageResult(await groupRows(rows), total, p);
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
async function loadGroup(groupId) {
  const g = await Group.findById(groupId).lean();
  if (!g || g.status === 'deleted') throw ApiError.notFound('Group not found');
  return g;
}

export async function groupDetail(groupId) {
  const g = await loadGroup(groupId);
  const gid = toObjectId(groupId);
  const since = new Date(Date.now() - 7 * DAY);
  const [[row], messages7d, blocked, sharing, links, creator] = await Promise.all([
    groupRows([g]),
    GroupMessage.countDocuments({ group: gid, type: { $ne: 'system' }, createdAt: { $gte: since } }),
    AuditLog.countDocuments({ group: gid, action: 'content_blocked' }),
    GroupMember.countDocuments({ group: gid, status: 'active', 'location.lat': { $ne: null }, 'location.mode': { $ne: 'none' } }),
    InviteLink.find({ group: gid }).sort({ createdAt: -1 }).limit(20).lean(),
    User.findById(g.createdBy).select('name phone email').lean(),
  ]);
  return {
    ...row,
    category: g.category,
    rules: g.rules,
    settings: g.settings,
    creator: creator ? { id: String(creator._id), name: creator.name, internalId: internalId(creator._id), phone: creator.phone ?? null, email: creator.email ?? null } : null,
    stats: { members: g.memberCount, messages7d, blockedMessages: blocked, sharingLocation: sharing },
    invites: links.map((l) => inviteDTO(l)),
  };
}

// ---------------------------------------------------------------------------
// Create / edit / suspend / delete
// ---------------------------------------------------------------------------
export async function createGroupAsAdmin({ creator, ...input }) {
  const u = await findUserRef(creator);
  const { group, invite } = await createGroup(String(u._id), input);
  return { group: await groupDetail(group.id), invite };
}

export async function updateGroup(groupId, { name, description, category, rules, avatarUrl, settings, creator }) {
  const g = await loadGroup(groupId);
  const set = {};
  for (const [k, v] of Object.entries({ name, description, category, rules, avatarUrl })) if (v !== undefined) set[k] = v;
  if (settings) Object.assign(set, flattenSettings(settings));
  if (creator) {
    const u = await findUserRef(creator);
    if (String(u._id) !== String(g.createdBy)) {
      const m = await GroupMember.findOne({ group: groupId, user: u._id, status: 'active' }).lean();
      if (!m) throw ApiError.badRequest('The new creator must be a member of the group');
      await GroupMember.updateOne({ group: groupId, user: g.createdBy }, { $set: { role: 'admin' } });
      await GroupMember.updateOne({ _id: m._id }, { $set: { role: 'owner' } });
      await Promise.all([invalidateMembership(groupId, g.createdBy), invalidateMembership(groupId, u._id)]);
      set.createdBy = u._id;
    }
  }
  if (!Object.keys(set).length) throw ApiError.badRequest('Nothing to update');
  await Group.updateOne({ _id: groupId }, { $set: set });
  await invalidateGroup(groupId);
  emitToGroup(String(groupId), 'group:updated', { groupId: String(groupId) });
  return groupDetail(groupId);
}

export async function setGroupStatus(groupId, suspended) {
  const g = await loadGroup(groupId);
  await Group.updateOne({ _id: groupId }, { $set: { status: suspended ? 'suspended' : 'active' } });
  await invalidateGroup(groupId);
  await postSystemMessage(groupId, g.createdBy, suspended ? 'suspended' : 'restored', suspended ? 'This group was suspended by the SecureChat team' : 'This group was restored by the SecureChat team');
  emitToGroup(String(groupId), 'group:updated', { groupId: String(groupId) });
  return { id: String(groupId), name: g.name, status: suspended ? 'suspended' : 'active' };
}

export async function deleteGroupAsAdmin(groupId) {
  const g = await loadGroup(groupId);
  await Group.updateOne({ _id: groupId }, { $set: { status: 'deleted' } });
  const members = await GroupMember.find({ group: groupId, status: 'active' }).select('user').lean();
  await GroupMember.updateMany({ group: groupId, status: { $in: ['active', 'pending'] } }, { $set: { status: 'removed' } });
  await InviteLink.updateMany({ group: groupId, status: 'active' }, { $set: { status: 'revoked', revokedAt: new Date() } });
  await invalidateGroup(groupId);
  await Promise.all(members.map((m) => invalidateMembership(groupId, m.user)));
  emitToGroup(String(groupId), 'group:removed', { groupId: String(groupId), reason: 'deleted' });
  for (const m of members) leaveGroupRoom(m.user, groupId);
  return { deleted: true, name: g.name };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
export async function listGroupMembers(groupId, { q, role } = {}) {
  await loadGroup(groupId);
  const filter = { group: toObjectId(groupId), status: 'active' };
  if (role && role !== 'all') filter.role = role;
  const rows = await GroupMember.find(filter).select('user role restricted restrictedUntil joinedAt location via').limit(5000).lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.user) } }).select(USER_FIELDS).lean();
  const online = await onlineMap(users.map((u) => u._id));
  const umap = new Map(users.map((u) => [String(u._id), userRow(u, online)]));
  const term = q?.trim().toLowerCase();
  const order = { owner: 0, admin: 1, member: 2 };
  return rows
    .map((r) => ({
      ...(umap.get(String(r.user)) ?? { id: String(r.user), name: 'Deleted user', displayName: 'Deleted', internalId: internalId(r.user) }),
      role: r.role,
      memberRestricted: r.restricted || Boolean(r.restrictedUntil && new Date(r.restrictedUntil) > new Date()),
      joinedAt: r.joinedAt,
      via: r.via,
      location: r.location?.lat != null ? { lat: r.location.lat, lng: r.location.lng, place: r.location.place ?? null, mode: r.location.mode, updatedAt: r.location.updatedAt } : null,
    }))
    .filter((m) => !term || [m.name, m.displayName, m.phone, m.email, m.internalId].some((v) => v?.toLowerCase().includes(term)))
    .sort((a, b) => order[a.role] - order[b.role] || String(a.name).localeCompare(String(b.name)));
}

export async function addGroupMember(groupId, userRef, role = 'member') {
  const g = await loadGroup(groupId);
  const u = await findUserRef(userRef);
  const existing = await GroupMember.findOne({ group: groupId, user: u._id }).lean();
  if (existing?.status === 'active') throw ApiError.conflict('This user is already a member');
  const now = new Date();
  await GroupMember.updateOne(
    { group: groupId, user: u._id },
    {
      $set: {
        role: role === 'admin' ? 'admin' : 'member',
        status: 'active',
        via: 'invite',
        inviteCode: null,
        restricted: false,
        joinedAt: now,
        clearedAt: now,
        lastMessageAt: now,
        lastReadMessageId: pointerAt(now),
        lastDeliveredMessageId: pointerAt(now),
        unreadCount: 0,
        restrictedUntil: null,
      },
    },
    { upsert: true },
  );
  await Group.updateOne({ _id: groupId }, { $inc: { memberCount: 1 } });
  await activateMember(groupId, String(u._id), null);
  const who = await getPublicUser(u._id);
  await postSystemMessage(groupId, u._id, 'added', `${who?.displayName ?? 'Member'} was added by the SecureChat team`);
  return { added: true, name: u.name, group: g.name };
}

export async function updateGroupMember(groupId, userId, { role, restricted }) {
  await loadGroup(groupId);
  const m = await GroupMember.findOne({ group: groupId, user: userId, status: 'active' }).lean();
  if (!m) throw ApiError.notFound('Member not found');
  if (role && m.role === 'owner') throw ApiError.badRequest('Change the group creator from Edit group instead');
  const set = {};
  if (role) set.role = role;
  if (restricted !== undefined) Object.assign(set, { restricted, ...(restricted ? {} : { restrictedUntil: null }) });
  await GroupMember.updateOne({ _id: m._id }, { $set: set });
  await invalidateMembership(groupId, userId);
  emitToGroup(String(groupId), 'group:member:updated', { groupId: String(groupId), userId: String(userId), ...set });
  const u = await User.findById(userId).select('name').lean();
  return { name: u?.name ?? 'Member', ...set };
}

export async function removeGroupMember(groupId, userId) {
  await loadGroup(groupId);
  const m = await GroupMember.findOne({ group: groupId, user: userId, status: 'active' }).lean();
  if (!m) throw ApiError.notFound('Member not found');
  if (m.role === 'owner') throw ApiError.badRequest('Make another member the creator before removing this one');
  await deactivateMember(groupId, userId, 'removed');
  emitToUser(String(userId), 'group:removed', { groupId: String(groupId), reason: 'removed' });
  const who = await getPublicUser(userId);
  await postSystemMessage(groupId, userId, 'removed', `${who?.displayName ?? 'Member'} was removed by the SecureChat team`);
  emitToGroup(String(groupId), 'group:member:left', { groupId: String(groupId), userId: String(userId), reason: 'removed' });
  const u = await User.findById(userId).select('name').lean();
  return { removed: true, name: u?.name ?? 'Member' };
}

// ---------------------------------------------------------------------------
// Group location
// ---------------------------------------------------------------------------
const STALE_MS = 30 * 60_000;

export async function groupLocations(groupId) {
  const g = await loadGroup(groupId);
  const members = await listGroupMembers(groupId);
  const now = Date.now();
  const rows = members.map((m) => {
    const at = m.location?.updatedAt ? new Date(m.location.updatedAt).getTime() : 0;
    const status = !m.location ? 'Off' : m.location.mode === 'live' && now - at <= STALE_MS ? 'Live' : m.location.mode === 'live' ? 'Stale' : 'Join';
    return { userId: m.id, name: m.name, displayName: m.displayName, role: m.role, location: m.location, status };
  });
  return {
    group: { id: String(g._id), name: g.name, requirement: g.settings?.location?.requirement ?? 'off', shareMode: g.settings?.location?.shareMode ?? 'join', visibility: g.settings?.location?.visibility ?? 'adminOnly' },
    stats: {
      live: rows.filter((r) => r.status === 'Live').length,
      stale: rows.filter((r) => r.status === 'Stale').length,
      joinOnly: rows.filter((r) => r.status === 'Join').length,
      notSharing: rows.filter((r) => r.status === 'Off').length,
    },
    members: rows,
  };
}

// ---------------------------------------------------------------------------
// Invite links (all groups)
// ---------------------------------------------------------------------------
export async function listInvites(query) {
  const p = paged(query);
  const now = new Date();
  const and = [];
  const f = (query.filter ?? 'all').toLowerCase();
  if (f === 'active') and.push({ status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] });
  if (f === 'expired') and.push({ status: 'active', expiresAt: { $lte: now } });
  if (f === 'revoked') and.push({ status: 'revoked' });
  if (f === 'approval') and.push({ requireApproval: true });
  if (query.q?.trim()) {
    const groups = await Group.find({ name: like(query.q) }).select('_id').limit(200).lean();
    and.push({ $or: [{ code: like(query.q) }, { group: { $in: groups.map((g) => g._id) } }] });
  }
  const filter = and.length ? { $and: and } : {};
  const since = new Date(now.getTime() - 7 * DAY);
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const [rows, total, active, expired7d, revoked7d, joinsToday] = await Promise.all([
    InviteLink.find(filter).sort({ _id: -1 }).skip(p.skip).limit(p.limit).lean(),
    InviteLink.countDocuments(filter),
    InviteLink.countDocuments({ status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }),
    InviteLink.countDocuments({ status: 'active', expiresAt: { $gte: since, $lte: now } }),
    InviteLink.countDocuments({ status: 'revoked', revokedAt: { $gte: since } }),
    GroupMember.countDocuments({ via: 'invite', joinedAt: { $gte: today }, status: 'active' }),
  ]);
  const [groups, creators] = await Promise.all([
    Group.find({ _id: { $in: rows.map((r) => r.group) } }).select('name status').lean(),
    User.find({ _id: { $in: rows.map((r) => r.createdBy) } }).select('name').lean(),
  ]);
  const gmap = new Map(groups.map((g) => [String(g._id), g]));
  const cmap = new Map(creators.map((c) => [String(c._id), c.name]));
  const items = rows.map((l) => ({
    ...inviteDTO(l, cmap.get(String(l.createdBy)) ?? 'Deleted user'),
    state: inviteState(l),
    groupId: String(l.group),
    groupName: gmap.get(String(l.group))?.name ?? 'Deleted group',
  }));
  return { ...pageResult(items, total, p), stats: { active, joinsToday, expired7d, revoked7d } };
}

export async function revokeInviteAsAdmin(code) {
  const link = await InviteLink.findOneAndUpdate({ $or: [{ code: code.toUpperCase() }, { legacyCode: code.toUpperCase() }], status: 'active' }, { $set: { status: 'revoked', revokedAt: new Date() } }, { returnDocument: 'after', lean: true });
  if (!link) throw ApiError.notFound('Active invite link not found');
  return { revoked: true, code: link.code, groupId: String(link.group) };
}
