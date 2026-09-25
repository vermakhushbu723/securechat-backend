import mongoose from 'mongoose';

const { Schema } = mongoose;

export const GROUP_MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'voice', 'file', 'location', 'contact', 'system'];
export const VISIBILITIES = ['public', 'private', 'highly_protected'];

const mediaSchema = new Schema(
  {
    url: String, // public uploads only; protected files have no public URL
    thumbUrl: String,
    secureFileId: { type: Schema.Types.ObjectId, ref: 'SecureFile' },
    mimeType: String,
    name: String,
    size: Number,
    width: Number,
    height: Number,
    duration: Number,
  },
  { _id: false },
);

const permissionsSchema = new Schema(
  {
    // Level 1 (public) only - private / highly protected always block these.
    allowDownload: { type: Boolean, default: true },
    allowScreenshot: { type: Boolean, default: true },
    allowShare: { type: Boolean, default: false },
    allowPrint: { type: Boolean, default: false },
    whoCanView: { type: String, enum: ['members', 'admins'], default: 'members' },
    viewOnce: { type: Boolean, default: false },
    expiresAt: { type: Date, default: null },
    accessExpiresAt: { type: Date, default: null }, // protected file access window
  },
  { _id: false },
);

/**
 * Forward chain: every copy stores the root (original) message, its parent
 * and all ancestors, so "delete for everyone" can remove a message and every
 * copy forwarded from it with one indexed query ({ 'forward.ancestors': id }).
 */
const forwardSchema = new Schema(
  {
    rootId: { type: Schema.Types.ObjectId },
    parentId: { type: Schema.Types.ObjectId },
    ancestors: { type: [Schema.Types.ObjectId], default: [] },
    depth: { type: Number, default: 0 },
    originGroup: { type: Schema.Types.ObjectId, ref: 'Group' },
    originSender: { type: Schema.Types.ObjectId, ref: 'User' },
    originAt: Date,
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
    senderName: String,
    type: String,
    text: String,
    visibility: String,
  },
  { _id: false },
);

/** Shard key suggestion: { group: 'hashed' } so a group's history lives on one shard. */
const groupMessageSchema = new Schema(
  {
    group: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    clientMsgId: { type: String, required: true },
    type: { type: String, enum: GROUP_MESSAGE_TYPES, required: true },
    text: { type: String, default: '', maxlength: 4096 },
    media: { type: mediaSchema, default: undefined },
    location: {
      type: new Schema({ lat: Number, lng: Number, name: String, address: String, live: Boolean }, { _id: false }),
      default: undefined,
    },
    contact: { type: new Schema({ name: String, phone: String }, { _id: false }), default: undefined },
    visibility: { type: String, enum: VISIBILITIES, default: 'public' },
    permissions: { type: permissionsSchema, default: () => ({}) },
    silent: { type: Boolean, default: false },
    replyTo: { type: replySchema, default: undefined },
    forward: { type: forwardSchema, default: undefined },
    // Copies derived from this message (direct + indirect) -> "users reached".
    forwardCount: { type: Number, default: 0 },
    reactions: { type: [reactionSchema], default: [] },
    starredBy: { type: [Schema.Types.ObjectId], default: [] },
    deletedFor: { type: [Schema.Types.ObjectId], default: [] },
    openedBy: { type: [Schema.Types.ObjectId], default: [] }, // view-once
    editedAt: { type: Date, default: null },
    status: { type: String, enum: ['active', 'deleted_for_everyone', 'expired'], default: 'active' },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deletedReason: { type: String, enum: ['sender', 'admin', 'chain', null], default: null },
    // System messages ("Rahul joined using invite link")
    system: {
      type: new Schema({ event: String, actor: Schema.Types.ObjectId, target: Schema.Types.ObjectId }, { _id: false }),
      default: undefined,
    },
  },
  { timestamps: true },
);

groupMessageSchema.index({ group: 1, _id: -1 });
groupMessageSchema.index({ sender: 1, clientMsgId: 1 }, { unique: true });
groupMessageSchema.index({ group: 1, type: 1, _id: -1 });
groupMessageSchema.index({ group: 1, visibility: 1, _id: -1 });
groupMessageSchema.index({ 'forward.ancestors': 1 });
groupMessageSchema.index({ 'forward.rootId': 1 });
groupMessageSchema.index({ starredBy: 1, _id: -1 });
groupMessageSchema.index({ 'permissions.expiresAt': 1 }, { sparse: true });
groupMessageSchema.index({ group: 1, text: 'text' }, { default_language: 'none' });

export const GroupMessage = mongoose.model('GroupMessage', groupMessageSchema);

export function groupPreviewText(m) {
  if (m.status === 'deleted_for_everyone') return 'This message was deleted';
  if (m.status === 'expired') return 'Message expired';
  if (m.type === 'system') return m.text;
  const lock = m.visibility === 'public' ? '' : '🔒 ';
  switch (m.type) {
    case 'text':
      return m.permissions?.viewOnce ? `${lock}View once message` : lock + m.text.slice(0, 120);
    case 'image':
      return `${lock}📷 ${m.text ? m.text.slice(0, 100) : 'Photo'}`;
    case 'video':
      return `${lock}🎥 ${m.text ? m.text.slice(0, 100) : 'Video'}`;
    case 'audio':
      return `${lock}🎵 Audio`;
    case 'voice':
      return `${lock}🎤 Voice message`;
    case 'file':
      return `${lock}📄 ${m.media?.name ?? 'Document'}`;
    case 'location':
      return m.location?.live ? '📍 Live location' : '📍 Location';
    case 'contact':
      return `👤 ${m.contact?.name ?? 'Contact'}`;
    default:
      return '';
  }
}
