import { z } from 'zod';

import { objectId } from '../../utils/validators.js';
import { mediaInput } from '../chat/chat.schema.js';
import { CONTENT_RULES } from '../platform/platform.service.js';

const trimmed = (max) => z.string().trim().max(max);

// ---------------------------------------------------------------------------
// Settings (all sections optional -> partial updates)
// ---------------------------------------------------------------------------
export const settingsInput = z.strictObject({
  location: z
    .strictObject({
      requirement: z.enum(['off', 'optional', 'mandatory']).optional(),
      shareMode: z.enum(['join', 'live']).optional(),
      liveIntervalMin: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(30)]).optional(),
      visibility: z.enum(['adminOnly', 'groupMembers', 'nobody']).optional(),
    })
    .optional(),
  messages: z
    .strictObject({
      whoCanSend: z.enum(['all', 'admins']).optional(),
      messageMode: z.enum(['public', 'private', 'user_select']).optional(),
      membersCanEditInfo: z.boolean().optional(),
      membersCanSendMedia: z.boolean().optional(),
    })
    .optional(),
  contentRules: z.array(z.enum(CONTENT_RULES)).max(CONTENT_RULES.length).optional(),
  members: z
    .strictObject({
      approveNewMembers: z.boolean().optional(),
      restrictNewMembers: z.boolean().optional(),
      muteGroup: z.boolean().optional(),
    })
    .optional(),
  security: z
    .strictObject({
      publicForwarding: z.boolean().optional(),
      privateForwarding: z.boolean().optional(),
      trackForwardChain: z.boolean().optional(),
      openInAppOnly: z.boolean().optional(),
      downloadDisabled: z.boolean().optional(),
      externalShareDisabled: z.boolean().optional(),
      copyDisabledProtected: z.boolean().optional(),
      screenshotProtection: z.boolean().optional(),
      screenRecordingProtection: z.boolean().optional(),
      dynamicWatermark: z.boolean().optional(),
      chainDeletion: z.boolean().optional(),
      deleteForEveryoneUnlimited: z.boolean().optional(),
    })
    .optional(),
});

const avatarPath = z.union([
  z.string().url().max(500),
  z
    .string()
    .max(300)
    .regex(/^\/uploads\/[A-Za-z0-9/_.-]+$/)
    .refine((p) => !p.includes('..')),
]);

export const inviteOptions = z.strictObject({
  expiry: z.enum(['1h', '24h', '7d', '30d', 'never']).default('24h'),
  maxJoins: z.number().int().min(0).max(100_000).default(100), // 0 = unlimited
  requireApproval: z.boolean().default(false),
});

export const createGroupInput = z.strictObject({
  name: trimmed(50).min(1, 'Group name is required'),
  description: trimmed(300).default(''),
  category: trimmed(40).default('Other'),
  rules: trimmed(500).default(''),
  avatarUrl: avatarPath.nullable().optional(),
  settings: settingsInput.optional(),
  invite: inviteOptions.optional(),
});

