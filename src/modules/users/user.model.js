import mongoose from 'mongoose';

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
    username: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
    phone: { type: String, trim: true, unique: true, sparse: true },
    email: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
    passwordHash: { type: String, select: false },
    avatarUrl: { type: String, default: null },
    about: { type: String, default: 'Hey there! I am using SecureChat.', maxlength: 140 },
    lastSeenAt: { type: Date, default: null },
    privacy: {
      lastSeen: { type: String, enum: ['everyone', 'nobody'], default: 'everyone' },
      readReceipts: { type: Boolean, default: true },
    },
    devices: { type: [deviceSchema], default: [], select: false },
    // Location privacy (Location Sharing screen): none | join (once while joining) | live (interval).
    locationSettings: {
      mode: { type: String, enum: ['none', 'join', 'live'], default: 'join' },
      intervalMin: { type: Number, enum: [0, 5, 10, 30], default: 10 }, // 0 = manual
      liveUntil: { type: Date, default: null }, // My Location: share live for 15 min / 1 h / 8 h / until stopped
    },
    // Content policy violations ("Warning 1 of 5").
    warnings: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'blocked'], default: 'active' },
  },
  { timestamps: true },
);

userSchema.pre('validate', function setSearchName() {
  if (this.isModified('name')) this.searchName = this.name.toLowerCase();
});

export const User = mongoose.model('User', userSchema);

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
    privacy: { lastSeen: u.privacy?.lastSeen ?? 'everyone', readReceipts: u.privacy?.readReceipts ?? true },
    locationSettings: {
      mode: u.locationSettings?.mode ?? 'join',
      intervalMin: u.locationSettings?.intervalMin ?? 10,
      liveUntil: u.locationSettings?.liveUntil ?? null,
    },
    warnings: u.warnings ?? 0,
    createdAt: u.createdAt,
  };
}
