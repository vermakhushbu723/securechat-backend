import { randomInt } from 'node:crypto';

import { env } from '../../config/env.js';
import { getPublicUser, getPublicUsers, hasBlocked } from '../../services/cache.service.js';
import { onlineMap } from '../../services/presence.service.js';
import { emitToUser, emitToUsers } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { toObjectId } from '../../utils/validators.js';
import { audit } from '../audit/audit.service.js';
import { SecureFile } from '../files/secureFile.model.js';
import { LocationHistory } from '../location/location.model.js';
import {
  adminIds,
  canEditInfo,
  emitToGroup,
  getGroup,
  invalidateGroup,
  invalidateMembership,
  isAdmin,
  joinGroupRoom,
  leaveGroupRoom,
  requireGroupAccess,
  sendBlockReason,
} from './group.access.js';
import { Group, GroupMember, InviteLink, inviteState } from './group.model.js';
import { expiryDate } from './group.schema.js';
import { GroupMessage } from './groupMessage.model.js';
import { pointerAt, postSystemMessage, recomputePointers } from './groupMessage.service.js';

const ROLE_ORDER = { owner: 0, admin: 1, member: 2 };
const FOREVER = new Date('9999-12-31T00:00:00Z');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ===========================================================================
// DTOs
// ===========================================================================
const inviteUrl = (code) => `${env.APP_URL.replace(/\/$/, '')}/group/${code}`;

function inviteDTO(link, creatorName) {
  return {
    code: link.code,
    url: inviteUrl(link.code),
    expiresAt: link.expiresAt,
    maxJoins: link.maxJoins,
    joins: link.joins,
    requireApproval: link.requireApproval,
    state: inviteState(link),
    createdAt: link.createdAt,
    createdBy: creatorName ?? null,
  };
}

function summaryDTO(g, member, userId) {
  const muted = Boolean(member.mutedUntil && member.mutedUntil > new Date());
  const last = g.lastMessage?.id && !(member.clearedAt && g.lastMessage.createdAt < member.clearedAt) ? g.lastMessage : null;
  return {
    id: String(g._id),
    name: g.name,
    description: g.description,
    category: g.category,
    avatarUrl: g.avatarUrl,
    memberCount: g.memberCount,
    status: g.status,
    role: member.role,
    createdByMe: String(g.createdBy) === String(userId),
    lastMessage: last && {
      id: String(last.id),
      senderId: last.sender ? String(last.sender) : null,
      senderName: last.senderName,
      type: last.type,
      text: last.text,
      visibility: last.visibility,
      deleted: last.deleted,
      createdAt: last.createdAt,
    },
    lastMessageAt: member.lastMessageAt ?? g.lastMessageAt ?? g.createdAt,
    unreadCount: member.unreadCount,
    muted,
    pinned: member.pinned,
    archived: member.archived,
    location: g.settings?.location?.requirement ?? 'off',
    locationVisibility: g.settings?.location?.visibility ?? 'adminOnly',
    messageMode: g.settings?.messages?.messageMode ?? 'user_select',
  };
}

async function detailDTO(groupId, userId) {
  const [g, member] = await Promise.all([
    Group.findById(groupId).lean(),
    GroupMember.findOne({ group: groupId, user: userId }).lean(),
  ]);
  if (!g || g.status === 'deleted') throw ApiError.notFound('Group not found');
  if (!member || member.status !== 'active') throw ApiError.forbidden('You are not a member of this group', 'NOT_MEMBER');
  const creator = await getPublicUser(g.createdBy);
  const block = sendBlockReason({ ...g, settings: g.settings }, member, 'text');
  const mediaBlock = sendBlockReason({ ...g, settings: g.settings }, member, 'image');
  return {
    ...summaryDTO(g, member, userId),
    rules: g.rules,
    createdBy: { id: String(g.createdBy), displayName: creator?.displayName ?? 'Member' },
    createdAt: g.createdAt,
    settings: g.settings,
    me: {
      userId: String(userId),
      role: member.role,
      isAdmin: isAdmin(member),
      restricted: member.restricted,
      restrictedUntil: member.restrictedUntil,
      joinedAt: member.joinedAt,
      canSend: !block,
      sendBlockedReason: block ? { code: block[0], message: block[1] } : null,
      canSendMedia: !mediaBlock,
      canEditInfo: canEditInfo(g, member),
      location: member.location ?? null,
    },
  };
}

