import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { User } from '../modules/users/user.model.js';

/**
 * Firebase Cloud Messaging: Android app and web / PWA (prosecurely.online).
 * FIREBASE_SERVICE_ACCOUNT = path to the service account JSON; without it pushes are only logged.
 */
let messaging = null;
let tried = false;

function fcm() {
  if (tried) return messaging;
  tried = true;
  if (!env.FIREBASE_SERVICE_ACCOUNT) return null;
  try {
    const file = path.resolve(env.FIREBASE_SERVICE_ACCOUNT);
    const app = initializeApp({ credential: cert(JSON.parse(readFileSync(file, 'utf8'))) }, 'push');
    messaging = getMessaging(app);
    logger.info({ project: app.options.credential?.projectId }, 'Push notifications: Firebase ready');
  } catch (err) {
    logger.error({ err: err.message }, 'Push notifications: Firebase service account could not be loaded');
  }
  return messaging;
}

export const pushEnabled = () => Boolean(fcm());

// Tokens Firebase says are gone (app uninstalled, logged out, browser permission removed).
const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

/**
 * Sends one notification to every device of the users. `link` = app path opened on tap
 * (e.g. /dm/<id>), `tag` = one notification per chat (a new message replaces the old one).
 * Returns { devices, sent, removed }.
 */
export async function pushToUsers(userIds, { title, body, link, tag, data = {} }) {
  if (!userIds.length) return { devices: 0, sent: 0, removed: 0 };
  const users = await User.find({ _id: { $in: userIds }, status: { $nin: ['deleted', 'blocked'] } }).select('+devices').lean();
  const devices = users.flatMap((u) => (u.devices ?? []).map((d) => ({ ...d, user: u._id })));
  if (!devices.length) return { devices: 0, sent: 0, removed: 0 };
  const m = fcm();
  if (!m) {
    logger.info({ devices: devices.length, title }, 'Push notification (Firebase not configured)');
    return { devices: devices.length, sent: 0, removed: 0 };
  }
  const payload = Object.fromEntries(Object.entries({ ...data, link: link ?? '/' }).map(([k, v]) => [k, String(v ?? '')]));
  const web = env.APP_URL.replace(/\/$/, '');
  let sent = 0;
  const dead = [];
  for (let i = 0; i < devices.length; i += 500) {
    const batch = devices.slice(i, i + 500);
    const res = await m.sendEachForMulticast({
      tokens: batch.map((d) => d.token),
      notification: { title, body },
      data: payload,
      android: { priority: 'high', notification: { tag, sound: 'default', channelId: 'messages' } },
      webpush: {
        headers: { Urgency: 'high' },
        notification: { icon: `${web}/icons/Icon-192.png`, badge: `${web}/icons/Icon-192.png`, tag, renotify: true },
        fcmOptions: { link: `${web}${link ?? '/'}` },
      },
    });
    res.responses.forEach((r, j) => {
      if (r.success) sent++;
      else if (DEAD.has(r.error?.code)) dead.push(batch[j]);
      else logger.warn({ code: r.error?.code, err: r.error?.message }, 'Push failed');
    });
  }
  for (const d of dead) await User.updateOne({ _id: d.user }, { $pull: { devices: { token: d.token } } });
  return { devices: devices.length, sent, removed: dead.length };
}
