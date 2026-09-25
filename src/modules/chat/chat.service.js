import mongoose from 'mongoose';

import { env } from '../../config/env.js';
import {
  cacheParticipants,
  getParticipants,
  getPublicUser,
  getPublicUsers,
  hasBlocked,
  isBlockedBetween,
} from '../../services/cache.service.js';
import { isOnline, onlineMap } from '../../services/presence.service.js';
import { enqueuePush } from '../../services/queue.service.js';
import { emitToUser } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { escapeRegex, toObjectId } from '../../utils/validators.js';
import { User } from '../users/user.model.js';
import { Conversation, pairKeyOf } from './conversation.model.js';
import { ConversationMember } from './conversationMember.model.js';
import { Message, previewText, toMessageDTO } from './message.model.js';

const { ObjectId } = mongoose.Types;
const EDIT_WINDOW_MS = env.MESSAGE_EDIT_WINDOW_MIN * 60_000;
const DELETE_WINDOW_MS = env.DELETE_FOR_EVERYONE_WINDOW_MIN * 60_000;
const MAX_PINNED = 5;
const FOREVER = new Date('9999-12-31T00:00:00Z');

// ===========================================================================
// Helpers
// ===========================================================================

/** Throws 404 unless the user is a participant. Returns the other user id. */
async function assertMember(conversationId, userId) {
  const participants = await getParticipants(conversationId);
  if (!participants?.includes(String(userId))) throw ApiError.notFound('Conversation not found');
  return { participants, peerId: participants.find((p) => p !== String(userId)) };
}

async function loadMessageForUser(messageId, userId) {
  const m = await Message.findById(messageId).lean();
  if (!m) throw ApiError.notFound('Message not found');
  const uid = String(userId);
  if (String(m.sender) !== uid && String(m.recipient) !== uid) throw ApiError.notFound('Message not found');
  if (m.deletedFor?.some((u) => String(u) === uid)) throw ApiError.notFound('Message not found');
  return m;
}

/** Messages before "Clear chat" are hidden: bound on _id (index) and createdAt (exact). */
function clearedFilter(clearedAt) {
  if (!clearedAt) return {};
  return {
    _id: { $gte: ObjectId.createFromTime(Math.floor(clearedAt.getTime() / 1000)) },
    createdAt: { $gt: clearedAt },
  };
}

function mergeIdRange(filter, range) {
  filter._id = { ...(filter._id ?? {}), ...range };
  return filter;
}

/** Emits the viewer-specific DTO of a message to each given user. */
function emitMessage(event, msg, userIds) {
  for (const uid of userIds) emitToUser(uid, event, toMessageDTO(msg, uid));
}

const encodeCursor = (m) =>
  Buffer.from(JSON.stringify({ t: m.lastMessageAt.toISOString(), id: String(m._id) })).toString('base64url');

function decodeCursor(cursor) {
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    return { t: new Date(t), id: toObjectId(id) };
  } catch {
    throw ApiError.badRequest('Invalid cursor');
  }
}

// ===========================================================================
// Conversations
// ===========================================================================

async function buildSummaries(userId, members) {
  if (!members.length) return [];
  const peers = members.map((m) => m.peer);
  const [convs, users, online] = await Promise.all([
    Conversation.find({ _id: { $in: members.map((m) => m.conversation) } })
      .select('lastMessage lastMessageAt')
      .lean(),
    getPublicUsers(peers),
    onlineMap(peers),
  ]);
  const convMap = new Map(convs.map((c) => [String(c._id), c]));
  const now = Date.now();

  return Promise.all(
    members.map(async (m) => {
      const peerId = String(m.peer);
      const [blockedByMe, blockedMe] = await Promise.all([hasBlocked(userId, peerId), hasBlocked(peerId, userId)]);
      const peer = users.get(peerId) ?? { id: peerId, name: 'Deleted user' };
      const c = convMap.get(String(m.conversation));
      let last = c?.lastMessage?.id ? c.lastMessage : null;
      if (last && m.clearedAt && last.createdAt <= m.clearedAt) last = null;
      return {
        id: String(m.conversation),
        type: 'direct',
        peer: {
          ...peer,
          online: blockedMe ? false : (online.get(peerId) ?? false),
          lastSeenAt: blockedMe ? null : peer.lastSeenAt,
        },
        lastMessage: last && {
          id: String(last.id),
          senderId: String(last.sender),
          type: last.type,
          text: last.text,
          deleted: last.deleted,
          status: last.status,
          createdAt: last.createdAt,
        },
        lastMessageAt: m.lastMessageAt,
        unreadCount: m.unreadCount,
        pinned: m.pinned,
        archived: m.archived,
        muted: Boolean(m.mutedUntil && m.mutedUntil.getTime() > now),
        mutedUntil: m.mutedUntil,
        isBlocked: blockedByMe,
        blockedMe,
      };
    }),
  );
}

