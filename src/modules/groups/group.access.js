import { redis } from '../../db/redis.js';
import { getBlockers } from '../../services/cache.service.js';
import { getIO, userRoom } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { Group, GroupMember } from './group.model.js';

/**
 * Hot-path helpers for groups: cached group settings + memberships (checked
 * on every message / socket event), permission rules and group rooms.
 */
const GROUP_TTL = 300;
const MEMBER_TTL = 600;
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'file']);

export const groupRoom = (groupId) => `group:${groupId}`;
export const isAdmin = (member) => member?.role === 'owner' || member?.role === 'admin';

// ---------------------------------------------------------------------------
// Cached group
// ---------------------------------------------------------------------------
const gKey = (id) => `grp:${id}`;

export async function getGroup(groupId) {
  const cached = await redis.get(gKey(groupId));
  if (cached) return cached === 'null' ? null : JSON.parse(cached);
  const g = await Group.findById(groupId)
    .select('name description category rules avatarUrl createdBy status memberCount settings createdAt')
    .lean();
  const value = g ? { ...g, _id: String(g._id), createdBy: String(g.createdBy) } : null;
  await redis.set(gKey(groupId), JSON.stringify(value), 'EX', value ? GROUP_TTL : 30);
  return value;
}

export const invalidateGroup = (groupId) => redis.del(gKey(groupId));

// ---------------------------------------------------------------------------
// Cached membership
// ---------------------------------------------------------------------------
const mKey = (g, u) => `gmem:${g}:${u}`;

export async function getMembership(groupId, userId) {
  const cached = await redis.get(mKey(groupId, userId));
  if (cached) return cached === 'null' ? null : JSON.parse(cached);
  const m = await GroupMember.findOne({ group: groupId, user: userId })
    .select('role status restricted restrictedUntil joinedAt clearedAt')
    .lean();
  const value = m
    ? { role: m.role, status: m.status, restricted: m.restricted, restrictedUntil: m.restrictedUntil, joinedAt: m.joinedAt, clearedAt: m.clearedAt }
    : null;
  await redis.set(mKey(groupId, userId), JSON.stringify(value), 'EX', MEMBER_TTL);
  return value;
}

export const invalidateMembership = (groupId, userId) => redis.del(mKey(groupId, userId));

/** Throws unless the user is an active member (optionally admin) of an active group. */
export async function requireGroupAccess(groupId, userId, { admin = false, allowSuspended = false } = {}) {
  const group = await getGroup(groupId);
  if (!group || group.status === 'deleted') throw ApiError.notFound('Group not found');
  const member = await getMembership(groupId, userId);
  if (!member || member.status !== 'active') throw ApiError.forbidden('You are not a member of this group', 'NOT_MEMBER');
  if (group.status === 'suspended' && !allowSuspended) {
    throw ApiError.forbidden('This group is suspended by the platform admin', 'GROUP_SUSPENDED');
  }
  if (admin && !isAdmin(member)) throw ApiError.forbidden('Only group admins can do this', 'ADMIN_ONLY');
  return { group, member };
}

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

/** [code, message] when the member may not send this message type, else null. */
export function sendBlockReason(group, member, type) {
  if (group.status !== 'active') return ['GROUP_SUSPENDED', 'This group is suspended'];
  if (isAdmin(member)) return null;
  const s = group.settings;
  if (s.messages.whoCanSend === 'admins' || s.members.muteGroup) {
    return ['ADMINS_ONLY', 'Only admins can send messages in this group'];
  }
  if (member.restricted) return ['RESTRICTED', 'An admin restricted you to read only in this group'];
  if (member.restrictedUntil && new Date(member.restrictedUntil) > new Date()) {
    return ['NEW_MEMBER_RESTRICTED', 'New members can send messages 24 hours after joining'];
  }
  if (!s.messages.membersCanSendMedia && MEDIA_TYPES.has(type)) {
    return ['MEDIA_DISABLED', 'Members cannot send media in this group'];
  }
  return null;
}

/** Group message mode overrides the sender's choice unless it is "user can select". */
export function effectiveVisibility(group, requested) {
  const mode = group.settings.messages.messageMode;
  if (mode === 'public') return 'public';
  if (mode === 'private') return 'private';
  return requested ?? 'public';
}

export const canEditInfo = (group, member) => isAdmin(member) || group.settings.messages.membersCanEditInfo;

// ---------------------------------------------------------------------------
// Rooms & emits (Redis adapter -> works across every node)
// ---------------------------------------------------------------------------
export function joinGroupRoom(userId, groupId) {
  getIO()?.in(userRoom(userId)).socketsJoin(groupRoom(groupId));
}

export function leaveGroupRoom(userId, groupId) {
  getIO()?.in(userRoom(userId)).socketsLeave(groupRoom(groupId));
}

/** Emits to every member socket in the group, except the given users. */
export function emitToGroup(groupId, event, payload, { except = [] } = {}) {
  const io = getIO();
  if (!io) return;
  let op = io.to(groupRoom(groupId));
  if (except.length) op = op.except(except.map((u) => userRoom(u)));
  op.emit(event, payload);
}

/** Group emit that skips members who blocked the sender. */
export async function emitFromSender(groupId, senderId, event, payload, { exceptSender = false } = {}) {
  const blockers = await getBlockers(senderId);
  emitToGroup(groupId, event, payload, { except: exceptSender ? [...blockers, String(senderId)] : blockers });
}

export async function adminIds(groupId) {
  const rows = await GroupMember.find({ group: groupId, status: 'active', role: { $in: ['owner', 'admin'] } })
    .select('user')
    .lean();
  return rows.map((r) => String(r.user));
}
