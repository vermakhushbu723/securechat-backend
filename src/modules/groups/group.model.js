import mongoose from 'mongoose';

import { CONTENT_RULES } from '../platform/platform.service.js';

const { Schema } = mongoose;

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------
const settingsSchema = new Schema(
  {
    location: {
      requirement: { type: String, enum: ['off', 'optional', 'mandatory'], default: 'off' },
      shareMode: { type: String, enum: ['join', 'live'], default: 'join' },
      liveIntervalMin: { type: Number, enum: [0, 5, 10, 30], default: 10 }, // 0 = manual
      visibility: { type: String, enum: ['adminOnly', 'groupMembers', 'nobody'], default: 'adminOnly' },
    },
    messages: {
      whoCanSend: { type: String, enum: ['all', 'admins'], default: 'all' },
      messageMode: { type: String, enum: ['public', 'private', 'user_select'], default: 'user_select' },
      membersCanEditInfo: { type: Boolean, default: false },
      membersCanSendMedia: { type: Boolean, default: true },
    },
    contentRules: { type: [{ type: String, enum: CONTENT_RULES }], default: () => [...CONTENT_RULES] },
    members: {
      approveNewMembers: { type: Boolean, default: false },
      restrictNewMembers: { type: Boolean, default: false }, // read only for the first 24 hours
      muteGroup: { type: Boolean, default: false }, // only admins can post
    },
    security: {
      publicForwarding: { type: Boolean, default: true },
      privateForwarding: { type: Boolean, default: false },
      trackForwardChain: { type: Boolean, default: true },
      openInAppOnly: { type: Boolean, default: true },
      downloadDisabled: { type: Boolean, default: true },
      externalShareDisabled: { type: Boolean, default: true },
      copyDisabledProtected: { type: Boolean, default: true },
      screenshotProtection: { type: Boolean, default: true },
      screenRecordingProtection: { type: Boolean, default: true },
      dynamicWatermark: { type: Boolean, default: true },
      chainDeletion: { type: Boolean, default: true },
      deleteForEveryoneUnlimited: { type: Boolean, default: false }, // false = 1 hour window
    },
  },
  { _id: false },
);

const lastMessageSchema = new Schema(
  {
    id: Schema.Types.ObjectId,
    sender: Schema.Types.ObjectId,
    senderName: String,
    type: String,
    text: String,
    visibility: String,
    deleted: { type: Boolean, default: false },
    createdAt: Date,
  },
  { _id: false },
);

/** Shard key suggestion: { _id: 'hashed' }. */
const groupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 50 },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    category: { type: String, trim: true, maxlength: 40, default: 'Other' },
    rules: { type: String, trim: true, maxlength: 500, default: '' },
    avatarUrl: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active' },
    memberCount: { type: Number, default: 0 },
    settings: { type: settingsSchema, default: () => ({}) },
    lastMessage: { type: lastMessageSchema, default: null },
    lastMessageAt: { type: Date, default: null },
  },
  { timestamps: true },
);

groupSchema.index({ status: 1, createdAt: -1 });

export const Group = mongoose.model('Group', groupSchema);

// ---------------------------------------------------------------------------
// Membership (+ per-user chat state). Shard key suggestion: { user: 1 }.
// ---------------------------------------------------------------------------
const memberLocationSchema = new Schema(
  {
    lat: Number,
    lng: Number,
    place: String,
    accuracy: Number,
    mode: { type: String, enum: ['none', 'join', 'live'], default: 'none' },
    updatedAt: Date,
  },
  { _id: false },
);

const memberSchema = new Schema(
  {
    group: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', 'admin', 'member'], default: 'member' },
    // pending = waiting for admin approval (join request)
    status: { type: String, enum: ['active', 'pending', 'left', 'removed'], default: 'active' },
    restricted: { type: Boolean, default: false }, // read only (set by admin)
    restrictedUntil: { type: Date, default: null }, // "restrict new members" (24h)
    joinedAt: { type: Date, default: Date.now },
    requestedAt: { type: Date, default: null },
    via: { type: String, enum: ['creator', 'invite'], default: 'invite' },
    inviteCode: { type: String, default: null },
    // Chat state
    unreadCount: { type: Number, default: 0, min: 0 },
    lastReadMessageId: { type: Schema.Types.ObjectId, default: null },
    lastReadAt: { type: Date, default: null },
    lastDeliveredMessageId: { type: Schema.Types.ObjectId, default: null },
    lastDeliveredAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    mutedUntil: { type: Date, default: null },
    pinned: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    clearedAt: { type: Date, default: null },
    location: { type: memberLocationSchema, default: null },
  },
  { timestamps: true },
);

memberSchema.index({ group: 1, user: 1 }, { unique: true });
memberSchema.index({ user: 1, status: 1, archived: 1, pinned: -1, lastMessageAt: -1 });
memberSchema.index({ group: 1, status: 1, role: 1 });

export const GroupMember = mongoose.model('GroupMember', memberSchema);

// ---------------------------------------------------------------------------
// Invite links: expiry, max joins, approval, revoke / reset
// ---------------------------------------------------------------------------
const inviteSchema = new Schema(
  {
    group: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
    code: { type: String, required: true, unique: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, default: null }, // null = never
    maxJoins: { type: Number, default: 0 }, // 0 = unlimited
    joins: { type: Number, default: 0 },
    requireApproval: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

inviteSchema.index({ group: 1, createdAt: -1 });

export const InviteLink = mongoose.model('InviteLink', inviteSchema);

/** "Active" | "Expired" | "Revoked" | "Full" as shown in the Invite Link screen. */
export function inviteState(link, now = new Date()) {
  if (link.status === 'revoked') return 'Revoked';
  if (link.expiresAt && link.expiresAt <= now) return 'Expired';
  if (link.maxJoins > 0 && link.joins >= link.maxJoins) return 'Full';
  return 'Active';
}
