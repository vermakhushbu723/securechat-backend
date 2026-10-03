import { logger } from '../../config/logger.js';
import { redis } from '../../db/redis.js';
import { ApiError } from '../../utils/ApiError.js';
import { analyzePhone } from '../../utils/phoneGuard.js';
import { audit } from '../audit/audit.service.js';
import { getContentSettings } from '../platform/platform.service.js';
import { restrictUser } from '../users/moderation.service.js';
import { User } from '../users/user.model.js';

/**
 * Mandatory mobile number protection for every message (1-to-1 + groups).
 * Keeps the sender's recent short numeric fragments per chat for 10 minutes so a number
 * split over several messages ("98", "765" ... or "9", "8" ...) is still caught.
 * Repeated attempts (content setting phoneRestrictAfter, default 3 in 10 minutes) -> 1 hour read only.
 */
const WINDOW_SEC = 600;
const FRAGMENTS = 8;
const fragKey = (userId, thread) => `phonefrag:${userId}:${thread}`;
const attemptKey = (userId) => `phoneblk:${userId}`;

export const PHONE_BLOCKED_MESSAGE = 'Mobile number sharing is not allowed on this platform.';

/**
 * Returns the text to store (masked when the score asks for it) or throws
 * 422 CONTENT_BLOCKED (rule "phone").
 * thread: 'dm:<conversationId>' | 'g:<groupId>' (fragments are combined per chat).
 */
export async function enforcePhoneGuard(userId, text, { thread, groupId = null, scope }) {
  if (!text || !String(text).trim()) return text;
  const [recent, attempts] = await Promise.all([redis.lrange(fragKey(userId, thread), 0, FRAGMENTS - 1), redis.get(attemptKey(userId))]);
  const result = analyzePhone(text, { recentDigits: recent.reverse().join(''), attempts: Number(attempts) || 0 });

  if (result.action === 'block' || result.action === 'block_log') {
    const count = await redis.multi().incr(attemptKey(userId)).expire(attemptKey(userId), WINDOW_SEC).exec();
    const n = Number(count?.[0]?.[1]) || 1;
    const cs = await getContentSettings();
    const restrictAfter = cs.phoneRestrictAfter ?? 3;
    // Counts as a content warning ("Warning 2 of 5") like the other filters.
    const u = await User.findByIdAndUpdate(userId, { $inc: { warnings: 1 } }, { returnDocument: 'after', lean: true, projection: { warnings: 1 } });
    const restrict = restrictAfter > 0 && n >= restrictAfter;
    await redis.del(fragKey(userId, thread));
    audit(userId, 'content_blocked', {
      group: groupId,
      meta: { rule: 'phone', scope, score: result.score, reasons: result.reasons, severity: result.action === 'block_log' ? 'high' : 'normal', text: String(text).slice(0, 200) },
    });
    if (restrict) {
      await restrictUser(userId, true, { hours: 1 }).catch((err) => logger.warn({ err: err.message }, 'Phone guard restriction failed'));
      audit(userId, 'phone_sharing_restricted', { group: groupId, meta: { attempts: n } });
      await redis.del(attemptKey(userId));
    }
    throw new ApiError(422, 'CONTENT_BLOCKED', PHONE_BLOCKED_MESSAGE, {
      rule: 'phone',
      score: result.score,
      reasons: result.reasons,
      restricted: restrict,
      warnings: u?.warnings ?? 1,
      maxWarnings: cs.maxWarnings,
    });
  }

  // Short messages with a digit are remembered so the next fragments are combined.
  if (result.digits && String(text).trim().length <= 12) {
    await redis.multi().lpush(fragKey(userId, thread), result.digits).ltrim(fragKey(userId, thread), 0, FRAGMENTS - 1).expire(fragKey(userId, thread), WINDOW_SEC).exec();
  }
  if (result.action === 'mask') {
    audit(userId, 'content_masked', { group: groupId, meta: { rule: 'phone', scope, score: result.score, reasons: result.reasons } });
    return result.masked;
  }
  return text;
}

/** Contact cards carry a phone number: never allowed (same message as above). */
export function assertNoContactNumber(userId, contact, { groupId = null, scope }) {
  if (!contact?.phone) return;
  const digits = String(contact.phone).replace(/\D/g, '');
  if (digits.length < 2) return;
  audit(userId, 'content_blocked', { group: groupId, meta: { rule: 'phone', scope, score: 8, reasons: ['contact card with a phone number'], text: `[contact] ${contact.name ?? ''}`.slice(0, 200) } });
  throw new ApiError(422, 'CONTENT_BLOCKED', PHONE_BLOCKED_MESSAGE, { rule: 'phone', score: 8, reasons: ['contact card with a phone number'] });
}

/** Admin test box (no fragments / attempts). */
export const testPhone = (text) => analyzePhone(text);
