import { Router } from 'express';
import { z } from 'zod';

import { limiters, rateLimit } from '../../middlewares/rateLimit.js';
import { validate } from '../../middlewares/validate.js';
import { objectId } from '../../utils/validators.js';
import * as chat from './chat.service.js';
import * as s from './chat.schema.js';

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

// ---------------------------------------------------------------------------
// /conversations
// ---------------------------------------------------------------------------
export const conversationRouter = Router();

conversationRouter.post('/', validate({ body: z.strictObject({ userId: objectId }) }), async (req, res) => {
  ok(res, await chat.getOrCreateDirect(req.user.id, req.valid.body.userId), 201);
});

conversationRouter.get('/', validate({ query: s.listConversationsQuery }), async (req, res) => {
  ok(res, await chat.listConversations(req.user.id, req.valid.query));
});

conversationRouter.get('/unread', async (req, res) => {
  ok(res, await chat.unreadTotal(req.user.id));
});

conversationRouter.get('/:id', validate({ params: s.idParam }), async (req, res) => {
  ok(res, await chat.getConversation(req.user.id, req.valid.params.id));
});

conversationRouter.patch('/:id', validate({ params: s.idParam, body: s.conversationSettings }), async (req, res) => {
  ok(res, await chat.updateSettings(req.user.id, req.valid.params.id, req.valid.body));
});

conversationRouter.post('/:id/clear', validate({ params: s.idParam }), async (req, res) => {
  ok(res, await chat.clearChat(req.user.id, req.valid.params.id));
});

conversationRouter.delete('/:id', validate({ params: s.idParam }), async (req, res) => {
  ok(res, await chat.clearChat(req.user.id, req.valid.params.id, { hide: true }));
});

conversationRouter.get('/:id/messages', validate({ params: s.idParam, query: s.messagesQuery }), async (req, res) => {
  ok(res, await chat.getMessages(req.user.id, req.valid.params.id, req.valid.query));
});

// REST fallback for sending (clients normally use the socket event `message:send`).
conversationRouter.post(
  '/:id/messages',
  rateLimit(limiters.message),
  validate({ params: s.idParam }),
  async (req, res) => {
    const input = s.sendMessageInput.parse({ ...req.body, conversationId: req.valid.params.id });
    const { message, duplicate } = await chat.sendMessage(req.user.id, input);
    ok(res, message, duplicate ? 200 : 201);
  },
);

conversationRouter.post(
  '/:id/read',
  validate({ params: s.idParam, body: z.strictObject({ upToMessageId: objectId }) }),
  async (req, res) => {
    ok(res, await chat.markRead(req.user.id, { conversationId: req.valid.params.id, ...req.valid.body }));
  },
);

conversationRouter.get('/:id/search', validate({ params: s.idParam, query: s.searchQuery }), async (req, res) => {
  ok(res, await chat.searchMessages(req.user.id, req.valid.params.id, req.valid.query));
});

conversationRouter.get('/:id/media', validate({ params: s.idParam, query: s.mediaQuery }), async (req, res) => {
  ok(res, await chat.listMedia(req.user.id, req.valid.params.id, req.valid.query));
});

// ---------------------------------------------------------------------------
// /messages
// ---------------------------------------------------------------------------
export const messageRouter = Router();

messageRouter.get(
  '/starred',
  validate({ query: z.object({ before: objectId.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) }),
  async (req, res) => {
    ok(res, await chat.listStarred(req.user.id, req.valid.query));
  },
);

messageRouter.get('/:id/info', validate({ params: s.idParam }), async (req, res) => {
  ok(res, await chat.getMessageInfo(req.user.id, req.valid.params.id));
});

messageRouter.patch(
  '/:id',
  validate({ params: s.idParam, body: z.strictObject({ text: z.string().trim().min(1).max(10_000) }) }),
  async (req, res) => {
    ok(res, await chat.editMessage(req.user.id, { messageId: req.valid.params.id, text: req.valid.body.text }));
  },
);

messageRouter.delete(
  '/:id',
  validate({ params: s.idParam, query: z.object({ scope: z.enum(['me', 'everyone']).default('me') }) }),
  async (req, res) => {
    ok(res, await chat.deleteMessage(req.user.id, { messageId: req.valid.params.id, scope: req.valid.query.scope }));
  },
);

messageRouter.post(
  '/:id/reactions',
  validate({ params: s.idParam, body: z.strictObject({ emoji: z.string().min(1).max(16).nullable() }) }),
  async (req, res) => {
    ok(res, await chat.reactToMessage(req.user.id, { messageId: req.valid.params.id, emoji: req.valid.body.emoji }));
  },
);

messageRouter.post(
  '/:id/star',
  validate({ params: s.idParam, body: z.strictObject({ starred: z.boolean() }) }),
  async (req, res) => {
    ok(res, await chat.starMessage(req.user.id, { messageId: req.valid.params.id, starred: req.valid.body.starred }));
  },
);

messageRouter.post(
  '/:id/forward',
  rateLimit(limiters.message),
  validate({
    params: s.idParam,
    body: z.strictObject({ toUserIds: z.array(objectId).min(1).max(5), clientMsgId: z.string().min(8).max(48) }),
  }),
  async (req, res) => {
    ok(res, await chat.forwardMessage(req.user.id, { messageId: req.valid.params.id, ...req.valid.body }), 201);
  },
);
