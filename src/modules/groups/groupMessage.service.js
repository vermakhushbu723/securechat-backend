import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import { env } from '../../config/env.js';
import { redis } from '../../db/redis.js';
import { getBlockedBy, getPublicUser, getPublicUsers } from '../../services/cache.service.js';
import { enqueuePush } from '../../services/queue.service.js';
import { emitToUser } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { checkContent } from '../../utils/contentFilter.js';
import { escapeRegex, toObjectId } from '../../utils/validators.js';
import { audit } from '../audit/audit.service.js';
import { logFileAction, revokeFilesOfMessages, signFileToken } from '../files/file.service.js';
import { FileAccessLog, SecureFile } from '../files/secureFile.model.js';
import { getContentSettings } from '../platform/platform.service.js';
import { displayNameOf, User } from '../users/user.model.js';
import {
  effectiveVisibility,
  emitFromSender,
  emitToGroup,
  getGroup,
  getMembership,
  isAdmin,
  requireGroupAccess,
  sendBlockReason,
} from './group.access.js';
import { Group, GroupMember } from './group.model.js';
import { EXPIRY_MS, expiryDate } from './group.schema.js';
import { toGroupMessageDTO, userMapFor } from './groupMessage.dto.js';
import { GroupMessage, groupPreviewText } from './groupMessage.model.js';

const { ObjectId } = mongoose.Types;
const EDIT_WINDOW_MS = env.MESSAGE_EDIT_WINDOW_MIN * 60_000;
const DELETE_WINDOW_MS = env.DELETE_FOR_EVERYONE_WINDOW_MIN * 60_000;

// ===========================================================================
// Read pointers -> ticks for the sender (min over active members)
// ===========================================================================
const ptrKey = (g) => `gptr:${g}`;

/** Pointer a member starts with: nothing before "now" is unread / pending for them. */
export const pointerAt = (date = new Date()) => ObjectId.createFromTime(Math.floor(date.getTime() / 1000));

export async function getPointers(groupId) {
  const cached = await redis.get(ptrKey(groupId));
  if (cached) return JSON.parse(cached);
  return recomputePointers(groupId, { emit: false });
}

export async function recomputePointers(groupId, { emit = true } = {}) {
  const [row] = await GroupMember.aggregate([
    { $match: { group: toObjectId(groupId), status: 'active' } },
    { $group: { _id: null, read: { $min: '$lastReadMessageId' }, delivered: { $min: '$lastDeliveredMessageId' } } },
  ]);
  const next = { read: row?.read ? String(row.read) : null, delivered: row?.delivered ? String(row.delivered) : null };
  const prev = await redis.getset(ptrKey(groupId), JSON.stringify(next));
  await redis.expire(ptrKey(groupId), 3600);
  if (emit && prev !== JSON.stringify(next)) {
    emitToGroup(String(groupId), 'group:status', { groupId: String(groupId), readUpTo: next.read, deliveredUpTo: next.delivered });
  }
  return next;
}

// ===========================================================================
// Helpers
// ===========================================================================
async function memberFilter(groupId, userId) {
  const [membership, blocked] = await Promise.all([getMembership(groupId, userId), getBlockedBy(userId)]);
  const filter = { group: toObjectId(groupId), deletedFor: { $ne: toObjectId(userId) } };
  const since = membership?.clearedAt ? new Date(membership.clearedAt) : null;
  if (since) {
    filter._id = { $gte: pointerAt(since) };
    filter.createdAt = { $gte: since };
  }
  if (blocked.length) filter.sender = { $nin: blocked.map(toObjectId) };
  return filter;
}

function mergeId(filter, range) {
  filter._id = { ...(filter._id ?? {}), ...range };
  return filter;
}

async function serialize(messages, viewerId, groupId, member) {
  const [users, pointers] = await Promise.all([userMapFor(messages), getPointers(groupId)]);
  const viewerIsAdmin = isAdmin(member);
  return messages.map((m) => toGroupMessageDTO(m, viewerId, { users, pointers, viewerIsAdmin }));
}

/** Loads a message the user may see (member of its group, not deleted for them). */
export async function loadMessageForUser(messageId, userId, { allowSuspended = true } = {}) {
  const m = await GroupMessage.findById(messageId).lean();
  if (!m) throw ApiError.notFound('Message not found');
  const { group, member } = await requireGroupAccess(String(m.group), userId, { allowSuspended });
  if (m.deletedFor?.some((u) => String(u) === String(userId))) throw ApiError.notFound('Message not found');
  if (member.clearedAt && m.createdAt < new Date(member.clearedAt)) throw ApiError.notFound('Message not found');
  return { m, group, member };
}

async function emitMessage(event, m, { exceptSender = false } = {}) {
  const users = await userMapFor([m]);
  const pointers = await getPointers(String(m.group));
  // Room broadcast with the viewer-agnostic DTO (view-once content never included).
  const dto = toGroupMessageDTO(m, '000000000000000000000000', { users, pointers: null });
  await emitFromSender(String(m.group), String(m.sender), event, dto, { exceptSender: true });
  // Sender (all devices) gets their own view with ticks.
  if (!exceptSender) emitToUser(String(m.sender), event, toGroupMessageDTO(m, m.sender, { users, pointers }));
}

