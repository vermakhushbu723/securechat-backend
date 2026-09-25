import mongoose from 'mongoose';

const { Schema } = mongoose;

export const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'voice', 'file', 'location', 'contact', 'sticker'];
export const MEDIA_TYPES = ['image', 'video', 'audio', 'voice', 'file', 'sticker'];

const mediaSchema = new Schema(
  {
    url: String,
    thumbUrl: String,
    mimeType: String,
    name: String,
    size: Number,
    width: Number,
    height: Number,
    duration: Number, // seconds (audio / voice / video)
  },
  { _id: false },
);

const reactionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    emoji: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const replySchema = new Schema(
  {
    id: Schema.Types.ObjectId,
    sender: Schema.Types.ObjectId,
    type: String,
    text: String,
  },
  { _id: false },
);

/**
 * Ordered by `_id` (ObjectId embeds the creation time), which gives cheap
 * cursor pagination: `{ conversation, _id: { $lt: cursor } }`.
 * Shard key suggestion: { conversation: 'hashed' } so a chat lives on one shard.
 */
const messageSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Client generated id -> idempotent retries (no duplicate on reconnect).
    clientMsgId: { type: String, required: true },
    type: { type: String, enum: MESSAGE_TYPES, required: true },
    text: { type: String, default: '', maxlength: 10_000 },
    media: { type: mediaSchema, default: undefined },
    location: {
      type: new Schema({ lat: Number, lng: Number, name: String, address: String, live: Boolean }, { _id: false }),
      default: undefined,
    },
    contact: {
      type: new Schema({ name: String, phone: String, userId: Schema.Types.ObjectId }, { _id: false }),
      default: undefined,
    },
    replyTo: { type: replySchema, default: undefined },
    forwarded: { type: Boolean, default: false },
    forwardCount: { type: Number, default: 0 },
    reactions: { type: [reactionSchema], default: [] },
    editedAt: { type: Date, default: null },
    deletedForEveryone: { type: Boolean, default: false },
    deletedFor: { type: [Schema.Types.ObjectId], default: [] },
    starredBy: { type: [Schema.Types.ObjectId], default: [] },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

messageSchema.index({ conversation: 1, _id: -1 });
messageSchema.index({ sender: 1, clientMsgId: 1 }, { unique: true });
messageSchema.index({ recipient: 1, deliveredAt: 1 });
messageSchema.index({ conversation: 1, recipient: 1, readAt: 1 });
messageSchema.index({ conversation: 1, recipient: 1, _id: 1 });
messageSchema.index({ conversation: 1, type: 1, _id: -1 });
messageSchema.index({ starredBy: 1, _id: -1 });
messageSchema.index({ conversation: 1, text: 'text' }, { default_language: 'none' });

export const Message = mongoose.model('Message', messageSchema);

export function previewText(m) {
  if (m.deletedForEveryone) return 'This message was deleted';
  switch (m.type) {
    case 'text':
      return m.text.slice(0, 120);
    case 'image':
      return m.text ? `📷 ${m.text.slice(0, 100)}` : '📷 Photo';
    case 'video':
      return m.text ? `🎥 ${m.text.slice(0, 100)}` : '🎥 Video';
    case 'audio':
      return '🎵 Audio';
    case 'voice':
      return '🎤 Voice message';
    case 'file':
      return `📄 ${m.media?.name ?? 'File'}`;
    case 'location':
      return m.location?.live ? '📍 Live location' : '📍 Location';
    case 'contact':
      return `👤 ${m.contact?.name ?? 'Contact'}`;
    case 'sticker':
      return 'Sticker';
    default:
      return '';
  }
}

/** Serializes a message for one viewer (starred flag and status are viewer specific). */
export function toMessageDTO(m, viewerId) {
  const viewer = String(viewerId);
  const deleted = m.deletedForEveryone;
  return {
    id: String(m._id),
    conversationId: String(m.conversation),
    clientMsgId: m.clientMsgId,
    senderId: String(m.sender),
    recipientId: String(m.recipient),
    type: m.type,
    text: deleted ? '' : m.text,
    media: deleted ? null : (m.media ?? null),
    location: deleted ? null : (m.location ?? null),
    contact: deleted ? null : m.contact ? { ...m.contact, userId: m.contact.userId ? String(m.contact.userId) : null } : null,
    replyTo:
      !deleted && m.replyTo?.id
        ? { id: String(m.replyTo.id), senderId: String(m.replyTo.sender), type: m.replyTo.type, text: m.replyTo.text }
        : null,
    forwarded: m.forwarded,
    forwardCount: m.forwardCount,
    reactions: deleted ? [] : (m.reactions ?? []).map((r) => ({ userId: String(r.user), emoji: r.emoji })),
    edited: Boolean(m.editedAt),
    editedAt: m.editedAt,
    deleted,
    starred: (m.starredBy ?? []).some((u) => String(u) === viewer),
    status: m.readAt ? 'read' : m.deliveredAt ? 'delivered' : 'sent',
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
    createdAt: m.createdAt,
  };
}
