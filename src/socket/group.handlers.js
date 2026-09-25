import { limiters } from '../middlewares/rateLimit.js';
import { emitFromSender, groupRoom, requireGroupAccess, sendBlockReason } from '../modules/groups/group.access.js';
import { GroupMember } from '../modules/groups/group.model.js';
import * as s from '../modules/groups/group.schema.js';
import * as msgs from '../modules/groups/groupMessage.service.js';
import { getPublicUser } from '../services/cache.service.js';
import { handler } from './handler.js';

/**
 * Group chat realtime events (all with ack `{ ok, data | error }`):
 *   group:message:send | edit | delete | react | star | forward
 *   group:read, group:delivered, group:typing
 *
 * Server -> client:
 *   group:message:new | updated | removed, group:status (ticks), group:typing,
 *   group:read, group:updated, group:me, group:cleared, group:joined, group:removed,
 *   group:member:joined | left | updated, group:join_request, group:request:declined, group:location
 */
export function registerGroupHandlers(io, socket) {
  const uid = socket.data.userId;
  const on = (event, opts) => socket.on(event, handler(socket, opts));

  on('group:message:send', {
    schema: s.sendGroupMessageInput,
    limiter: limiters.message,
    fn: async (input) => (await msgs.sendGroupMessage(uid, input)).message,
  });
  on('group:message:edit', { schema: s.editInput, limiter: limiters.action, fn: (i) => msgs.editGroupMessage(uid, i) });
  on('group:message:delete', { schema: s.deleteInput, limiter: limiters.action, fn: (i) => msgs.deleteGroupMessage(uid, i) });
  on('group:message:react', { schema: s.reactInput, limiter: limiters.action, fn: (i) => msgs.reactGroupMessage(uid, i) });
  on('group:message:star', { schema: s.starInput, limiter: limiters.action, fn: (i) => msgs.starGroupMessage(uid, i) });
  on('group:message:forward', { schema: s.forwardInput, limiter: limiters.message, fn: (i) => msgs.forwardGroupMessages(uid, i) });
  on('group:read', { schema: s.readInput, limiter: limiters.action, fn: (i) => msgs.markGroupRead(uid, i) });
  on('group:delivered', { schema: s.readInput, limiter: limiters.action, fn: (i) => msgs.markGroupDelivered(uid, i) });

  // Typing / recording: only members who may send, never to members who blocked them.
  on('group:typing', {
    schema: s.typingInput,
    limiter: limiters.typing,
    fn: async ({ groupId, isTyping, kind }) => {
      const { group, member } = await requireGroupAccess(groupId, uid);
      if (sendBlockReason(group, member, 'text')) return null;
      const displayName = (await getPublicUser(uid))?.displayName ?? 'Member';
      await emitFromSender(groupId, uid, 'group:typing', { groupId, userId: uid, displayName, isTyping, kind }, { exceptSender: true });
      return null;
    },
  });
}

/** Joins every active group room of the user (called on connect). */
export async function joinUserGroupRooms(socket) {
  const rows = await GroupMember.find({ user: socket.data.userId, status: 'active' }).select('group').limit(1000).lean();
  if (rows.length) socket.join(rows.map((r) => groupRoom(String(r.group))));
  return rows.length;
}
