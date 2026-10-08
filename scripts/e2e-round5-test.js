/**
 * End-to-end test: letters-only invite codes (old codes with digits still work), join
 * requests for group admins, member location for the group admin, links blocked in groups,
 * mailbox edit / same password for all.
 *   npm run test:round5   (server running, OTP_DEV_MODE=true; ADMIN_EMAIL / ADMIN_PASSWORD = staff)
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
async function fails(promise, code, what) {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  assert(err, `${what}: expected ${code}, but it succeeded`);
  eq(err.code, code, `${what} error code`);
  return err;
}

let token;
const admin = (method, path, body) => api(method, `/admin${path}`, { token, body });
const stamp = Date.now().toString(36).replace(/[^a-z]/g, '').slice(-5).padEnd(5, 'q');

async function otpUser(name) {
  const identifier = `rf${stamp}${name.toLowerCase()}@example.org`;
  const req = await api('POST', '/auth/otp/request', { body: { identifier } });
  const s = await api('POST', '/auth/otp/verify', { body: { identifier, code: req.devCode } });
  s.user = await api('POST', '/users/me/profile', { token: s.accessToken, body: { accountType: 'personal', name: `Rf ${stamp} ${name}` } });
  await api('POST', '/subscription/claim-trial', { token: s.accessToken }).catch(() => {});
  return s;
}

console.log(`\nSecureChat INVITES / JOIN REQUESTS / LOCATION / GROUP LINKS / MAILBOX EDIT test against ${BASE_URL}\n`);
token = (await api('POST', '/admin/auth/login', { body: { email: EMAIL, password: PASSWORD } })).token;
const contentBefore = await admin('GET', '/settings/content');
const [A, B, C, D] = [await otpUser('Owner'), await otpUser('Member'), await otpUser('Joiner'), await otpUser('Later')];
const created = { users: [A, B, C, D].map((u) => u.user.id), groups: [], mail: [] };
const as = (s) => (method, path, body) => api(method, path, { token: s.accessToken, body });

// B has shared a location before (no location group yet): only in his history.
await as(B)('POST', '/location/update', { lat: 19.076, lng: 72.8777, place: 'Mumbai' });
await as(C)('POST', '/location/update', { lat: 28.6139, lng: 77.209, place: 'Delhi' });

const G = (await admin('POST', '/groups', { name: `Round Five ${stamp}`, creator: A.user.id })).group;
created.groups.push(G.id);
await admin('POST', `/groups/${G.id}/members`, { user: B.user.id });

// ------------------------------------------------------------------ 4. invite codes
let invite;
await step('new invite links have letters only (no digits for the number protection to strip)', async () => {
  invite = await as(A)('POST', `/groups/${G.id}/invites`, { expiry: '24h', maxJoins: 10, requireApproval: true });
  assert(/^[A-Z]{3}-[A-Z]{7}$/.test(invite.code), `code ${invite.code}`);
  assert(invite.url.endsWith(`/group/${invite.code}`), `url ${invite.url}`);
  for (let i = 0; i < 5; i++) {
    const r = await as(A)('POST', `/groups/${G.id}/invites`, { expiry: '1h', maxJoins: 1 });
    assert(!/\d/.test(r.code), `code ${r.code}`);
  }
});

await step('the invite link can be sent in a 1-to-1 chat unchanged', async () => {
  const c = await as(B)('POST', '/conversations', { userId: D.user.id });
  const m = await as(B)('POST', `/conversations/${c.id}/messages`, { clientMsgId: clientId(), type: 'text', text: `https://prosecurely.online/group/${invite.code}` });
  assert(m.text.includes(invite.code), `text kept: ${m.text}`);
});

await step('an old code with digits (link shared before) still opens the group', async () => {
  const conn = await mongoose.createConnection(process.env.MONGO_URI).asPromise();
  const legacy = `RFV-${stamp.slice(0, 2).toUpperCase()}9${stamp.slice(2, 4).toUpperCase()}7`;
  await conn.db.collection('invitelinks').updateOne({ code: invite.code }, { $set: { legacyCode: legacy } });
  await conn.close();
  const p = await api('GET', `/invites/${legacy.toLowerCase()}`);
  eq(p.code, invite.code, 'resolves to the new code');
  eq(p.group.id, G.id, 'same group');
});

// ------------------------------------------------------------------ 3. join requests in the header
await step('join request: group admin sees how many and who, members do not', async () => {
  const r = await as(C)('POST', `/invites/${invite.code}/join`, {});
  eq(r.status, 'pending', 'needs approval');
  const dA = await as(A)('GET', `/groups/${G.id}`);
  eq(dA.me.pendingRequests?.count, 1, 'count for the admin');
  assert(dA.me.pendingRequests.names[0].includes('Joiner'), `names ${dA.me.pendingRequests.names}`);
  const dB = await as(B)('GET', `/groups/${G.id}`);
  eq(dB.me.pendingRequests, null, 'member sees nothing');
});

// ------------------------------------------------------------------ 2. location for the group admin
await step('location turned on later: admin sees members who already share location', async () => {
  await as(A)('PATCH', `/groups/${G.id}/settings`, { location: { requirement: 'optional', visibility: 'adminOnly' } });
  const p = await as(A)('GET', `/groups/${G.id}/members/${B.user.id}`);
  eq(p.canSeeLocation, true, 'admin may see');
  assert(p.location?.lat === 19.076, `B location ${JSON.stringify(p.location)}`);
  const map = await as(A)('GET', `/groups/${G.id}/locations`);
  assert(map.members.some((m) => m.userId === B.user.id && m.lat === 19.076), 'on the group map');
});

await step('approved member: location shown to the admin at once; header count back to 0', async () => {
  await as(A)('POST', `/groups/${G.id}/requests/${C.user.id}/approve`);
  const p = await as(A)('GET', `/groups/${G.id}/members/${C.user.id}`);
  assert(p.location?.lat === 28.6139, `C location ${JSON.stringify(p.location)}`);
  eq((await as(A)('GET', `/groups/${G.id}`)).me.pendingRequests.count, 0, 'no pending');
});

await step('members do not see locations when the group shows them to the admin only', async () => {
  const p = await as(B)('GET', `/groups/${G.id}/members/${C.user.id}`);
  eq(p.location, null, 'hidden');
  eq(p.canSeeLocation, false, 'not allowed');
  await as(A)('PATCH', `/groups/${G.id}/settings`, { location: { visibility: 'groupMembers' } });
  const p2 = await as(B)('GET', `/groups/${G.id}/members/${C.user.id}`);
  assert(p2.location?.lat === 28.6139, 'visible to members now');
});

await step('a member who turned sharing off is not shown', async () => {
  await as(D)('POST', '/location/update', { lat: 12.97, lng: 77.59 });
  await as(D)('PUT', '/location/settings', { mode: 'none' });
  await admin('POST', `/groups/${G.id}/members`, { user: D.user.id });
  const p = await as(A)('GET', `/groups/${G.id}/members/${D.user.id}`);
  eq(p.location, null, 'no location');
  eq(p.canSeeLocation, true, 'admin would see it once shared');
});

// ------------------------------------------------------------------ 5. links in groups
const gsend = (s, text) => as(s)('POST', `/groups/${G.id}/messages`, { clientMsgId: clientId(), type: 'text', text });
// Sent unless a live admin Blocked Keyword matches (shared DB) - only a links block is a failure.
async function sendsOk(promise, text) {
  const err = await promise.then(() => null, (e) => e);
  if (err && !(err.code === 'CONTENT_BLOCKED' && err.details?.rule === 'keyword')) throw new Error(`${text}: ${err.code} ${err.details?.rule ?? ''} ${err.message}`);
}

await step('links are refused in groups in every form, for members and the group admin', async () => {
  await admin('PUT', '/settings/content', { muteAfter: 0, suspendAfter: 0, phoneRestrictAfter: 0 });
  eq((await api('GET', '/config')).groupLinksBlocked, true, 'config for the app');
  for (const text of ['see https://example.org', 'http://abc', 'visit www.google.com', 'google.com', 'abc.in', 'my site . com', 'example dot com', 'shop(dot)in', 't.me/abc', 'hello.online', 'just https']) {
    const err = await fails(gsend(B, text), 'CONTENT_BLOCKED', text);
    eq(err.details.rule, 'links', `${text} rule`);
  }
  const err = await fails(gsend(A, 'abc.in'), 'CONTENT_BLOCKED', 'group admin');
  eq(err.details.rule, 'links', 'group admin rule');
  assert(err.message.endsWith('Links cannot be sent in groups.'), `message ${err.message}`);
  await admin('POST', `/users/${B.user.id}/action`, { action: 'unrestrict' }).catch(() => {});
  await admin('POST', `/users/${A.user.id}/action`, { action: 'unrestrict' }).catch(() => {});
});

await step('normal sentences still go through in groups; links still work in 1-to-1', async () => {
  for (const text of ['Hello. How are you', 'I am fine. In the evening we meet', 'e.g. this', 'ok so lets go']) await sendsOk(gsend(C, text), text);
  const c = await as(C)('POST', '/conversations', { userId: D.user.id });
  await sendsOk(as(C)('POST', `/conversations/${c.id}/messages`, { clientMsgId: clientId(), type: 'text', text: 'www.google.com' }), 'dm link');
});

await step('admin switch "Block links in every group" is shown to the app', async () => {
  await admin('PUT', '/settings/content', { groupLinksBlocked: false });
  eq((await api('GET', '/config')).groupLinksBlocked, false, 'off');
  await admin('PUT', '/settings/content', { groupLinksBlocked: true });
  eq((await api('GET', '/config')).groupLinksBlocked, true, 'on again');
});

// ------------------------------------------------------------------ 1. mailbox edit
await step('admin edits a mailbox (email, server, port, limit) and sets one password for all', async () => {
  const before = (await admin('GET', '/mail-accounts')).accounts.length;
  const add = await admin('POST', '/mail-accounts', { accounts: [{ email: `rf${stamp}@example.org`, password: 'x' }], host: '127.0.0.1', port: 2599 });
  eq(add.added.length, 1, 'added');
  const a = (await admin('GET', '/mail-accounts')).accounts.find((x) => x.email === `rf${stamp}@example.org`);
  created.mail.push(a.id);
  await admin('PATCH', `/mail-accounts/${a.id}`, { email: `rf${stamp}b@example.org`, host: 'smtp.hostinger.com', port: 587, dailyLimit: 300 });
  const e = (await admin('GET', '/mail-accounts')).accounts.find((x) => x.id === a.id);
  eq(e.email, `rf${stamp}b@example.org`, 'email');
  eq(e.port, 587, 'port');
  eq(e.dailyLimit, 300, 'limit');
  if (before === 0) {
    const r = await admin('POST', '/mail-accounts/password-all', { password: 'Same@123' });
    eq(r.updated, 1, 'all mailboxes');
  }
});

// cleanup
await admin('PUT', '/settings/content', {
  groupLinksBlocked: contentBefore.groupLinksBlocked !== false,
  muteAfter: contentBefore.muteAfter ?? 3,
  suspendAfter: contentBefore.suspendAfter ?? 5,
  phoneRestrictAfter: contentBefore.phoneRestrictAfter ?? 3,
}).catch(() => {});
for (const id of created.mail) await admin('DELETE', `/mail-accounts/${id}`).catch(() => {});
for (const id of created.groups) await admin('DELETE', `/groups/${id}`).catch(() => {});
for (const id of created.users) await admin('POST', `/users/${id}/action`, { action: 'delete' }).catch(() => {});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
process.exit(passed === results.length ? 0 : 1);
