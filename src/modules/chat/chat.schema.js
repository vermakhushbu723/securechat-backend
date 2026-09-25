import { z } from 'zod';

import { objectId } from '../../utils/validators.js';
import { MESSAGE_TYPES } from './message.model.js';

// Only files uploaded through /media/upload may be referenced (relative path).
export const uploadPath = z
  .string()
  .max(300)
  .regex(/^\/uploads\/[A-Za-z0-9/_.-]+$/, 'Media must be uploaded first')
  .refine((p) => !p.includes('..'), 'Invalid path');

export const mediaInput = z.strictObject({
  kind: z.string().max(20).optional(), // echoed from /media/upload, not stored
  url: uploadPath,
  thumbUrl: uploadPath.nullish(),
  mimeType: z.string().max(120),
  name: z.string().max(255).optional(),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  duration: z.number().nonnegative().max(86_400).nullish(),
});

export const sendMessageInput = z
  .strictObject({
    conversationId: objectId.optional(),
    toUserId: objectId.optional(),
    clientMsgId: z.string().min(8).max(64),
    type: z.enum(MESSAGE_TYPES),
    text: z.string().max(10_000).default(''),
    media: mediaInput.optional(),
    location: z
      .strictObject({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        name: z.string().max(200).optional(),
        address: z.string().max(500).optional(),
        live: z.boolean().optional(),
      })
      .optional(),
    contact: z
      .strictObject({
        name: z.string().trim().min(1).max(100),
        phone: z.string().trim().min(3).max(30),
        userId: objectId.optional(),
      })
      .optional(),
    replyToId: objectId.optional(),
  })
  .refine((m) => m.conversationId || m.toUserId, { message: 'conversationId or toUserId is required' })
  .superRefine((m, ctx) => {
    const need = (cond, message) => !cond && ctx.addIssue({ code: 'custom', message });
    switch (m.type) {
      case 'text':
        need(m.text.trim().length > 0, 'Text message cannot be empty');
        break;
      case 'location':
        need(m.location, 'location is required');
        break;
      case 'contact':
        need(m.contact, 'contact is required');
        break;
      default:
        need(m.media, 'media is required');
    }
  });

export const idParam = z.object({ id: objectId });

export const listConversationsQuery = z.object({
  archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const messagesQuery = z.object({
  before: objectId.optional(),
  after: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const conversationSettings = z
  .strictObject({
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    // seconds to mute, -1 = forever, 0 = unmute
    muteSeconds: z.number().int().min(-1).max(31_536_000).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const readInput = z.strictObject({ conversationId: objectId, upToMessageId: objectId });
export const deliveredInput = readInput;

export const editInput = z.strictObject({ messageId: objectId, text: z.string().trim().min(1).max(10_000) });
export const deleteInput = z.strictObject({ messageId: objectId, scope: z.enum(['me', 'everyone']) });
export const reactInput = z.strictObject({
  messageId: objectId,
  emoji: z.string().min(1).max(16).nullable(), // null removes the reaction
});
export const starInput = z.strictObject({ messageId: objectId, starred: z.boolean() });
export const forwardInput = z.strictObject({
  messageId: objectId,
  toUserIds: z.array(objectId).min(1).max(5),
  clientMsgId: z.string().min(8).max(48),
});

export const typingInput = z.strictObject({
  conversationId: objectId,
  isTyping: z.boolean(),
  kind: z.enum(['text', 'recording']).default('text'),
});

export const presenceInput = z.strictObject({ userIds: z.array(objectId).min(1).max(200) });

export const searchQuery = z.object({ q: z.string().trim().min(1).max(100), limit: z.coerce.number().int().min(1).max(100).default(50) });

export const mediaQuery = z.object({
  kind: z.enum(['media', 'docs', 'audio', 'links']).default('media'),
  before: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