// ===========================================================================
// Create / list / detail / update
// ===========================================================================
function newCode(name) {
  const prefix = (name.toUpperCase().replace(/[^A-Z]/g, '') + 'GRP').slice(0, 3);
  let rand = '';
  for (let i = 0; i < 6; i++) rand += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${prefix}-${rand}`;
}

async function createInvite(groupId, name, userId, { expiry = '24h', maxJoins = 100, requireApproval = false } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await InviteLink.create({
        group: groupId,
        code: newCode(name),
        createdBy: userId,
        expiresAt: expiry === 'never' ? null : expiryDate(expiry),
        maxJoins,
        requireApproval,
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  throw new ApiError(500, 'INTERNAL', 'Could not generate a unique invite code');
}

function flattenSettings(settings, prefix = 'settings') {
  const set = {};
  for (const [section, value] of Object.entries(settings ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value) || typeof value !== 'object') set[`${prefix}.${section}`] = value;
    else for (const [k, v] of Object.entries(value)) if (v !== undefined) set[`${prefix}.${section}.${k}`] = v;
  }
  return set;
}

export async function createGroup(userId, input) {
  const group = await Group.create({
    name: input.name,
    description: input.description,
    category: input.category,
    rules: input.rules,
    avatarUrl: input.avatarUrl ?? null,
    createdBy: userId,
    memberCount: 1,
    lastMessageAt: new Date(),
  });
  if (input.settings) await Group.updateOne({ _id: group._id }, { $set: flattenSettings(input.settings) });
  const now = new Date();
  await GroupMember.create({
    group: group._id,
    user: userId,
    role: 'owner',
    via: 'creator',
    joinedAt: now,
    lastMessageAt: now,
    lastReadMessageId: pointerAt(now),
    lastDeliveredMessageId: pointerAt(now),
  });
  const invite = await createInvite(group._id, group.name, userId, {
    ...input.invite,
    requireApproval: input.invite?.requireApproval ?? input.settings?.members?.approveNewMembers ?? false,
  });
  joinGroupRoom(userId, group._id);
  await postSystemMessage(group._id, userId, 'created', `${(await getPublicUser(userId))?.displayName ?? 'Member'} created the group`);
  audit(userId, 'group_created', { group: group._id });
  return { group: await detailDTO(group._id, userId), invite: inviteDTO(invite.toObject()) };
}

export async function listGroups(userId, { filter, q }) {
  const query = { user: toObjectId(userId), status: 'active' };
  if (filter === 'archived') query.archived = true;
  else if (filter === 'all') query.archived = false;
  if (filter === 'created') query.role = 'owner';
  if (filter === 'joined') query.role = { $ne: 'owner' };
  if (filter === 'muted') query.mutedUntil = { $gt: new Date() };
  const members = await GroupMember.find(query).sort({ pinned: -1, lastMessageAt: -1 }).limit(500).lean();
  const groups = await Group.find({ _id: { $in: members.map((m) => m.group) }, status: { $ne: 'deleted' } })
    .select('name description category avatarUrl memberCount status createdBy lastMessage lastMessageAt settings createdAt')
    .lean();
  const gmap = new Map(groups.map((g) => [String(g._id), g]));
  const term = q?.toLowerCase();
  return members
    .map((m) => [gmap.get(String(m.group)), m])
    .filter(([g]) => g)
    .filter(([g]) => filter !== 'location' || g.settings?.location?.requirement !== 'off')
    .filter(([g]) => !term || g.name.toLowerCase().includes(term))
    .map(([g, m]) => summaryDTO(g, m, userId))
    .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : new Date(b.lastMessageAt) - new Date(a.lastMessageAt)));
}

export async function groupStats(userId) {
  const members = await GroupMember.find({ user: userId, status: 'active' }).select('group unreadCount mutedUntil').lean();
  const now = new Date();
  const groupIds = members.map((m) => m.group);
  const protectedFiles = groupIds.length
    ? await SecureFile.countDocuments({ group: { $in: groupIds }, revokedAt: null })
    : 0;
  return {
    groups: members.length,
    unread: members.reduce((s, m) => s + (m.mutedUntil && m.mutedUntil > now ? 0 : m.unreadCount), 0),
    unreadChats: members.filter((m) => m.unreadCount > 0).length,
    protectedFiles,
  };
}

export const getGroupDetail = (userId, groupId) => detailDTO(groupId, userId);

export async function updateGroupInfo(userId, groupId, patch) {
  const { group, member } = await requireGroupAccess(groupId, userId);
  if (!canEditInfo(group, member)) throw ApiError.forbidden('Only admins can edit group info', 'ADMIN_ONLY');
  await Group.updateOne({ _id: groupId }, { $set: patch });
  await invalidateGroup(groupId);
  if (patch.name && patch.name !== group.name) {
    const actor = await getPublicUser(userId);
    await postSystemMessage(groupId, userId, 'renamed', `${actor?.displayName ?? 'Member'} changed the group name to "${patch.name}"`);
  }
  audit(userId, 'group_info_updated', { group: groupId, meta: Object.keys(patch) });
  const detail = await detailDTO(groupId, userId);
  emitToGroup(groupId, 'group:updated', { groupId: String(groupId) });
  return detail;
}

export async function updateGroupSettings(userId, groupId, settings) {
  await requireGroupAccess(groupId, userId, { admin: true });
  const set = flattenSettings(settings);
  if (!Object.keys(set).length) throw ApiError.badRequest('Nothing to update');
  await Group.updateOne({ _id: groupId }, { $set: set });
  await invalidateGroup(groupId);
  audit(userId, 'group_settings_updated', { group: groupId, meta: set });
  emitToGroup(groupId, 'group:updated', { groupId: String(groupId) });
  return detailDTO(groupId, userId);
}

export async function deleteGroup(userId, groupId) {
  const { member } = await requireGroupAccess(groupId, userId, { allowSuspended: true });
  if (member.role !== 'owner') throw ApiError.forbidden('Only the group creator can delete the group', 'OWNER_ONLY');
  await Group.updateOne({ _id: groupId }, { $set: { status: 'deleted' } });
  const members = await GroupMember.find({ group: groupId, status: 'active' }).select('user').lean();
  await GroupMember.updateMany({ group: groupId, status: { $in: ['active', 'pending'] } }, { $set: { status: 'removed' } });
  await invalidateGroup(groupId);
  await Promise.all(members.map((m) => invalidateMembership(groupId, m.user)));
  emitToGroup(groupId, 'group:removed', { groupId: String(groupId), reason: 'deleted' });
  for (const m of members) leaveGroupRoom(m.user, groupId);
  audit(userId, 'group_deleted', { group: groupId });
  return { deleted: true };
}

// ===========================================================================
// My chat state
// ===========================================================================
export async function updateMyState(userId, groupId, { pinned, archived, muteSeconds }) {
  await requireGroupAccess(groupId, userId, { allowSuspended: true });
  const set = {};
  if (pinned !== undefined) set.pinned = pinned;
  if (archived !== undefined) Object.assign(set, { archived }, archived ? { pinned: false } : {});
  if (muteSeconds !== undefined) {
    set.mutedUntil = muteSeconds === 0 ? null : muteSeconds === -1 ? FOREVER : new Date(Date.now() + muteSeconds * 1000);
  }
  if (set.pinned) {
    const count = await GroupMember.countDocuments({ user: userId, status: 'active', pinned: true });
    if (count >= 5) throw ApiError.badRequest('You can pin up to 5 chats');
  }
  await GroupMember.updateOne({ group: groupId, user: userId }, { $set: set });
  const detail = await detailDTO(groupId, userId);
  emitToUser(userId, 'group:me', { groupId: String(groupId) });
  return detail;
}

export async function clearGroupChat(userId, groupId) {
  await requireGroupAccess(groupId, userId, { allowSuspended: true });
  await GroupMember.updateOne({ group: groupId, user: userId }, { $set: { clearedAt: new Date(), unreadCount: 0 } });
  await invalidateMembership(groupId, userId);
  emitToUser(userId, 'group:cleared', { groupId: String(groupId) });
  return { cleared: true };
}

// ===========================================================================
// Members
// ===========================================================================
function memberDTO(m, users, online, userId) {
  const u = users.get(String(m.user));
  return {
    userId: String(m.user),
    displayName: u?.displayName ?? 'Member',
    avatarUrl: u?.avatarUrl ?? null,
    role: m.role,
    restricted: m.restricted,
    restrictedUntil: m.restrictedUntil,
    joinedAt: m.joinedAt,
    online: online.get(String(m.user)) ?? false,
    lastSeenAt: u?.lastSeenAt ?? null,
    isMe: String(m.user) === String(userId),
    locationShared: Boolean(m.location?.lat != null && m.location?.mode !== 'none'),
  };
}

export async function listMembers(userId, groupId, { q } = {}) {
  await requireGroupAccess(groupId, userId, { allowSuspended: true });
  const rows = await GroupMember.find({ group: groupId, status: 'active' }).select('user role restricted restrictedUntil joinedAt location').limit(5000).lean();
  const [users, online] = await Promise.all([getPublicUsers(rows.map((r) => r.user)), onlineMap(rows.map((r) => r.user))]);
  const term = q?.trim().toLowerCase();
  return rows
    .map((r) => memberDTO(r, users, online, userId))
    .filter((m) => !term || m.displayName.toLowerCase().includes(term))
    .sort((a, b) => (a.isMe !== b.isMe ? (a.isMe ? -1 : 1) : ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName)));
}

export async function memberProfile(userId, groupId, targetId) {
  const { group, member: me } = await requireGroupAccess(groupId, userId, { allowSuspended: true });
  const m = await GroupMember.findOne({ group: groupId, user: targetId, status: 'active' }).lean();
  if (!m) throw ApiError.notFound('Member not found');
  const [users, online, blocked, blockedMe, sharedMedia] = await Promise.all([
    getPublicUsers([targetId]),
    onlineMap([targetId]),
    hasBlocked(userId, targetId),
    hasBlocked(targetId, userId),
    GroupMessage.countDocuments({ group: groupId, sender: targetId, status: 'active', media: { $exists: true } }),
  ]);
  const dto = memberDTO(m, users, online, userId);
  const vis = group.settings.location.visibility;
  const canSeeLocation = !blockedMe && vis !== 'nobody' && (vis === 'groupMembers' || isAdmin(me)) && dto.locationShared;
  return {
    ...dto,
    online: blockedMe ? false : dto.online,
    lastSeenAt: blockedMe ? null : dto.lastSeenAt,
    groupName: group.name,
    isBlocked: blocked,
    sharedMediaCount: sharedMedia,
    location: canSeeLocation ? m.location : null,
    canManage: isAdmin(me) && m.role !== 'owner' && !(m.role === 'admin' && me.role !== 'owner') && String(targetId) !== String(userId),
  };
}

async function activateMember(groupId, targetUserId, actorId) {
  await Promise.all([invalidateMembership(groupId, targetUserId), invalidateGroup(groupId)]);
  joinGroupRoom(targetUserId, groupId);
  await recomputePointers(groupId, { emit: false });
  emitToUser(targetUserId, 'group:joined', { groupId: String(groupId) });
  emitToGroup(groupId, 'group:member:joined', { groupId: String(groupId), userId: String(targetUserId), by: actorId ? String(actorId) : null });
}

export async function updateMember(userId, groupId, targetId, { role, restricted }) {
  const { member: me } = await requireGroupAccess(groupId, userId, { admin: true });
  const target = await GroupMember.findOne({ group: groupId, user: targetId, status: 'active' }).lean();
  if (!target) throw ApiError.notFound('Member not found');
  if (target.role === 'owner') throw ApiError.forbidden('The group creator cannot be changed');
  if (target.role === 'admin' && me.role !== 'owner') throw ApiError.forbidden('Only the creator can change other admins');
  const set = {};
  if (role) set.role = role;
  if (restricted !== undefined) set.restricted = restricted;
  await GroupMember.updateOne({ _id: target._id }, { $set: set });
  await invalidateMembership(groupId, targetId);
  const [actor, subject] = await Promise.all([getPublicUser(userId), getPublicUser(targetId)]);
  if (role && role !== target.role) {
    await postSystemMessage(
      groupId,
      userId,
      role === 'admin' ? 'promoted' : 'demoted',
      role === 'admin' ? `${actor?.displayName} made ${subject?.displayName} a group admin` : `${actor?.displayName} removed ${subject?.displayName} as admin`,
      targetId,
    );
  }
  if (restricted !== undefined && restricted !== target.restricted) {
    await postSystemMessage(groupId, userId, restricted ? 'restricted' : 'unrestricted', `${subject?.displayName} ${restricted ? 'can only read messages now' : 'can send messages again'}`, targetId);
  }
  audit(userId, 'member_updated', { group: groupId, target: targetId, meta: set });
  emitToGroup(groupId, 'group:member:updated', { groupId: String(groupId), userId: String(targetId), ...set });
  return memberProfile(userId, groupId, targetId);
}

async function transferOwnership(groupId, leavingUserId) {
  const next =
    (await GroupMember.findOne({ group: groupId, status: 'active', role: 'admin', user: { $ne: leavingUserId } }).sort({ joinedAt: 1 }).lean()) ??
    (await GroupMember.findOne({ group: groupId, status: 'active', user: { $ne: leavingUserId } }).sort({ joinedAt: 1 }).lean());
  if (!next) return null;
  await GroupMember.updateOne({ _id: next._id }, { $set: { role: 'owner' } });
  await Group.updateOne({ _id: groupId }, { $set: { createdBy: next.user } });
  await invalidateMembership(groupId, next.user);
  return next.user;
}

async function deactivateMember(groupId, targetId, status) {
  await GroupMember.updateOne({ group: groupId, user: targetId }, { $set: { status, role: 'member', pinned: false } });
  await Group.updateOne({ _id: groupId }, { $inc: { memberCount: -1 } });
  await Promise.all([invalidateMembership(groupId, targetId), invalidateGroup(groupId)]);
  leaveGroupRoom(targetId, groupId);
  await recomputePointers(groupId);
}

export async function removeMember(userId, groupId, targetId) {
  const { member: me } = await requireGroupAccess(groupId, userId, { admin: true, allowSuspended: true });
  const target = await GroupMember.findOne({ group: groupId, user: targetId, status: 'active' }).lean();
  if (!target) throw ApiError.notFound('Member not found');
  if (target.role === 'owner') throw ApiError.forbidden('The group creator cannot be removed');
  if (target.role === 'admin' && me.role !== 'owner') throw ApiError.forbidden('Only the creator can remove admins');
  await deactivateMember(groupId, targetId, 'removed');
  emitToUser(targetId, 'group:removed', { groupId: String(groupId), reason: 'removed' });
  const [actor, subject] = await Promise.all([getPublicUser(userId), getPublicUser(targetId)]);
  await postSystemMessage(groupId, userId, 'removed', `${actor?.displayName} removed ${subject?.displayName}`, targetId);
  emitToGroup(groupId, 'group:member:left', { groupId: String(groupId), userId: String(targetId), reason: 'removed' });
  audit(userId, 'member_removed', { group: groupId, target: targetId });
  return { removed: true };
}

export async function leaveGroup(userId, groupId) {
  const { member } = await requireGroupAccess(groupId, userId, { allowSuspended: true });
  let newOwner = null;
  if (member.role === 'owner') {
    newOwner = await transferOwnership(groupId, userId);
    if (!newOwner) return deleteGroup(userId, groupId); // last member leaves -> group ends
  }
  await deactivateMember(groupId, userId, 'left');
  const who = await getPublicUser(userId);
  await postSystemMessage(groupId, userId, 'left', `${who?.displayName ?? 'Member'} left`);
  if (newOwner) {
    const owner = await getPublicUser(newOwner);
    await postSystemMessage(groupId, newOwner, 'owner', `${owner?.displayName} is now the group creator`);
  }
  emitToGroup(groupId, 'group:member:left', { groupId: String(groupId), userId: String(userId), reason: 'left' });
  emitToUser(userId, 'group:removed', { groupId: String(groupId), reason: 'left' });
  return { left: true };
}

// ===========================================================================
// Join requests
// ===========================================================================
export async function listJoinRequests(userId, groupId) {
  await requireGroupAccess(groupId, userId, { admin: true, allowSuspended: true });
  const rows = await GroupMember.find({ group: groupId, status: 'pending' }).sort({ requestedAt: 1 }).lean();
  const users = await getPublicUsers(rows.map((r) => r.user));
  return rows.map((r) => ({
    userId: String(r.user),
    displayName: users.get(String(r.user))?.displayName ?? 'Member',
    avatarUrl: users.get(String(r.user))?.avatarUrl ?? null,
    requestedAt: r.requestedAt,
    via: r.via,
    locationShared: Boolean(r.location?.lat != null),
  }));
}

export async function decideJoinRequest(userId, groupId, targetId, approve) {
  await requireGroupAccess(groupId, userId, { admin: true });
  const g = await getGroup(groupId);
  const pending = await GroupMember.findOne({ group: groupId, user: targetId, status: 'pending' }).lean();
  if (!pending) throw ApiError.notFound('Join request not found');
  if (!approve) {
    await GroupMember.deleteOne({ _id: pending._id });
    await invalidateMembership(groupId, targetId);
    emitToUser(targetId, 'group:request:declined', { groupId: String(groupId), groupName: g.name });
    audit(userId, 'join_declined', { group: groupId, target: targetId });
    return { approved: false };
  }
  const now = new Date();
  await GroupMember.updateOne(
    { _id: pending._id },
    {
      $set: {
        status: 'active',
        joinedAt: now,
        clearedAt: now,
        lastMessageAt: now,
        lastReadMessageId: pointerAt(now),
        lastDeliveredMessageId: pointerAt(now),
        restrictedUntil: g.settings.members.restrictNewMembers ? new Date(now.getTime() + 86_400_000) : null,
      },
    },
  );
  await Group.updateOne({ _id: groupId }, { $inc: { memberCount: 1 } });
  await activateMember(groupId, targetId, userId);
  const [actor, subject] = await Promise.all([getPublicUser(userId), getPublicUser(targetId)]);
  await postSystemMessage(groupId, userId, 'approved', `${actor?.displayName} approved ${subject?.displayName}`, targetId);
  audit(userId, 'join_approved', { group: groupId, target: targetId });
  return { approved: true };
}

// ===========================================================================
// Invite links
// ===========================================================================
export async function listInvites(userId, groupId) {
  await requireGroupAccess(groupId, userId, { allowSuspended: true });
  const links = await InviteLink.find({ group: groupId }).sort({ createdAt: -1 }).limit(50).lean();
  const users = await getPublicUsers(links.map((l) => l.createdBy));
  return links.map((l) => inviteDTO(l, users.get(String(l.createdBy))?.displayName));
}

export async function newInvite(userId, groupId, options) {
  const { group } = await requireGroupAccess(groupId, userId, { admin: true });
  const link = await createInvite(groupId, group.name, userId, options);
  audit(userId, 'invite_created', { group: groupId, meta: { code: link.code, ...options } });
  return inviteDTO(link.toObject(), (await getPublicUser(userId))?.displayName);
}

export async function revokeInvite(userId, groupId, code) {
  await requireGroupAccess(groupId, userId, { admin: true, allowSuspended: true });
  const r = await InviteLink.updateOne({ group: groupId, code, status: 'active' }, { $set: { status: 'revoked', revokedAt: new Date() } });
  if (!r.matchedCount) throw ApiError.notFound('Invite link not found');
  audit(userId, 'invite_revoked', { group: groupId, meta: { code } });
  return { revoked: true };
}

export async function resetInvites(userId, groupId, options) {
  await requireGroupAccess(groupId, userId, { admin: true });
  await InviteLink.updateMany({ group: groupId, status: 'active' }, { $set: { status: 'revoked', revokedAt: new Date() } });
  audit(userId, 'invites_reset', { group: groupId });
  return newInvite(userId, groupId, options);
}

// ===========================================================================
// Join via invite
// ===========================================================================
function assertInviteUsable(link) {
  const state = inviteState(link);
  if (state === 'Revoked') throw ApiError.forbidden('This invite link was revoked', 'INVITE_REVOKED');
  if (state === 'Expired') throw ApiError.forbidden('This invite link has expired', 'INVITE_EXPIRED');
  if (state === 'Full') throw ApiError.forbidden('This invite link reached its maximum joins', 'INVITE_FULL');
}

export async function invitePreview(code, viewerId = null) {
  const link = await InviteLink.findOne({ code: code.toUpperCase() }).lean();
  if (!link) throw ApiError.notFound('Invite link not found');
  const g = await Group.findById(link.group).lean();
  if (!g || g.status === 'deleted') throw ApiError.notFound('Group not found');
  const creator = await getPublicUser(g.createdBy);
  let membership = null;
  if (viewerId) membership = await GroupMember.findOne({ group: g._id, user: viewerId }).select('status').lean();
  return {
    code: link.code,
    url: inviteUrl(link.code),
    state: inviteState(link),
    requireApproval: link.requireApproval || g.settings.members.approveNewMembers,
    group: {
      id: String(g._id),
      name: g.name,
      description: g.description,
      category: g.category,
      avatarUrl: g.avatarUrl,
      memberCount: g.memberCount,
      status: g.status,
      createdBy: creator?.displayName ?? 'Member',
      location: g.settings.location.requirement,
      locationShareMode: g.settings.location.shareMode,
      locationVisibility: g.settings.location.visibility,
      messageMode: g.settings.messages.messageMode,
    },
    membership: membership?.status ?? null,
  };
}

export async function joinByInvite(userId, code, { location, shareMode }) {
  const link = await InviteLink.findOne({ code: code.toUpperCase() }).lean();
  if (!link) throw ApiError.notFound('Invite link not found');
  const g = await Group.findById(link.group).lean();
  if (!g || g.status !== 'active') throw ApiError.forbidden('This group is not available', 'GROUP_UNAVAILABLE');
  const groupId = String(g._id);

  const existing = await GroupMember.findOne({ group: groupId, user: userId }).lean();
  if (existing?.status === 'active') return { status: 'active', groupId, alreadyMember: true };
  if (existing?.status === 'pending') return { status: 'pending', groupId };

  assertInviteUsable(link);
  const requirement = g.settings.location.requirement;
  if (requirement === 'mandatory' && !location) {
    throw ApiError.forbidden('This group requires your location to join', 'LOCATION_REQUIRED');
  }

  // Atomic seat reservation (max joins / expiry / revoked checked in the filter).
  const now = new Date();
  const reserved = await InviteLink.findOneAndUpdate(
    {
      _id: link._id,
      status: 'active',
      $and: [
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
        { $or: [{ maxJoins: 0 }, { $expr: { $lt: ['$joins', '$maxJoins'] } }] },
      ],
    },
    { $inc: { joins: 1 } },
    { returnDocument: 'after' },
  );
  if (!reserved) {
    // Lost the last seat, or the link was revoked / expired meanwhile.
    assertInviteUsable({ ...link, joins: link.maxJoins });
    throw ApiError.forbidden('This invite link is no longer valid', 'INVITE_INVALID');
  }

  const memberLocation = location
    ? { ...location, mode: shareMode ?? g.settings.location.shareMode ?? 'join', updatedAt: now }
    : null;
  if (location) {
    await LocationHistory.create({ user: userId, lat: location.lat, lng: location.lng, place: location.place, accuracy: location.accuracy, source: 'join', group: groupId });
  }

  const needsApproval = link.requireApproval || g.settings.members.approveNewMembers;
  const base = { role: 'member', via: 'invite', inviteCode: link.code, location: memberLocation, restricted: false };
  if (needsApproval) {
    await GroupMember.updateOne(
      { group: groupId, user: userId },
      { $set: { ...base, status: 'pending', requestedAt: now } },
      { upsert: true },
    );
    await invalidateMembership(groupId, userId);
    const admins = await adminIds(groupId);
    const who = await getPublicUser(userId);
    emitToUsers(admins, 'group:join_request', { groupId, groupName: g.name, userId: String(userId), displayName: who?.displayName });
    return { status: 'pending', groupId };
  }

  await GroupMember.updateOne(
    { group: groupId, user: userId },
    {
      $set: {
        ...base,
        status: 'active',
        joinedAt: now,
        clearedAt: now, // history before joining stays private
        lastMessageAt: now,
        lastReadMessageId: pointerAt(now),
        lastDeliveredMessageId: pointerAt(now),
        unreadCount: 0,
        restrictedUntil: g.settings.members.restrictNewMembers ? new Date(now.getTime() + 86_400_000) : null,
      },
    },
    { upsert: true },
  );
  await Group.updateOne({ _id: groupId }, { $inc: { memberCount: 1 } });
  await activateMember(groupId, userId, null);
  const who = await getPublicUser(userId);
  await postSystemMessage(groupId, userId, 'joined', `${who?.displayName ?? 'Member'} joined using an invite link`);
  audit(userId, 'group_joined', { group: groupId, meta: { code: link.code, location: Boolean(location) } });
  return { status: 'active', groupId };
}