async function summaryFor(userId, conversationId) {
  const member = await ConversationMember.findOne({ conversation: conversationId, user: userId }).lean();
  if (!member) throw ApiError.notFound('Conversation not found');
  return (await buildSummaries(userId, [member]))[0];
}

export async function getOrCreateDirect(userId, peerId) {
  if (String(userId) === String(peerId)) throw ApiError.badRequest('You cannot chat with yourself');
  if (!(await getPublicUser(peerId))) throw ApiError.notFound('User not found');

  const pairKey = pairKeyOf(userId, peerId);
  let conv;
  try {
    conv = await Conversation.findOneAndUpdate(
      { pairKey },
      { $setOnInsert: { type: 'direct', participants: [toObjectId(userId), toObjectId(peerId)] } },
      { upsert: true, returnDocument: 'after', lean: true },
    );
  } catch (err) {
    if (err.code !== 11000) throw err; // lost an insert race -> read the winner
    conv = await Conversation.findOne({ pairKey }).lean();
  }

  try {
    await ConversationMember.bulkWrite(
      [
        [userId, peerId],
        [peerId, userId],
      ].map(([user, peer]) => ({
        updateOne: {
          filter: { conversation: conv._id, user: toObjectId(user) },
          update: { $setOnInsert: { peer: toObjectId(peer) } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  } catch (err) {
    if (err.code !== 11000 && !err.writeErrors?.every((e) => e.code === 11000)) throw err;
  }
  await cacheParticipants(conv._id, conv.participants);
  return summaryFor(userId, conv._id);
}

export async function listConversations(userId, { archived, cursor, limit }) {
  const base = { user: toObjectId(userId), hidden: false, archived };
  const query = { ...base, pinned: false, lastMessageAt: { $ne: null } };
  let pinned = [];

  if (cursor) {
    const { t, id } = decodeCursor(cursor);
    query.$or = [{ lastMessageAt: { $lt: t } }, { lastMessageAt: t, _id: { $lt: id } }];
  } else {
    pinned = await ConversationMember.find({ ...base, pinned: true }).sort({ pinnedAt: -1 }).limit(MAX_PINNED).lean();
  }

  const rows = await ConversationMember.find(query)
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: await buildSummaries(userId, [...pinned, ...page]),
    nextCursor: hasMore ? encodeCursor(page.at(-1)) : null,
  };
}

export const getConversation = async (userId, conversationId) => {
  await assertMember(conversationId, userId);
  return summaryFor(userId, conversationId);
};

export async function unreadTotal(userId) {
  const [row] = await ConversationMember.aggregate([
    { $match: { user: toObjectId(userId), hidden: false, unreadCount: { $gt: 0 } } },
    { $group: { _id: null, total: { $sum: '$unreadCount' }, chats: { $sum: 1 } } },
  ]);
  return { total: row?.total ?? 0, chats: row?.chats ?? 0 };
}

export async function updateSettings(userId, conversationId, { pinned, archived, muteSeconds }) {
  await assertMember(conversationId, userId);
  const set = {};
  if (pinned !== undefined) {
    if (pinned) {
      const count = await ConversationMember.countDocuments({ user: userId, pinned: true, hidden: false });
      if (count >= MAX_PINNED) throw ApiError.badRequest(`You can pin up to ${MAX_PINNED} chats`);
    }
    Object.assign(set, { pinned, pinnedAt: pinned ? new Date() : null });
  }
  if (archived !== undefined) {
    set.archived = archived;
    if (archived) Object.assign(set, { pinned: false, pinnedAt: null }); // archiving unpins
  }
  if (muteSeconds !== undefined) {
    set.mutedUntil = muteSeconds === 0 ? null : muteSeconds === -1 ? FOREVER : new Date(Date.now() + muteSeconds * 1000);
  }
  await ConversationMember.updateOne({ conversation: conversationId, user: userId }, { $set: set });
  const summary = await summaryFor(userId, conversationId);
  emitToUser(userId, 'conversation:updated', summary);
  return summary;
}

export async function clearChat(userId, conversationId, { hide = false } = {}) {
  await assertMember(conversationId, userId);
  const set = { clearedAt: new Date(), unreadCount: 0 };
  if (hide) Object.assign(set, { hidden: true, pinned: false, pinnedAt: null });
  await ConversationMember.updateOne({ conversation: conversationId, user: userId }, { $set: set });
  if (hide) {
    emitToUser(userId, 'conversation:removed', { conversationId: String(conversationId) });
    return null;
  }
  const summary = await summaryFor(userId, conversationId);
  emitToUser(userId, 'conversation:cleared', { conversationId: String(conversationId) });
  emitToUser(userId, 'conversation:updated', summary);
  return summary;
}

// ===========================================================================
// Messages: send
// ===========================================================================

export async function sendMessage(senderId, input, { forwardedFrom } = {}) {
  let { conversationId } = input;
  let peerId;
  if (conversationId) {
    ({ peerId } = await assertMember(conversationId, senderId));
  } else {
    conversationId = (await getOrCreateDirect(senderId, input.toUserId)).id;
    peerId = String(input.toUserId);
  }
  if (await isBlockedBetween(senderId, peerId)) {
    throw ApiError.forbidden('You cannot send messages to this user', 'BLOCKED');
  }

  let replyTo;
  if (input.replyToId) {
    const r = await Message.findOne({ _id: input.replyToId, conversation: conversationId }).lean();
    if (!r || r.deletedForEveryone) throw ApiError.badRequest('Replied message not found');
    replyTo = { id: r._id, sender: r.sender, type: r.type, text: previewText(r) };
  }

  const doc = {
    conversation: conversationId,
    sender: senderId,
    recipient: peerId,
    clientMsgId: input.clientMsgId,
    type: input.type,
    text: input.text?.trim() ?? '',
    media: input.media,
    location: input.location,
    contact: input.contact,
    replyTo,
    forwarded: Boolean(forwardedFrom),
    forwardCount: forwardedFrom ? forwardedFrom.forwardCount + 1 : 0,
  };

  let msg;
  try {
    msg = (await Message.create(doc)).toObject();
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Retry of an already stored message (flaky network): return it, no re-broadcast.
    const existing = await Message.findOne({ sender: senderId, clientMsgId: input.clientMsgId }).lean();
    return { message: toMessageDTO(existing, senderId), duplicate: true };
  }

  const at = msg.createdAt;
  await Promise.all([
    Conversation.updateOne(
      { _id: conversationId, $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: at } }] },
      {
        $set: {
          lastMessage: { id: msg._id, sender: msg.sender, type: msg.type, text: previewText(msg), deleted: false, status: 'sent', createdAt: at },
          lastMessageAt: at,
        },
      },
    ),
    ConversationMember.updateOne(
      { conversation: conversationId, user: senderId },
      { $max: { lastMessageAt: at }, $set: { hidden: false } },
    ),
    ConversationMember.updateOne(
      { conversation: conversationId, user: peerId },
      { $max: { lastMessageAt: at }, $set: { hidden: false }, $inc: { unreadCount: 1 } },
    ),
  ]);

  emitMessage('message:new', msg, [senderId, peerId]);
  notifyIfOffline(senderId, peerId, conversationId, msg).catch(() => {});
  return { message: toMessageDTO(msg, senderId), duplicate: false };
}

async function notifyIfOffline(senderId, peerId, conversationId, msg) {
  if (await isOnline(peerId)) return;
  const member = await ConversationMember.findOne({ conversation: conversationId, user: peerId })
    .select('mutedUntil')
    .lean();
  if (member?.mutedUntil && member.mutedUntil > new Date()) return;
  const sender = await getPublicUser(senderId);
  await enqueuePush({
    recipientId: String(peerId),
    conversationId: String(conversationId),
    senderName: sender?.name ?? 'New message',
    preview: previewText(msg),
  });
}

// ===========================================================================
// Receipts: delivered / read
// ===========================================================================

export async function markDelivered(userId, { conversationId, upToMessageId }) {
  const { peerId } = await assertMember(conversationId, userId);
  const at = new Date();
  const upTo = toObjectId(upToMessageId);
  const r = await Message.updateMany(
    { conversation: conversationId, recipient: userId, deliveredAt: null, _id: { $lte: upTo } },
    { $set: { deliveredAt: at } },
  );
  if (!r.modifiedCount) return { updated: 0 };
  await Conversation.updateOne(
    { _id: conversationId, 'lastMessage.sender': toObjectId(peerId), 'lastMessage.id': { $lte: upTo }, 'lastMessage.status': 'sent' },
    { $set: { 'lastMessage.status': 'delivered' } },
  );
  emitToUser(peerId, 'message:status', { conversationId: String(conversationId), upToMessageId: String(upTo), status: 'delivered', at });
  return { updated: r.modifiedCount };
}

/** On connect: everything that arrived while the user was offline is now delivered. */
export async function markAllDelivered(userId) {
  const groups = await Message.aggregate([
    { $match: { recipient: toObjectId(userId), deliveredAt: null } },
    { $group: { _id: '$conversation', maxId: { $max: '$_id' } } },
    { $limit: 1000 },
  ]);
  await Promise.all(
    groups.map((g) => markDelivered(userId, { conversationId: String(g._id), upToMessageId: String(g.maxId) })),
  );
  return groups.length;
}

export async function markRead(userId, { conversationId, upToMessageId }) {
  const { peerId } = await assertMember(conversationId, userId);
  const at = new Date();
  const upTo = toObjectId(upToMessageId);
  const base = { conversation: conversationId, recipient: userId, _id: { $lte: upTo } };

  const [reader, delivered] = await Promise.all([
    User.findById(userId).select('privacy.readReceipts').lean(),
    Message.updateMany({ ...base, deliveredAt: null }, { $set: { deliveredAt: at } }),
  ]);
  const receipts = reader?.privacy?.readReceipts !== false;
  // Read receipts disabled -> read state is kept only on the member, never exposed to the sender.
  const r = receipts ? await Message.updateMany({ ...base, readAt: null }, { $set: { readAt: at } }) : { modifiedCount: 0 };

  const member = await ConversationMember.findOneAndUpdate(
    { conversation: conversationId, user: userId },
    { $max: { lastReadMessageId: upTo } },
    { returnDocument: 'after', lean: true },
  );
  const unreadCount = await Message.countDocuments({
    conversation: conversationId,
    recipient: userId,
    _id: { $gt: member.lastReadMessageId },
    deletedFor: { $ne: toObjectId(userId) },
  });
  await ConversationMember.updateOne({ _id: member._id }, { $set: { unreadCount } });
  emitToUser(userId, 'conversation:read', { conversationId: String(conversationId), unreadCount });

  if (r.modifiedCount) {
    await Conversation.updateOne(
      { _id: conversationId, 'lastMessage.sender': toObjectId(peerId), 'lastMessage.id': { $lte: upTo } },
      { $set: { 'lastMessage.status': 'read' } },
    );
    emitToUser(peerId, 'message:status', { conversationId: String(conversationId), upToMessageId: String(upTo), status: 'read', at });
  } else if (delivered.modifiedCount) {
    await Conversation.updateOne(
      { _id: conversationId, 'lastMessage.sender': toObjectId(peerId), 'lastMessage.id': { $lte: upTo }, 'lastMessage.status': 'sent' },
      { $set: { 'lastMessage.status': 'delivered' } },
    );
    emitToUser(peerId, 'message:status', { conversationId: String(conversationId), upToMessageId: String(upTo), status: 'delivered', at });
  }
  return { unreadCount };
}

// ===========================================================================
// Messages: history, search, media, starred, info
// ===========================================================================

async function memberState(conversationId, userId) {
  const member = await ConversationMember.findOne({ conversation: conversationId, user: userId })
    .select('clearedAt')
    .lean();
  if (!member) throw ApiError.notFound('Conversation not found');
  return member;
}

export async function getMessages(userId, conversationId, { before, after, limit }) {
  await assertMember(conversationId, userId);
  const { clearedAt } = await memberState(conversationId, userId);
  const filter = { conversation: toObjectId(conversationId), deletedFor: { $ne: toObjectId(userId) }, ...clearedFilter(clearedAt) };
  if (before) mergeIdRange(filter, { $lt: toObjectId(before) });
  else if (after) mergeIdRange(filter, { $gt: toObjectId(after) });

  const rows = await Message.find(filter)
    .sort({ _id: after ? 1 : -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!after) page.reverse(); // always oldest -> newest
  return { items: page.map((m) => toMessageDTO(m, userId)), hasMore };
}

export async function searchMessages(userId, conversationId, { q, limit }) {
  await assertMember(conversationId, userId);
  const { clearedAt } = await memberState(conversationId, userId);
  const base = {
    conversation: toObjectId(conversationId),
    deletedFor: { $ne: toObjectId(userId) },
    deletedForEveryone: false,
    ...clearedFilter(clearedAt),
  };
  // Full-text index first (whole words), then a bounded substring scan as fallback.
  let rows = await Message.find({ ...base, $text: { $search: q } })
    .sort({ _id: -1 })
    .limit(limit)
    .lean();
  if (!rows.length) {
    rows = await Message.find({ ...base, text: { $regex: escapeRegex(q), $options: 'i' } })
      .sort({ _id: -1 })
      .limit(limit)
      .maxTimeMS(3_000)
      .lean();
  }
  return rows.map((m) => toMessageDTO(m, userId));
}

const MEDIA_KINDS = {
  media: { type: { $in: ['image', 'video'] } },
  docs: { type: 'file' },
  audio: { type: { $in: ['audio', 'voice'] } },
  links: { type: 'text', text: { $regex: 'https?://', $options: 'i' } },
};

export async function listMedia(userId, conversationId, { kind, before, limit }) {
  await assertMember(conversationId, userId);
  const { clearedAt } = await memberState(conversationId, userId);
  const filter = {
    conversation: toObjectId(conversationId),
    deletedFor: { $ne: toObjectId(userId) },
    deletedForEveryone: false,
    ...clearedFilter(clearedAt),
    ...MEDIA_KINDS[kind],
  };
  if (before) mergeIdRange(filter, { $lt: toObjectId(before) });
  const rows = await Message.find(filter).sort({ _id: -1 }).limit(limit).lean();
  return rows.map((m) => toMessageDTO(m, userId));
}

export async function listStarred(userId, { before, limit }) {
  const filter = { starredBy: toObjectId(userId), deletedFor: { $ne: toObjectId(userId) }, deletedForEveryone: false };
  if (before) filter._id = { $lt: toObjectId(before) };
  const rows = await Message.find(filter).sort({ _id: -1 }).limit(limit).lean();
  const users = await getPublicUsers(rows.flatMap((m) => [m.sender, m.recipient]));
  return rows.map((m) => ({
    ...toMessageDTO(m, userId),
    sender: users.get(String(m.sender)) ?? null,
    peer: users.get(String(String(m.sender) === String(userId) ? m.recipient : m.sender)) ?? null,
  }));
}

export async function getMessageInfo(userId, messageId) {
  const m = await loadMessageForUser(messageId, userId);
  if (String(m.sender) !== String(userId)) throw ApiError.forbidden('Only the sender can view message info');
  return { id: String(m._id), sentAt: m.createdAt, deliveredAt: m.deliveredAt, readAt: m.readAt, editedAt: m.editedAt };
}

// ===========================================================================
// Messages: edit, delete, react, star, forward
// ===========================================================================

export async function editMessage(userId, { messageId, text }) {
  const m = await loadMessageForUser(messageId, userId);
  if (String(m.sender) !== String(userId)) throw ApiError.forbidden('You can only edit your own messages');
  if (m.deletedForEveryone) throw ApiError.badRequest('Message was deleted');
  if (!['text', 'image', 'video'].includes(m.type)) throw ApiError.badRequest('This message cannot be edited');
  if (Date.now() - m.createdAt.getTime() > EDIT_WINDOW_MS) {
    throw ApiError.forbidden(`Messages can be edited for ${env.MESSAGE_EDIT_WINDOW_MIN} minutes`, 'EDIT_WINDOW_EXPIRED');
  }
  const updated = await Message.findByIdAndUpdate(
    messageId,
    { $set: { text, editedAt: new Date() } },
    { returnDocument: 'after', lean: true },
  );
  await Conversation.updateOne(
    { _id: m.conversation, 'lastMessage.id': m._id },
    { $set: { 'lastMessage.text': previewText(updated) } },
  );
  emitMessage('message:updated', updated, [m.sender, m.recipient]);
  return toMessageDTO(updated, userId);
}

export async function deleteMessage(userId, { messageId, scope }) {
  const m = await loadMessageForUser(messageId, userId);

  if (scope === 'me') {
    await Message.updateOne({ _id: m._id }, { $addToSet: { deletedFor: toObjectId(userId) } });
    if (String(m.recipient) === String(userId) && !m.readAt) {
      await ConversationMember.updateOne(
        { conversation: m.conversation, user: userId, unreadCount: { $gt: 0 } },
        { $inc: { unreadCount: -1 } },
      );
    }
    emitToUser(userId, 'message:removed', { conversationId: String(m.conversation), messageId: String(m._id) });
    return { messageId: String(m._id), scope };
  }

  if (String(m.sender) !== String(userId)) throw ApiError.forbidden('You can only delete your own messages for everyone');
  if (m.deletedForEveryone) return { messageId: String(m._id), scope };
  if (Date.now() - m.createdAt.getTime() > DELETE_WINDOW_MS) {
    throw ApiError.forbidden('Too late to delete this message for everyone', 'DELETE_WINDOW_EXPIRED');
  }
  const updated = await Message.findByIdAndUpdate(
    m._id,
    {
      $set: { deletedForEveryone: true, text: '', reactions: [] },
      $unset: { media: 1, location: 1, contact: 1, replyTo: 1 },
    },
    { returnDocument: 'after', lean: true },
  );
  await Conversation.updateOne(
    { _id: m.conversation, 'lastMessage.id': m._id },
    { $set: { 'lastMessage.deleted': true, 'lastMessage.text': previewText(updated) } },
  );
  emitMessage('message:updated', updated, [m.sender, m.recipient]);
  return { messageId: String(m._id), scope };
}

export async function reactToMessage(userId, { messageId, emoji }) {
  const m = await loadMessageForUser(messageId, userId);
  if (m.deletedForEveryone) throw ApiError.badRequest('Message was deleted');
  const peerId = String(m.sender) === String(userId) ? m.recipient : m.sender;
  if (await isBlockedBetween(userId, peerId)) throw ApiError.forbidden('You cannot react in this chat', 'BLOCKED');

  const uid = toObjectId(userId);
  await Message.updateOne({ _id: m._id }, { $pull: { reactions: { user: uid } } });
  const updated = emoji
    ? await Message.findByIdAndUpdate(
        m._id,
        { $push: { reactions: { user: uid, emoji, at: new Date() } } },
        { returnDocument: 'after', lean: true },
      )
    : await Message.findById(m._id).lean();
  emitMessage('message:updated', updated, [m.sender, m.recipient]);
  return toMessageDTO(updated, userId);
}

export async function starMessage(userId, { messageId, starred }) {
  const m = await loadMessageForUser(messageId, userId);
  const uid = toObjectId(userId);
  const updated = await Message.findByIdAndUpdate(
    m._id,
    starred ? { $addToSet: { starredBy: uid } } : { $pull: { starredBy: uid } },
    { returnDocument: 'after', lean: true },
  );
  emitMessage('message:updated', updated, [userId]); // starring is private
  return toMessageDTO(updated, userId);
}

export async function forwardMessage(userId, { messageId, toUserIds, clientMsgId }) {
  const src = await loadMessageForUser(messageId, userId);
  if (src.deletedForEveryone) throw ApiError.badRequest('Message was deleted');
  const targets = [...new Set(toUserIds.map(String))];
  const results = [];
  for (const [i, toUserId] of targets.entries()) {
    const { message } = await sendMessage(
      userId,
      {
        toUserId,
        clientMsgId: `${clientMsgId}:${i}`,
        type: src.type,
        text: src.text,
        media: src.media,
        location: src.location,
        contact: src.contact,
      },
      { forwardedFrom: src },
    );
    results.push(message);
  }
  return results;
}
