import mongoose from 'mongoose';

import { accessOf } from '../subscription/access.js';

const { Schema } = mongoose;

const deviceSchema = new Schema(
  {
    token: { type: String, required: true },
    platform: { type: String, enum: ['android', 'ios', 'web'], required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // Starting name shown to group members (never phone / email / id). Defaults to the first word of name.
    displayName: { type: String, trim: true, maxlength: 20, default: null },
    // Lower-cased copy of name for anchored prefix search (index friendly).
    searchName: { type: String, index: true },
    // Lower-cased words of name + username: "test" finds "AB TEST COMPANY" (multikey prefix index).
    searchTokens: { type: [String], index: true, default: [] },
    username: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
    phone: { type: String, trim: true, unique: true, sparse: true },
    email: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
    passwordHash: { type: String, select: false },
    avatarUrl: { type: String, default: null },
    about: { type: String, default: 'Hey there! I am using SecureChat.', maxlength: 140 },
    // Signup: Personal (name only) or Business (business name + address + bio). For business, name = business name.
    accountType: { type: String, enum: ['personal', 'business'], default: 'personal' },
    businessAddress: { type: String, trim: true, maxlength: 200, default: null },
    // false right after the first OTP login until the Personal / Business form is filled.
    profileCompleted: { type: Boolean, default: true },
    lastSeenAt: { type: Date, default: null },
    privacy: {
      lastSeen: { type: String, enum: ['everyone', 'nobody'], default: 'everyone' },
      readReceipts: { type: Boolean, default: true },
      // Settings: "Anyone can find me by user ID / name". Off = hidden from user search.
      searchable: { type: Boolean, default: true },
      // Settings: show my mobile number & email to other users (off = always hidden).
      showContact: { type: Boolean, default: false },
    },
    devices: { type: [deviceSchema], default: [], select: false },
    // Location privacy (Location Sharing screen): none | join (once while joining) | live (interval).
    locationSettings: {
      mode: { type: String, enum: ['none', 'join', 'live'], default: 'join' },
      intervalMin: { type: Number, enum: [0, 5, 10, 30], default: 10 }, // 0 = manual
      liveUntil: { type: Date, default: null }, // My Location: share live for 15 min / 1 h / 8 h / until stopped
    },
    // 7 day trial from createdAt; premium bought / extension approved by the admin.
    subscription: {
      premiumUntil: { type: Date, default: null },
      extendedUntil: { type: Date, default: null },
      graceAt: { type: Date, default: null }, // one time grace given when plans were introduced
      trialEndsAt: { type: Date, default: null }, // admin override / claimed trial end
      // New accounts: the 7 day trial starts only when the user taps "Claim free trial".
      trialPending: { type: Boolean, default: false },
      // Admin "Free" access: full access without a plan until removed.
      freeAccess: { type: Boolean, default: false },
      plan: { type: String, default: null }, // premium plan id the access came from
      grantedBy: { type: String, default: null }, // "Payment" | "Admin: <name>"
      extensionCount: { type: Number, default: 0 },
    },
    // Content policy violations ("Warning 1 of 5").
    warnings: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'blocked', 'suspended', 'deleted'], default: 'active' },
    // Platform admin moderation (admin panel).
    moderation: {
      reason: { type: String, default: null },
      at: { type: Date, default: null },
      by: { type: String, default: null }, // staff name
      suspendedUntil: { type: Date, default: null },
      // Read only everywhere (admin "Restrict messaging" / content penalty "mute 24h").
      restricted: { type: Boolean, default: false },
      restrictedUntil: { type: Date, default: null },
    },
    // Admin Search Permissions: this user cannot search users (1-to-1) or group members.
    searchBlocked: { type: Boolean, default: false },
    // Admin Search Permissions: nobody finds this user in search (1-to-1 or group members).
    searchHidden: { type: Boolean, default: false },
    // Admin Security Settings, scope "User": overrides for this user (null = platform default).
    securityOverrides: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

/** Words used by user search: every word of the name and the username. */
export function searchTokensOf(name, username) {
  const words = `${name ?? ''} ${username ?? ''}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.]+/u)
    .filter(Boolean);
  return [...new Set(words)].slice(0, 20);
}

userSchema.pre('validate', function setSearchName() {
  if (this.isModified('name')) this.searchName = this.name.toLowerCase();
  if (this.isModified('name') || this.isModified('username')) this.searchTokens = searchTokensOf(this.name, this.username);
});

userSchema.index({ status: 1, createdAt: -1 });

export const User = mongoose.model('User', userSchema);

/** Blocked / deleted / suspended (until the suspension ends) accounts cannot sign in or chat. */
export function accountState(u, now = Date.now()) {
  const status = u?.status ?? 'active';
  if (status === 'suspended' && u.moderation?.suspendedUntil && new Date(u.moderation.suspendedUntil).getTime() <= now) return 'active';
  return status;
}

/** Read only restriction set by the admin or a content penalty. */
export function isRestricted(u, now = Date.now()) {
  const m = u?.moderation;
  if (!m) return false;
  if (m.restricted) return true;
  return Boolean(m.restrictedUntil && new Date(m.restrictedUntil).getTime() > now);
}

/** Name other group members see: the chosen display name or the first word of the name. */
export const displayNameOf = (u) => (u?.displayName || u?.name?.trim().split(/\s+/)[0] || 'Member').slice(0, 20);

/** Profile other users may see. Phone / email stay private. */
export function toPublicUser(u) {
  if (!u) return null;
  const hideLastSeen = u.privacy?.lastSeen === 'nobody';
  return {
    id: String(u._id),
    name: u.name,
    displayName: displayNameOf(u),
    username: u.username ?? null,
    avatarUrl: u.avatarUrl ?? null,
    about: u.about ?? '',
    accountType: u.accountType ?? 'personal',
    businessAddress: u.accountType === 'business' ? (u.businessAddress ?? null) : null,
    // Only when the owner turned on "Show mobile number & email".
    ...(u.privacy?.showContact ? { phone: u.phone ?? null, email: u.email ?? null } : {}),
    lastSeenAt: hideLastSeen ? null : (u.lastSeenAt ?? null),
  };
}

/** Full profile for the owner. */
export function toSelfUser(u) {
  return {
    ...toPublicUser(u),
    lastSeenAt: u.lastSeenAt ?? null,
    phone: u.phone ?? null,
    email: u.email ?? null,
    privacy: {
      lastSeen: u.privacy?.lastSeen ?? 'everyone',
      readReceipts: u.privacy?.readReceipts ?? true,
      searchable: u.privacy?.searchable ?? true,
      showContact: u.privacy?.showContact ?? false,
    },
    subscription: accessOf(u),
    profileCompleted: u.profileCompleted !== false,
    locationSettings: {
      mode: u.locationSettings?.mode ?? 'join',
      intervalMin: u.locationSettings?.intervalMin ?? 10,
      liveUntil: u.locationSettings?.liveUntil ?? null,
    },
    warnings: u.warnings ?? 0,
    searchBlocked: Boolean(u.searchBlocked),
    searchHidden: Boolean(u.searchHidden),
    createdAt: u.createdAt,
  };
}