async function touchGroupLastMessage(groupId, m) {
  await Group.updateOne(
    { _id: groupId, $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: m.createdAt } }] },
    {
      $set: {
        lastMessage: {
          id: m._id,
          sender: m.sender,
          senderName: (await getPublicUser(m.sender))?.displayName ?? 'Member',
          type: m.type,
          text: groupPreviewText(m),
          visibility: m.visibility,
          deleted: false,
          createdAt: m.createdAt,
        },
        lastMessageAt: m.createdAt,
      },
    },
  );
}

// ===========================================================================
// System messages ("Rahul joined using invite link")
// ===========================================================================
export async function postSystemMessage(groupId, actorId, event, text, targetId = null) {
  const m = (
    await GroupMessage.create({
      group: groupId,
      sender: actorId,
      clientMsgId: `sys:${randomUUID()}`,
      type: 'system',
      text,
      visibility: 'public',
      system: { event, actor: actorId, target: targetId },
    })
  ).toObject();
  await touchGroupLastMessage(groupId, m);
  await GroupMember.updateMany({ group: groupId, status: 'active' }, { $max: { lastMessageAt: m.createdAt } });
  const users = await userMapFor([m]);
  emitToGroup(String(groupId), 'group:message:new', toGroupMessageDTO(m, '000000000000000000000000', { users }));
  return m;
}

// ===========================================================================
// Send
// ===========================================================================
async function enforceContent(userId, groupId, group, text) {
  if (!text?.trim()) return;
  const cs = await getContentSettings();
  const enabled = [...new Set([...(group.settings.contentRules ?? []), ...cs.globalRules])];
  const rule = checkContent(text, { enabled, abuseWords: cs.abuseWords });
  if (!rule) return;
  const u = await User.findByIdAndUpdate(userId, { $inc: { warnings: 1 } }, { returnDocument: 'after', lean: true, projection: { warnings: 1 } });
  audit(userId, 'content_blocked', { group: groupId, meta: { rule, text: text.slice(0, 200) } });
  throw new ApiError(422, 'CONTENT_BLOCKED', 'This message cannot be sent because it contains restricted content.', {
    rule,
    warnings: u?.warnings ?? 1,
    maxWarnings: cs.maxWarnings,
  });
}

export async function sendGroupMessage(userId, input, { forwardFrom = null, skipContent = false } = {}) {
  const groupId = input.groupId;
  const { group, member } = await requireGroupAccess(groupId, userId);
  const blocked = sendBlockReason(group, member, input.type);
  if (blocked) throw ApiError.forbidden(blocked[1], blocked[0]);

  const visibility = forwardFrom ? forwardFrom.visibility : effectiveVisibility(group, input.visibility);
  if (!skipContent) await enforceContent(userId, groupId, group, input.text);

  // Media: protected content must be an encrypted file owned by the sender.
  let media;
  let secureFile = null;
  if (input.media) {
    const { secure: _s, kind: _k, secureFileId, ...rest } = input.media;
    if (secureFileId) {
      secureFile = await SecureFile.findOne({ _id: secureFileId, owner: userId, message: null }).lean();
      if (!secureFile) throw ApiError.badRequest('File not found or already attached');
      media = { secureFileId: secureFile._id, mimeType: secureFile.mimeType, name: secureFile.name, size: secureFile.size, width: secureFile.width, height: secureFile.height, duration: secureFile.duration ?? rest.duration };
    } else {
      if (visibility !== 'public') {
        throw new ApiError(400, 'SECURE_UPLOAD_REQUIRED', 'Private and Highly Protected files must be uploaded as secure files');
      }
      media = rest;
    }
  }

  let replyTo;
  if (input.replyToId) {
    const r = await GroupMessage.findOne({ _id: input.replyToId, group: groupId, status: 'active' }).lean();
    if (!r) throw ApiError.badRequest('Replied message not found');
    replyTo = {
      id: r._id,
      sender: r.sender,
      senderName: (await getPublicUser(r.sender))?.displayName,
      type: r.type,
      text: r.permissions?.viewOnce ? 'View once message' : groupPreviewText(r),
      visibility: r.visibility,
    };
  }

  const isPublic = visibility === 'public';
  const permissions = {
    allowDownload: isPublic ? input.allowDownload !== false : false,
    allowScreenshot: isPublic ? input.allowScreenshot !== false : false,
    allowShare: false,
    allowPrint: false,
    whoCanView: 'members',
    viewOnce: input.expiry === 'view_once',
    expiresAt: EXPIRY_MS[input.expiry] ? expiryDate(input.expiry) : null,
  };

  let m;
  try {
    m = (
      await GroupMessage.create({
        group: groupId,
        sender: userId,
        clientMsgId: input.clientMsgId,
        type: input.type,
        text: input.text?.trim() ?? '',
        media,
        location: input.location,
        contact: input.contact,
        visibility,
        permissions,
        silent: Boolean(input.silent),
        replyTo,
        forward: forwardFrom ? forwardFrom.forward : undefined,
      })
    ).toObject();
  } catch (err) {
    if (err.code !== 11000) throw err;
    const existing = await GroupMessage.findOne({ sender: userId, clientMsgId: input.clientMsgId }).lean();
    const [dto] = await serialize([existing], userId, groupId, member);
    return { message: dto, duplicate: true };
  }

  if (secureFile) await SecureFile.updateOne({ _id: secureFile._id }, { $set: { message: m._id, group: groupId } });

  await Promise.all([
    touchGroupLastMessage(groupId, m),
    GroupMember.updateMany(
      { group: groupId, status: 'active', user: { $ne: toObjectId(userId) } },
      { $inc: { unreadCount: 1 }, $max: { lastMessageAt: m.createdAt } },
    ),
    GroupMember.updateOne(
      { group: groupId, user: userId },
      { $max: { lastMessageAt: m.createdAt, lastReadMessageId: m._id, lastDeliveredMessageId: m._id }, $set: { lastReadAt: m.createdAt } },
    ),
  ]);
  await recomputePointers(groupId, { emit: false });
  await emitMessage('group:message:new', m);

  if (!m.silent) {
    const sender = await getPublicUser(userId);
    enqueuePush({
      kind: 'group',
      groupId: String(groupId),
      senderId: String(userId),
      senderName: sender?.displayName ?? 'Member',
      groupName: group.name,
      preview: groupPreviewText(m),
    });
  }
  const [dto] = await serialize([m], userId, groupId, member);
  return { message: dto, duplicate: false };
}

