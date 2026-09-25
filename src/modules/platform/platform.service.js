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
  // Rules that always apply, even when a group turns them off.
  globalRules: ['abuse'],
  abuseWords: ['IDIOT', 'STUPID', 'BASTARD', 'NONSENSE'],
  maxWarnings: 5,
};

const CACHE_KEY = 'platform:content';

export async function getContentSettings() {
  const cached = await redis.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);
  const row = await PlatformSetting.findOne({ key: 'content' }).lean();
  const value = { ...DEFAULT_CONTENT_SETTINGS, ...(row?.value ?? {}) };
  await redis.set(CACHE_KEY, JSON.stringify(value), 'EX', 300);
  return value;
}

export async function updateContentSettings(patch) {
  const current = await getContentSettings();
  const value = { ...current, ...patch };
  await PlatformSetting.updateOne({ key: 'content' }, { $set: { value } }, { upsert: true });
  await redis.del(CACHE_KEY);
  return value;
}
