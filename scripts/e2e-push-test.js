/**
 * End-to-end test: push notifications for 1-to-1 and group messages through Firebase.
 * A fake device token is registered; when a message goes out the worker sends it to Firebase,
 * Firebase answers "invalid token" and the server removes it - proving the whole path
 * (message -> queue -> worker -> FCM). Muted chats send nothing.
 *   npm run test:push   (server running with RUN_WORKERS=true and FIREBASE_SERVICE_ACCOUNT;
 *                        ADMIN_EMAIL / ADMIN_PASSWORD = staff)
 */
import 'dotenv/config';

import dns from 'node:dns';

import mongoose from 'mongoose';

import { api, BASE_URL, clientId } from './lib/client.js';

if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map((x) => x.trim()).filter(Boolean));

const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@securechat.local';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin@12345';
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  \x1b[32m✔\x1b[0m ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`  \x1b[31m✘ ${name}\x1b[0m\n      ${err.message}`);
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
};
const eq = (a, b, what) => assert(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token;
const admin = (method, path, body) => api(method, `/admin${path}`, { token, body });
const stamp = Date.now().toString(36).replace(/[^a-z]/g, '').slice(-5).padEnd(5, 'q');

async function otpUser(name) {
  const identifier = `pu${stamp}${name.toLowerCase()}@example.org`;
  const req = await api('POST', '/auth/otp/request', { body: { identifier } });
  const s = await api('POST', '/auth/otp/verify', { body: { identifier, code: req.devCode } });
  s.user = await api('POST', '/users/me/profile', { token: s.accessToken, body: { accountType: 'personal', name: `Pu ${stamp} ${name}` } });
  await api('POST', '/subscription/claim-trial', { token: s.accessToken }).catch(() => {});
  return s;
}

console.log(`\nSecureChat PUSH NOTIFICATIONS test against ${BASE_URL}\n`);
token = (await api('POST', '/admin/auth/login', { body: { email: EMAIL, password: PASSWORD } })).token;
const db = await mongoose.createConnection(process.env.MONGO_URI).asPromise();
const devicesOf = async (s) => ((await db.db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(s.user.id) }, { projection: { devices: 1 } }))?.devices ?? []).map((d) => d.token);
const as = (s) => (method, path, body) => api(method, path, { token: s.accessToken, body });
/** Waits until the worker sent the push (Firebase rejected the fake token and it was removed). */
async function pushedTo(s, tok, what) {
  for (let i = 0; i < 40; i++) {
    if (!(await devicesOf(s)).includes(tok)) return;
    await sleep(500);
  }
  throw new Error(`${what}: no push reached Firebase (token still stored)`);
}

const [A, B, C] = [await otpUser('Ann'), await otpUser('Ben'), await otpUser('Cid')];
const created = { users: [A, B, C].map((u) => u.user.id), groups: [] };
const fake = (n) => `fake-${stamp}-${n}-${'x'.repeat(40)}`;

await step('app registers its device token after login; a token belongs to one account only', async () => {
  await as(A)('POST', '/users/me/devices', { token: fake('shared'), platform: 'android' });
  eq((await devicesOf(A)).includes(fake('shared')), true, 'stored for A');
  await as(C)('POST', '/users/me/devices', { token: fake('shared'), platform: 'android' }); // C signs in on the same phone
  eq((await devicesOf(A)).includes(fake('shared')), false, 'moved away from A');
  eq((await devicesOf(C)).includes(fake('shared')), true, 'now C');
});

await step('logout removes the token', async () => {
  await as(C)('DELETE', '/users/me/devices', { token: fake('shared') });
  eq((await devicesOf(C)).length, 0, 'removed');
});

let conv;
await step('1-to-1 message: push sent to the recipient through Firebase', async () => {
  await as(A)('POST', '/users/me/devices', { token: fake('dm'), platform: 'android' });
  conv = await as(B)('POST', '/conversations', { userId: A.user.id });
  await as(B)('POST', `/conversations/${conv.id}/messages`, { clientMsgId: clientId(), type: 'text', text: 'hello Ann' });
  await pushedTo(A, fake('dm'), 'dm');
});

await step('the sender never gets a push for his own message', async () => {
  await as(B)('POST', '/users/me/devices', { token: fake('sender'), platform: 'web' });
  await as(B)('POST', `/conversations/${conv.id}/messages`, { clientMsgId: clientId(), type: 'text', text: 'again' });
  await sleep(4000);
  eq((await devicesOf(B)).includes(fake('sender')), true, 'sender token untouched');
});

await step('muted 1-to-1 chat: no push', async () => {
  await as(A)('PATCH', `/conversations/${conv.id}`, { muteSeconds: -1 });
  await as(A)('POST', '/users/me/devices', { token: fake('muted'), platform: 'android' });
  await as(B)('POST', `/conversations/${conv.id}/messages`, { clientMsgId: clientId(), type: 'text', text: 'muted?' });
  await sleep(4000);
  eq((await devicesOf(A)).includes(fake('muted')), true, 'no push while muted');
  await as(A)('DELETE', '/users/me/devices', { token: fake('muted') });
});

let G;
await step('group message: push sent to the members (web + android)', async () => {
  G = (await admin('POST', '/groups', { name: `Push Test ${stamp}`, creator: B.user.id })).group;
  created.groups.push(G.id);
  await admin('POST', `/groups/${G.id}/members`, { user: C.user.id });
  await as(C)('POST', '/users/me/devices', { token: fake('group-web'), platform: 'web' });
  await as(C)('POST', '/users/me/devices', { token: fake('group-android'), platform: 'android' });
  await as(B)('POST', `/groups/${G.id}/messages`, { clientMsgId: clientId(), type: 'text', text: 'hello group' });
  await pushedTo(C, fake('group-web'), 'group web');
  await pushedTo(C, fake('group-android'), 'group android');
});

await step('muted group: no push', async () => {
  await as(C)('PATCH', `/groups/${G.id}/me`, { muteSeconds: -1 });
  await as(C)('POST', '/users/me/devices', { token: fake('gmuted'), platform: 'android' });
  await as(B)('POST', `/groups/${G.id}/messages`, { clientMsgId: clientId(), type: 'text', text: 'quiet please' });
  await sleep(4000);
  eq((await devicesOf(C)).includes(fake('gmuted')), true, 'no push while muted');
});

// cleanup
await db.close();
for (const id of created.groups) await admin('DELETE', `/groups/${id}`).catch(() => {});
for (const id of created.users) await admin('POST', `/users/${id}/action`, { action: 'delete' }).catch(() => {});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
process.exit(passed === results.length ? 0 : 1);