// ===========================================================================
// History, single message, search, media
// ===========================================================================
export async function listMessages(userId, groupId, { before, after, limit }) {
  const { member } = await requireGroupAccess(groupId, userId, { allowSuspended: true });
  const filter = await memberFilter(groupId, userId);
  if (before) mergeId(filter, { $lt: toObjectId(before) });
  else if (after) mergeId(filter, { $gt: toObjectId(after) });
  const rows = await GroupMessage.find(filter).sort({ _id: after ? 1 : -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!after) page.reverse();
  return { items: await serialize(page, userId, groupId, member), hasMore };
}

export async function getMessage(userId, messageId) {
  const { m, member } = await loadMessageForUser(messageId, userId);
  const [dto] = await serialize([m], userId, String(m.group), member);
  return dto;
}

const SEARCH_FILTERS = {
  text: { type: 'text' },
  photos: { type: 'image' },
  docs: { type: 'file' },
  voice: { type: { $in: ['voice', 'audio'] } },
  protected: { visibility: { $ne: 'public' } },
};

export async function searchMessages(userId, groupId, { q, filter, limit }) {
  const { member } = await requireGroupAccess(groupId, userId, { allowSuspended: true });
  const base = {
    ...(await memberFilter(groupId, userId)),
    status: 'active',
    type: { $ne: 'system' },
    'permissions.viewOnce': { $ne: true },
    ...(SEARCH_FILTERS[filter] ?? {}),
  };
  let rows = [];
  if (q) {
    rows = await GroupMessage.find({ ...base, $text: { $search: q } }).sort({ _id: -1 }).limit(limit).lean();
    if (!rows.length) {
      rows = await GroupMessage.find({ ...base, text: { $regex: escapeRegex(q), $options: 'i' } })
        .sort({ _id: -1 })
        .limit(limit)
        .maxTimeMS(3_000)
        .lean();
    }
  } else {
    rows = await GroupMessage.find(base).sort({ _id: -1 }).limit(limit).lean();
  }
  return serialize(rows, userId, groupId, member);
}

const MEDIA_KINDS = {
  media: { type: { $in: ['image', 'video'] } },
  docs: { type: 'file' },
  audio: { type: { $in: ['audio', 'voice'] } },
  protected: { visibility: { $ne: 'public' }, media: { $exists: true } },
  links: { type: 'text', text: { $regex: 'https?://', $options: 'i' } },
};

export async function listMedia(userId, groupId, { kind, before, limit }) {
  const { member } = await requireGroupAccess(groupId, userId, { allowSuspended: true });
  const filter = { ...(await memberFilter(groupId, userId)), status: 'active', ...MEDIA_KINDS[kind] };
  if (before) mergeId(filter, { $lt: toObjectId(before) });
  const rows = await GroupMessage.find(filter).sort({ _id: -1 }).limit(limit).lean();
  return serialize(rows, userId, groupId, member);
}

// ===========================================================================
// Receipts
// ===========================================================================
async function unreadFor(groupId, userId, lastReadId) {
  const filter = { ...(await memberFilter(groupId, userId)), sender: { $ne: toObjectId(userId) }, type: { $ne: 'system' } };
  if (lastReadId) mergeId(filter, { $gt: toObjectId(lastReadId) });
  return GroupMessage.countDocuments(filter).limit(999);
}

export async function markGroupRead(userId, { groupId, upToMessageId }) {
  await requireGroupAccess(groupId, userId, { allowSuspended: true });
  const now = new Date();
  const upTo = toObjectId(upToMessageId);
  const reader = await User.findById(userId).select('privacy.readReceipts').lean();
  const update = { $max: { lastDeliveredMessageId: upTo }, $set: { lastDeliveredAt: now } };
  // Read receipts off -> read state stays private (never counted as "read by").
  if (reader?.privacy?.readReceipts !== false) {
    update.$max.lastReadMessageId = upTo;
    update.$set.lastReadAt = now;
  }
  const member = await GroupMember.findOneAndUpdate({ group: groupId, user: userId }, update, { returnDocument: 'after', lean: true });
  const unreadCount = await unreadFor(groupId, userId, reader?.privacy?.readReceipts === false ? upTo : member.lastReadMessageId);
  await GroupMember.updateOne({ _id: member._id }, { $set: { unreadCount } });
  emitToUser(userId, 'group:read', { groupId: String(groupId), unreadCount });
  await recomputePointers(groupId);
  return { unreadCount };
}

export async function markGroupDelivered(userId, { groupId, upToMessageId }) {
  await requireGroupAccess(groupId, userId, { allowSuspended: true });
  const r = await GroupMember.updateOne(
    { group: groupId, user: userId, $or: [{ lastDeliveredMessageId: null }, { lastDeliveredMessageId: { $lt: toObjectId(upToMessageId) } }] },
    { $set: { lastDeliveredMessageId: toObjectId(upToMessageId), lastDeliveredAt: new Date() } },
  );
  if (r.modifiedCount) await recomputePointers(groupId);
  return { updated: r.modifiedCount };
}

/** On connect: everything received while offline is now delivered. */
export async function markAllGroupsDelivered(userId) {
  const memberships = await GroupMember.find({ user: userId, status: 'active', unreadCount: { $gt: 0 } })
    .select('group lastDeliveredMessageId')
    .limit(300)
    .lean();
  if (!memberships.length) return 0;
  const groups = await Group.find({ _id: { $in: memberships.map((m) => m.group) } }).select('lastMessage').lean();
  const last = new Map(groups.map((g) => [String(g._id), g.lastMessage?.id]));
  for (const m of memberships) {
    const lastId = last.get(String(m.group));
    if (lastId && (!m.lastDeliveredMessageId || String(m.lastDeliveredMessageId) < String(lastId))) {
      await markGroupDelivered(userId, { groupId: String(m.group), upToMessageId: String(lastId) }).catch(() => {});
    }
  }
  return memberships.length;
}

// ===========================================================================
// Edit, react, star, delete for me
// ===========================================================================
export async function editGroupMessage(userId, { messageId, text }) {
  const { m, group, member } = await loadMessageForUser(messageId, userId, { allowSuspended: false });
  if (String(m.sender) !== String(userId)) throw ApiError.forbidden('You can only edit your own messages');
  if (m.status !== 'active') throw ApiError.badRequest('Message is no longer available');
  if (!['text', 'image', 'video'].includes(m.type)) throw ApiError.badRequest('This message cannot be edited');
  if (Date.now() - m.createdAt.getTime() > EDIT_WINDOW_MS) {
    throw ApiError.forbidden(`Messages can be edited for ${env.MESSAGE_EDIT_WINDOW_MIN} minutes`, 'EDIT_WINDOW_EXPIRED');
  }
  await enforceContent(userId, String(m.group), group, text);
  const updated = await GroupMessage.findByIdAndUpdate(m._id, { $set: { text, editedAt: new Date() } }, { returnDocument: 'after', lean: true });
  await Group.updateOne({ _id: m.group, 'lastMessage.id': m._id }, { $set: { 'lastMessage.text': groupPreviewText(updated) } });
  await emitMessage('group:message:updated', updated);
  const [dto] = await serialize([updated], userId, String(m.group), member);
  return dto;
}

export async function reactGroupMessage(userId, { messageId, emoji }) {
  const { m, member } = await loadMessageForUser(messageId, userId, { allowSuspended: false });
  if (m.status !== 'active' || m.type === 'system') throw ApiError.badRequest('Message is no longer available');
  const uid = toObjectId(userId);
  await GroupMessage.updateOne({ _id: m._id }, { $pull: { reactions: { user: uid } } });
  const updated = emoji
    ? await GroupMessage.findByIdAndUpdate(m._id, { $push: { reactions: { user: uid, emoji, at: new Date() } } }, { returnDocument: 'after', lean: true })
    : await GroupMessage.findById(m._id).lean();
  await emitMessage('group:message:updated', updated);
  const [dto] = await serialize([updated], userId, String(m.group), member);
  return dto;
}

export async function starGroupMessage(userId, { messageId, starred }) {
  const { m, member } = await loadMessageForUser(messageId, userId);
  const uid = toObjectId(userId);
  const updated = await GroupMessage.findByIdAndUpdate(m._id, starred ? { $addToSet: { starredBy: uid } } : { $pull: { starredBy: uid } }, {
    returnDocument: 'after',
    lean: true,
  });
  const [dto] = await serialize([updated], userId, String(m.group), member);
  emitToUser(userId, 'group:message:updated', dto); // private
  return dto;
}

// ===========================================================================
// Delete for everyone (chain aware)
// ===========================================================================
async function chainDescendants(messageId) {
  return GroupMessage.find({ 'forward.ancestors': toObjectId(messageId), status: 'active' }).select('_id group sender').lean();
}

function canDeleteForEveryone(m, group, member, userId) {
  const mine = String(m.sender) === String(userId);
  if (!mine && !isAdmin(member)) return [false, 'Only the sender or a group admin can delete for everyone', 'FORBIDDEN'];
  if (mine && !isAdmin(member) && !group.settings.security.deleteForEveryoneUnlimited && Date.now() - m.createdAt.getTime() > DELETE_WINDOW_MS) {
    return [false, 'Too late to delete this message for everyone', 'DELETE_WINDOW_EXPIRED'];
  }
  return [true, null, null];
}

export async function deletePreview(userId, messageId) {
  const { m, group, member } = await loadMessageForUser(messageId, userId);
  const [can, reason] = canDeleteForEveryone(m, group, member, userId);
  const descendants = await chainDescendants(m._id);
  const chain = await buildChain(m.forward?.rootId ?? m._id);
  return {
    canDelete: can && m.status === 'active',
    reason,
    isOriginal: !m.forward,
    chainRequired: Boolean(group.settings.security.chainDeletion),
    copiesAffected: 1 + descendants.length,
    usersAffected: chain.nodesById.get(String(m._id)) ? subtreeUsers(chain.nodesById.get(String(m._id))) : group.memberCount,
    tree: chain.tree,
    totals: chain.totals,
  };
}

export async function deleteGroupMessage(userId, { messageId, scope, chain }) {
  const { m, group, member } = await loadMessageForUser(messageId, userId);

  if (scope === 'me') {
    await GroupMessage.updateOne({ _id: m._id }, { $addToSet: { deletedFor: toObjectId(userId) } });
    emitToUser(userId, 'group:message:removed', { groupId: String(m.group), messageId: String(m._id) });
    return { messageId: String(m._id), scope, deleted: 1 };
  }

  if (m.status !== 'active') return { messageId: String(m._id), scope, deleted: 0 };
  const [can, reason, code] = canDeleteForEveryone(m, group, member, userId);
  if (!can) throw ApiError.forbidden(reason, code);

  const withChain = group.settings.security.chainDeletion || chain;
  const descendants = withChain ? await chainDescendants(m._id) : [];
  const ids = [m._id, ...descendants.map((d) => d._id)];
  const now = new Date();
  const ownReason = String(m.sender) === String(userId) ? 'sender' : 'admin';
  const wipe = {
    $set: { status: 'deleted_for_everyone', deletedAt: now, deletedBy: toObjectId(userId), text: '', reactions: [] },
    $unset: { media: 1, location: 1, contact: 1, replyTo: 1 },
  };
  await GroupMessage.updateOne({ _id: m._id }, { ...wipe, $set: { ...wipe.$set, deletedReason: ownReason } });
  if (descendants.length) {
    await GroupMessage.updateMany({ _id: { $in: descendants.map((d) => d._id) } }, { ...wipe, $set: { ...wipe.$set, deletedReason: 'chain' } });
  }
  await revokeFilesOfMessages(ids);

  const affected = await GroupMessage.find({ _id: { $in: ids } }).lean();
  for (const d of affected) {
    await Group.updateOne({ _id: d.group, 'lastMessage.id': d._id }, { $set: { 'lastMessage.deleted': true, 'lastMessage.text': groupPreviewText(d) } });
    await emitMessage('group:message:updated', d);
  }
  audit(userId, 'message_deleted_for_everyone', {
    group: m.group,
    target: m._id,
    meta: { chain: withChain, copiesRemoved: ids.length, groups: new Set(affected.map((a) => String(a.group))).size },
  });
  return { messageId: String(m._id), scope, deleted: ids.length, groups: new Set(affected.map((a) => String(a.group))).size };
}

// ===========================================================================
// Forward (public only) with chain linking
// ===========================================================================
export async function forwardGroupMessages(userId, { messageIds, toGroupIds, clientMsgId }) {
  const sources = [];
  for (const id of messageIds) {
    const { m, group } = await loadMessageForUser(id, userId, { allowSuspended: false });
    if (m.status !== 'active' || m.type === 'system') throw ApiError.badRequest('Message is no longer available');
    const sec = group.settings.security;
    const privateAllowed = m.visibility === 'private' && sec.privateForwarding && !m.media?.secureFileId;
    if (!((m.visibility === 'public' && sec.publicForwarding) || privateAllowed)) {
      throw ApiError.forbidden('Private and Highly Protected messages cannot be forwarded', 'FORWARD_NOT_ALLOWED');
    }
    if (m.permissions?.viewOnce) throw ApiError.forbidden('View once messages cannot be forwarded', 'FORWARD_NOT_ALLOWED');
    sources.push(m);
  }

  const results = [];
  for (const [j, gid] of [...new Set(toGroupIds.map(String))].entries()) {
    const target = await getGroup(gid);
    if (!target || target.status !== 'active') throw ApiError.forbidden('Target group is not available', 'GROUP_UNAVAILABLE');
    if (target.settings.messages.messageMode === 'private') {
      throw ApiError.forbidden(`Forwarding is not allowed into ${target.name} (private-only group)`, 'FORWARD_NOT_ALLOWED');
    }
    for (const [i, src] of sources.entries()) {
      const forward = {
        rootId: src.forward?.rootId ?? src._id,
        parentId: src._id,
        ancestors: [...(src.forward?.ancestors ?? []), src._id],
        depth: (src.forward?.depth ?? 0) + 1,
        originGroup: src.forward?.originGroup ?? src.group,
        originSender: src.forward?.originSender ?? src.sender,
        originAt: src.forward?.originAt ?? src.createdAt,
      };
      const { message } = await sendGroupMessage(
        userId,
        {
          groupId: gid,
          clientMsgId: `${clientMsgId}:${j}:${i}`,
          type: src.type,
          text: src.text,
          media: src.media ? { ...src.media, url: src.media.url } : undefined,
          location: src.location,
          contact: src.contact,
          expiry: 'never',
          allowDownload: src.permissions?.allowDownload,
          allowScreenshot: src.permissions?.allowScreenshot,
        },
        { forwardFrom: { visibility: src.visibility, forward }, skipContent: true },
      );
      // Users reached by the whole chain above this copy.
      await GroupMessage.updateMany({ _id: { $in: forward.ancestors } }, { $inc: { forwardCount: Math.max(target.memberCount - 1, 1) } });
      results.push(message);
    }
  }
  audit(userId, 'message_forwarded', { meta: { sources: messageIds, targets: toGroupIds } });
  return results;
}

// ===========================================================================
// View once
// ===========================================================================
export async function openViewOnce(userId, messageId) {
  const { m, member } = await loadMessageForUser(messageId, userId);
  if (!m.permissions?.viewOnce) throw ApiError.badRequest('Not a view once message');
  const mine = String(m.sender) === String(userId);
  if (!mine) {
    if (m.media?.secureFileId) throw ApiError.badRequest('Open the file in the secure viewer');
    const r = await GroupMessage.updateOne({ _id: m._id, openedBy: { $ne: toObjectId(userId) } }, { $addToSet: { openedBy: toObjectId(userId) } });
    if (!r.modifiedCount) throw new ApiError(410, 'ALREADY_OPENED', 'You already opened this view once message');
  }
  const users = await userMapFor([m]);
  return toGroupMessageDTO(m, userId, { users, viewerIsAdmin: isAdmin(member), revealed: true });
}

// ===========================================================================
// Message info / forward chain / forward details / deletion status
// ===========================================================================
export async function messageInfo(userId, messageId) {
  const { m, member, group } = await loadMessageForUser(messageId, userId);
  const [dto] = await serialize([m], userId, String(m.group), member);
  const base = { message: dto, groupName: group.name };
  // Receipts only for the sender and admins.
  if (String(m.sender) !== String(userId) && !isAdmin(member)) return { ...base, receiptsVisible: false, readBy: [], deliveredTo: [], pending: [] };

  const members = await GroupMember.find({ group: m.group, status: 'active', user: { $ne: m.sender }, joinedAt: { $lte: m.createdAt } })
    .select('user lastReadMessageId lastReadAt lastDeliveredMessageId lastDeliveredAt')
    .limit(2000)
    .lean();
  const users = await getPublicUsers(members.map((x) => x.user));
  const id = String(m._id);
  const row = (x, at) => ({ userId: String(x.user), displayName: users.get(String(x.user))?.displayName ?? 'Member', avatarUrl: users.get(String(x.user))?.avatarUrl ?? null, at });
  const readBy = [];
  const deliveredTo = [];
  const pending = [];
  for (const x of members) {
    if (x.lastReadMessageId && String(x.lastReadMessageId) >= id) readBy.push(row(x, x.lastReadAt));
    else if (x.lastDeliveredMessageId && String(x.lastDeliveredMessageId) >= id) deliveredTo.push(row(x, x.lastDeliveredAt));
    else pending.push(row(x, null));
  }
  return { ...base, receiptsVisible: true, readBy, deliveredTo, pending };
}

function subtreeUsers(node) {
  return node.recipients + node.children.reduce((s, c) => s + subtreeUsers(c), 0);
}

/** Builds the whole forward tree of a root message (names only, never phone / ids). */
export async function buildChain(rootId, { deletedFrom = null } = {}) {
  const root = await GroupMessage.findById(rootId).lean();
  if (!root) throw ApiError.notFound('Original message not found');
  const copies = await GroupMessage.find({ 'forward.rootId': root._id }).select('group sender forward status createdAt').sort({ _id: 1 }).lean();
  const all = [root, ...copies];
  const [users, groups] = await Promise.all([
    getPublicUsers(all.map((x) => x.sender)),
    Group.find({ _id: { $in: [...new Set(all.map((x) => String(x.group)))] } }).select('name memberCount').lean(),
  ]);
  const gmap = new Map(groups.map((g) => [String(g._id), g]));
  const nodesById = new Map();
  for (const x of all) {
    const g = gmap.get(String(x.group));
    nodesById.set(String(x._id), {
      messageId: String(x._id),
      parentId: x.forward?.parentId ? String(x.forward.parentId) : null,
      from: users.get(String(x.sender))?.displayName ?? 'Member',
      to: g?.name ?? 'Group',
      groupId: String(x.group),
      time: x.createdAt,
      deleted: x.status === 'deleted_for_everyone',
      depth: x.forward?.depth ?? 0,
      recipients: Math.max((g?.memberCount ?? 1) - 1, 1),
      children: [],
    });
  }
  for (const node of nodesById.values()) if (node.parentId) nodesById.get(node.parentId)?.children.push(node);
  const tree = nodesById.get(String(root._id));
  const totals = {
    usersReached: subtreeUsers(tree),
    forwards: all.length - 1,
    groups: new Set(all.map((x) => String(x.group))).size,
    maxDepth: Math.max(...all.map((x) => x.forward?.depth ?? 0)),
  };
  return { tree, totals, nodesById, deletedFrom };
}

export async function forwardChain(userId, messageId) {
  const { m, group } = await loadMessageForUser(messageId, userId);
  if (!group.settings.security.trackForwardChain) throw ApiError.forbidden('Forward chain tracking is turned off in this group', 'CHAIN_TRACKING_OFF');
  const { tree, totals } = await buildChain(m.forward?.rootId ?? m._id);
  return { messageId: String(m._id), tree, totals };
}

export async function forwardDetails(userId, messageId) {
  const { m } = await loadMessageForUser(messageId, userId);
  if (!m.forward) return { forwarded: false };
  const [originSender, originGroup, forwardedBy, chain] = await Promise.all([
    getPublicUser(m.forward.originSender),
    Group.findById(m.forward.originGroup).select('name').lean(),
    getPublicUser(m.sender),
    buildChain(m.forward.rootId),
  ]);
  const node = chain.nodesById.get(String(m._id));
  return {
    forwarded: true,
    visibility: m.visibility,
    origin: { senderName: originSender?.displayName ?? 'Member', groupName: originGroup?.name ?? 'Group', time: m.forward.originAt },
    copy: {
      forwardedBy: forwardedBy?.displayName ?? 'Member',
      level: m.forward.depth,
      totalLevels: chain.totals.maxDepth,
      usersReached: node ? subtreeUsers(node) : 0,
    },
    manyTimes: m.forward.depth >= 4,
  };
}

export async function deletionStatus(userId, messageId) {
  const { m } = await loadMessageForUser(messageId, userId);
  if (m.status !== 'deleted_for_everyone') throw ApiError.badRequest('Message is not deleted');
  const deletedBy = m.deletedBy ? await getPublicUser(m.deletedBy) : null;
  const chain = await buildChain(m.forward?.rootId ?? m._id);
  const nodes = [...chain.nodesById.values()];
  const locations = nodes.map((n) => ({
    groupName: n.to,
    label: n.parentId ? `Forwarded by ${n.from}` : `Original (${n.from})`,
    status: n.deleted ? 'Deleted' : 'Active',
    users: n.recipients,
  }));
  const removed = nodes.filter((n) => n.deleted);
  return {
    deletedBy: deletedBy?.displayName ?? 'Member',
    deletedAt: m.deletedAt,
    reason: m.deletedReason === 'admin' ? 'Group admin' : m.deletedReason === 'chain' ? 'Chain deletion' : 'Sender request',
    copiesRemoved: removed.length,
    totalCopies: nodes.length,
    usersCleared: removed.reduce((s, n) => s + n.recipients, 0),
    statusFlow: ['ACTIVE', 'DELETED_FOR_EVERYONE', removed.length === nodes.length ? 'LINKED COPIES DELETED' : 'PARTIAL'],
    locations,
  };
}

// ===========================================================================
// Protected files: token, access log, permissions
// ===========================================================================
const maskedId = (userId) => `USR-****${String(userId).slice(-4).toUpperCase()}`;

async function fileContext(userId, fileId) {
  const file = await SecureFile.findById(fileId).lean();
  if (!file?.message) throw ApiError.notFound('File not found');
  const { m, group, member } = await loadMessageForUser(file.message, userId);
  return { file, m, group, member };
}

export async function issueFileToken(userId, fileId, ip) {
  const { file, m, group, member } = await fileContext(userId, fileId);
  const mine = String(m.sender) === String(userId);
  const deny = async (status, code, message) => {
    await logFileAction(file._id, userId, 'denied', ip);
    throw new ApiError(status, code, message);
  };
  if (file.revokedAt || m.status !== 'active') await deny(410, 'FILE_REVOKED', 'This file is no longer available');
  const p = m.permissions ?? {};
  if (!mine) {
    if (p.whoCanView === 'admins' && !isAdmin(member)) await deny(403, 'ADMINS_ONLY', 'Only group admins can view this file');
    if (p.accessExpiresAt && new Date(p.accessExpiresAt) < new Date()) await deny(403, 'ACCESS_EXPIRED', 'Access to this file has expired');
    if (p.viewOnce) {
      const r = await GroupMessage.updateOne({ _id: m._id, openedBy: { $ne: toObjectId(userId) } }, { $addToSet: { openedBy: toObjectId(userId) } });
      if (!r.modifiedCount) await deny(410, 'ALREADY_OPENED', 'You already opened this view once file');
    }
  }
  const { token, expiresIn } = signFileToken(userId, file._id);
  await logFileAction(file._id, userId, 'token_issued', ip);
  const viewer = await User.findById(userId).select('name displayName').lean();
  return {
    token,
    expiresIn,
    streamPath: `/api/v1/files/stream?token=${encodeURIComponent(token)}`,
    name: file.name,
    mimeType: file.mimeType,
    kind: file.kind,
    size: file.size,
    visibility: m.visibility,
    // Level 3 always carries the viewer watermark; level 2 when the group enables it.
    watermark: {
      name: displayNameOf(viewer),
      maskedId: maskedId(userId),
      enabled: m.visibility === 'highly_protected' || (m.visibility === 'private' && group.settings.security.dynamicWatermark),
    },
  };
}

export async function fileAccessLog(userId, fileId) {
  const { file, m, member } = await fileContext(userId, fileId);
  if (String(m.sender) !== String(userId) && !isAdmin(member)) throw ApiError.forbidden('Only the sender or admins can view the access log');
  const rows = await FileAccessLog.find({ file: file._id }).sort({ _id: -1 }).limit(200).lean();
  const users = await getPublicUsers(rows.map((r) => r.user));
  return rows.map((r) => ({ displayName: users.get(String(r.user))?.displayName ?? 'Member', action: r.action, at: r.createdAt }));
}

export async function fileInfo(userId, fileId) {
  const { file, m, group, member } = await fileContext(userId, fileId);
  const [dto] = await serialize([m], userId, String(m.group), member);
  return {
    fileId: String(file._id),
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    kind: file.kind,
    groupName: group.name,
    visibility: m.visibility,
    // Same rule as the secure viewer token: level 3 always, level 2 when the group enables it.
    permissions: {
      ...dto.permissions,
      watermark: m.visibility === 'highly_protected' || (m.visibility === 'private' && Boolean(group.settings.security.dynamicWatermark)),
    },
    revoked: Boolean(file.revokedAt),
    canManage: String(m.sender) === String(userId) || isAdmin(member),
    message: dto,
  };
}

export async function updateFilePermissions(userId, fileId, patch) {
  const { m, member } = await fileContext(userId, fileId);
  if (String(m.sender) !== String(userId) && !isAdmin(member)) throw ApiError.forbidden('Only the sender or admins can change file permissions');
  const set = {};
  if (patch.whoCanView) set['permissions.whoCanView'] = patch.whoCanView;
  if (patch.accessExpiry) set['permissions.accessExpiresAt'] = patch.accessExpiry === 'never' ? null : expiryDate(patch.accessExpiry);
  // Level 2 / 3 content can never be downloaded, shared or printed.
  const pub = m.visibility === 'public';
  for (const k of ['allowDownload', 'allowShare', 'allowPrint']) if (patch[k] !== undefined) set[`permissions.${k}`] = pub && patch[k];
  const updated = await GroupMessage.findByIdAndUpdate(m._id, { $set: set }, { returnDocument: 'after', lean: true });
  audit(userId, 'file_permissions_changed', { group: m.group, target: m._id, meta: patch });
  await emitMessage('group:message:updated', updated);
  return fileInfo(userId, fileId);
}

export async function logFileEvent(userId, fileId, action, ip) {
  const { file } = await fileContext(userId, fileId);
  await logFileAction(file._id, userId, action, ip);
  return { logged: true };
}

// ===========================================================================
// Expiry sweeper (worker)
// ===========================================================================
export async function expireMessages() {
  const due = await GroupMessage.find({ status: 'active', 'permissions.expiresAt': { $ne: null, $lte: new Date() } })
    .select('_id')
    .limit(500)
    .lean();
  if (!due.length) return 0;
  const ids = due.map((d) => d._id);
  await GroupMessage.updateMany(
    { _id: { $in: ids } },
    { $set: { status: 'expired', text: '', reactions: [] }, $unset: { media: 1, location: 1, contact: 1, replyTo: 1 } },
  );
  await revokeFilesOfMessages(ids);
  const expired = await GroupMessage.find({ _id: { $in: ids } }).lean();
  for (const m of expired) {
    await Group.updateOne({ _id: m.group, 'lastMessage.id': m._id }, { $set: { 'lastMessage.text': 'Message expired' } });
    await emitMessage('group:message:updated', m);
  }
  return ids.length;
}

// ===========================================================================
// Starred (all my groups)
// ===========================================================================
export async function listStarred(userId) {
  const rows = await GroupMessage.find({ starredBy: toObjectId(userId), status: 'active', deletedFor: { $ne: toObjectId(userId) } })
    .sort({ _id: -1 })
    .limit(200)
    .lean();
  const memberships = await GroupMember.find({ user: userId, status: 'active', group: { $in: rows.map((r) => r.group) } })
    .select('group role')
    .lean();
  const active = new Map(memberships.map((m) => [String(m.group), m]));
  const visible = rows.filter((r) => active.has(String(r.group)));
  const [users, groups] = await Promise.all([
    userMapFor(visible),
    Group.find({ _id: { $in: [...active.keys()] } }).select('name').lean(),
  ]);
  const gmap = new Map(groups.map((g) => [String(g._id), g.name]));
  return visible.map((m) => ({
    ...toGroupMessageDTO(m, userId, { users, viewerIsAdmin: isAdmin(active.get(String(m.group))) }),
    groupName: gmap.get(String(m.group)) ?? 'Group',
  }));
}
