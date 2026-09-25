import { limiters } from '../middlewares/rateLimit.js';
import * as chat from '../modules/chat/chat.service.js';
import * as s from '../modules/chat/chat.schema.js';
import { getParticipants, hasBlocked, isBlockedBetween } from '../services/cache.service.js';
import { ApiError } from '../utils/ApiError.js';
import { presenceRoom } from './emitter.js';
import { handler } from './handler.js';

/**
 * Client -> server events. Every event supports an ack callback:
 *   socket.emit('message:send', payload, (res) => res.ok ? res.data : res.error)
 *
 * Server -> client events:
 *   message:new, message:updated, message:removed, message:status,
 *   typing, presence, conversation:updated, conversation:read,
 *   conversation:cleared, conversation:removed, user:updated, user:blocked
 */
export function registerChatHandlers(io, socket) {
  const uid = socket.data.userId;
  const on = (event, opts) => socket.on(event, handler(socket, opts));

  on('message:send', {
    schema: s.sendMessageInput,
    limiter: limiters.message,
    fn: async (input) => (await chat.sendMessage(uid, input)).message,
  });

  on('message:edit', { schema: s.editInput, limiter: limiters.action, fn: (i) => chat.editMessage(uid, i) });
  on('message:delete', { schema: s.deleteInput, limiter: limiters.action, fn: (i) => chat.deleteMessage(uid, i) });
  on('message:react', { schema: s.reactInput, limiter: limiters.action, fn: (i) => chat.reactToMessage(uid, i) });
  on('message:star', { schema: s.starInput, limiter: limiters.action, fn: (i) => chat.starMessage(uid, i) });
  on('message:forward', { schema: s.forwardInput, limiter: limiters.message, fn: (i) => chat.forwardMessage(uid, i) });

  on('message:delivered', { schema: s.deliveredInput, limiter: limiters.action, fn: (i) => chat.markDelivered(uid, i) });
  on('conversation:read', { schema: s.readInput, limiter: limiters.action, fn: (i) => chat.markRead(uid, i) });

  // Typing / recording indicator: ephemeral, never stored.
  on('typing', {
    schema: s.typingInput,
    limiter: limiters.typing,
    fn: async ({ conversationId, isTyping, kind }) => {
      const participants = await getParticipants(conversationId);
      if (!participants?.includes(uid)) throw ApiError.notFound('Conversation not found');
      const peerId = participants.find((p) => p !== uid);
      if (await isBlockedBetween(uid, peerId)) return null;
      socket.to(`user:${peerId}`).emit('typing', { conversationId, userId: uid, isTyping, kind });
      return null;
    },
  });

  // Presence is subscription based: a client only listens to users it shows.
  on('presence:subscribe', {
    schema: s.presenceInput,
    limiter: limiters.action,
    fn: async ({ userIds }) => {
      const allowed = [];
      for (const id of userIds) if (!(await hasBlocked(id, uid))) allowed.push(id);
      socket.join(allowed.map(presenceRoom));
      return { subscribed: allowed };
    },
  });

  on('presence:unsubscribe', {
    schema: s.presenceInput,
    fn: async ({ userIds }) => {
      for (const id of userIds) socket.leave(presenceRoom(id));
      return null;
    },
  });
}