export const updateInfoInput = z
  .strictObject({
    name: trimmed(50).min(1).optional(),
    description: trimmed(300).optional(),
    category: trimmed(40).optional(),
    rules: trimmed(500).optional(),
    avatarUrl: avatarPath.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const listGroupsQuery = z.object({
  filter: z.enum(['all', 'created', 'joined', 'location', 'muted', 'archived']).default('all'),
  q: z.string().trim().max(50).optional(),
});

export const memberUpdateInput = z
  .strictObject({ role: z.enum(['admin', 'member']).optional(), restricted: z.boolean().optional() })
  .refine((b) => b.role !== undefined || b.restricted !== undefined, { message: 'Nothing to update' });

export const myStateInput = z
  .strictObject({
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    muteSeconds: z.number().int().min(-1).max(31_536_000).optional(), // -1 forever, 0 unmute
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const locationInput = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  place: trimmed(200).optional(),
  accuracy: z.number().nonnegative().max(100_000).optional(),
});

export const joinInput = z.strictObject({
  location: locationInput.optional(),
  shareMode: z.enum(['join', 'live']).optional(),
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
const groupMediaInput = mediaInput.extend({
  url: mediaInput.shape.url.nullish(),
  secure: z.boolean().optional(),
  secureFileId: objectId.optional(),
});

export const sendGroupMessageInput = z
  .strictObject({
    groupId: objectId,
    clientMsgId: z.string().min(8).max(64),
    type: z.enum(['text', 'image', 'video', 'audio', 'voice', 'file', 'location', 'contact']),
    text: z.string().max(4096).default(''),
    media: groupMediaInput.optional(),
    location: z
      .strictObject({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        name: trimmed(200).optional(),
        address: trimmed(500).optional(),
        live: z.boolean().optional(),
      })
      .optional(),
    contact: z.strictObject({ name: trimmed(100).min(1), phone: trimmed(30).min(3) }).optional(),
    visibility: z.enum(['public', 'private', 'highly_protected']).optional(),
    // Privacy Permission screen: expiry + level 1 toggles.
    expiry: z.enum(['view_once', '1h', '24h', '7d', 'never']).default('never'),
    allowDownload: z.boolean().optional(),
    allowScreenshot: z.boolean().optional(),
    silent: z.boolean().default(false),
    replyToId: objectId.optional(),
  })
  .superRefine((m, ctx) => {
    const need = (cond, message) => !cond && ctx.addIssue({ code: 'custom', message });
    if (m.type === 'text') need(m.text.trim().length > 0, 'Text message cannot be empty');
    else if (m.type === 'location') need(m.location, 'location is required');
    else if (m.type === 'contact') need(m.contact, 'contact is required');
    else need(m.media && (m.media.url || m.media.secureFileId), 'media is required');
  });

export const messagesQuery = z.object({
  before: objectId.optional(),
  after: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

export const searchQuery = z.object({
  q: z.string().trim().max(100).default(''),
  filter: z.enum(['all', 'text', 'photos', 'docs', 'voice', 'protected']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const mediaQuery = z.object({
  kind: z.enum(['media', 'docs', 'protected', 'audio', 'links']).default('media'),
  before: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(60),
});

export const readInput = z.strictObject({ groupId: objectId, upToMessageId: objectId });

export const editInput = z.strictObject({ messageId: objectId, text: z.string().trim().min(1).max(4096) });
export const deleteInput = z.strictObject({
  messageId: objectId,
  scope: z.enum(['me', 'everyone']),
  chain: z.boolean().default(true),
});
export const reactInput = z.strictObject({ messageId: objectId, emoji: z.string().min(1).max(16).nullable() });
export const starInput = z.strictObject({ messageId: objectId, starred: z.boolean() });
export const forwardInput = z.strictObject({
  messageIds: z.array(objectId).min(1).max(20),
  toGroupIds: z.array(objectId).min(1).max(10),
  clientMsgId: z.string().min(8).max(40),
});
export const typingInput = z.strictObject({
  groupId: objectId,
  isTyping: z.boolean(),
  kind: z.enum(['text', 'recording']).default('text'),
});

export const reportInput = z
  .strictObject({
    type: z.enum(['message', 'user', 'group']),
    messageId: objectId.optional(),
    userId: objectId.optional(),
    groupId: objectId.optional(),
    reasons: z.array(trimmed(100).min(1)).min(1).max(10),
    details: trimmed(1000).default(''),
    alsoBlock: z.boolean().default(false),
  })
  .superRefine((r, ctx) => {
    const need = (cond, message) => !cond && ctx.addIssue({ code: 'custom', message });
    if (r.type === 'message') need(r.messageId, 'messageId is required');
    if (r.type === 'user') need(r.userId, 'userId is required');
    if (r.type === 'group') need(r.groupId, 'groupId is required');
  });

export const filePermissionsInput = z
  .strictObject({
    whoCanView: z.enum(['members', 'admins']).optional(),
    accessExpiry: z.enum(['1h', '24h', '7d', 'never']).optional(),
    allowDownload: z.boolean().optional(),
    allowShare: z.boolean().optional(),
    allowPrint: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const fileEventInput = z.strictObject({
  action: z.enum(['download_blocked', 'share_blocked', 'print_blocked', 'copy_blocked', 'open_with_blocked', 'screenshot_attempt']),
});

export const locationSettingsInput = z.strictObject({
  mode: z.enum(['none', 'join', 'live']),
  intervalMin: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(30)]).default(10),
  // Share live for N minutes (null = until stopped). Only used with mode = live.
  liveForMinutes: z.number().int().min(1).max(7 * 24 * 60).nullable().optional(),
});

export const locationUpdateInput = locationInput.extend({
  source: z.enum(['live', 'manual']).default('manual'),
});

export const historyQuery = z.object({ range: z.enum(['today', 'week', 'month']).default('today') });

export const EXPIRY_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
export const expiryDate = (key) => (EXPIRY_MS[key] ? new Date(Date.now() + EXPIRY_MS[key]) : null);
