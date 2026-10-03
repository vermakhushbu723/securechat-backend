import mongoose from 'mongoose';

import { redis } from '../../db/redis.js';

const { Schema } = mongoose;

/** Key/value settings the platform admin manages (admin panel). */
const platformSettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

export const PlatformSetting = mongoose.model('PlatformSetting', platformSettingSchema);

export const CONTENT_RULES = ['abuse', 'numbers', 'numberWords', 'spam', 'links', 'personalInfo', 'externalContact'];

export const DEFAULT_CONTENT_SETTINGS = {
  // Rules that always apply, even when a group turns them off (Content Moderation "Content Control").
  globalRules: ['abuse'],
  // Abuse / Profanity Filter
  abuseEnabled: true,
  abuseWords: ['IDIOT', 'STUPID', 'BASTARD', 'NONSENSE'],
  hinglish: true,
  misspellings: true,
  sensitivity: 2, // 1 low, 2 medium, 3 high
  // Number Filter
  hindiNumbers: true,
  normalization: true,
  // Penalties: warning -> mute 24h -> suspend 7 days
  maxWarnings: 5,
  muteAfter: 3,
  suspendAfter: 5,
  // Mobile number protection: blocked attempts in 10 minutes before 1 hour read only (0 = off).
  phoneRestrictAfter: 3,
};

/** Every admin section with its defaults. */
export const SETTING_DEFAULTS = {
  content: DEFAULT_CONTENT_SETTINGS,
  subscription: {
    trialDays: 7,
    afterExpiry: 'locked', // locked (read only) | limited (text only)
    remindBeforeExpiry: true,
    allowExtensionRequests: true,
    freeExtension: true,
    premiumExtension: true,
    defaultExtensionDays: 7,
    maxExtensions: 2, // 0 = unlimited
  },
  location: {
    showToAdmin: true,
    showToMembers: false, // new groups: adminOnly unless the admin changes it
    liveStatusVisible: true,
    autoDeleteDays: 30,
  },
  security: {
    publicMessages: true,
    privateMessages: true,
    publicForwarding: true,
    privateForwarding: false,
    chainDeletion: true,
    deleteForwardedCopies: true,
    downloadDisabled: true,
    externalShareDisabled: true,
    copyDisabled: true,
    secureViewer: true,
    noPublicFileUrl: true,
    screenshotProtection: true,
    screenRecordingProtection: true,
    blockCasting: true,
    printRestriction: true,
    dynamicWatermark: true,
  },
  system: {
    verification: 'mobile_email', // mobile | email | mobile_email
    openRegistration: true,
    maxDevices: 3,
    otpExpiryMin: 5,
    directChat: true,
    // Search Permissions: 1-to-1 user search and group member search for everyone.
    userSearch: true,
    groupMemberSearch: true,
    hideContactFromMembers: true,
    autoStartingName: true,
    pwaInstallable: true,
    flagSecure: true,
    minAppVersion: '1.0.0',
    maxFileMb: 50,
    fileTokenMin: 30,
    auditRetentionDays: 730,
    maintenance: false,
    maintenanceMessage: 'SecureChat is under maintenance. Please try again in a few minutes.',
  },
  roles: {
    super_admin: ['users', 'groups', 'messages', 'subscriptions', 'reports', 'settings'],
    moderator: ['users', 'groups', 'messages', 'reports'],
    support: ['users', 'subscriptions', 'reports'],
  },
};

const cacheKey = (key) => `platform:${key}`;

export async function getSetting(key) {
  const cached = await redis.get(cacheKey(key));
  if (cached) return JSON.parse(cached);
  const row = await PlatformSetting.findOne({ key }).lean();
  const value = { ...(SETTING_DEFAULTS[key] ?? {}), ...(row?.value ?? {}) };
  await redis.set(cacheKey(key), JSON.stringify(value), 'EX', 300);
  return value;
}

export async function updateSetting(key, patch) {
  const current = await getSetting(key);
  const value = { ...current, ...patch };
  await PlatformSetting.updateOne({ key }, { $set: { value } }, { upsert: true });
  await redis.del(cacheKey(key));
  return value;
}

export const getContentSettings = () => getSetting('content');
export const updateContentSettings = (patch) => updateSetting('content', patch);
