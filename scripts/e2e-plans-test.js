/**
 * End-to-end test: contact visibility, user search, 1-to-1 protected files,
 * trial / premium rules and group premium ("members without premium").
 *   npm run test:plans     (server running with OTP_DEV_MODE=true and ADMIN_API_KEY set)
 */
import 'dotenv/config';

import sharp from 'sharp';

import { api, BASE_URL, clientId, connectSocket, emit, loginOrRegister, TEST_USERS } from './lib/client.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY;
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
const fails = async (promise, code, what) => {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  assert(err, `${what}: expected ${code}, but it succeeded`);
  eq(err.code, code, `${what} error code`);
};

async function admin(path, body) {
  const res = await fetch(`${BASE_URL}/api/v1/admin${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`admin ${path}: ${json.error?.code} ${json.error?.message}`);
  return json.data;
}

async function otpUser(identifier, profile) {
  const req = await api('POST', '/auth/otp/request', { body: { identifier } });
  const s = await api('POST', '/auth/otp/verify', { body: { identifier, code: req.devCode } });
  if (profile) s.user = await api('POST', '/users/me/profile', { token: s.accessToken, body: profile });
  return s;
}

async function upload(token, { buffer, filename, mime, secure }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  if (secure) form.append('secure', 'true');
  return api('POST', '/media/upload', { token, form });
}

console.log(`\nSecureChat PLANS / SEARCH / DM PROTECTED FILES test against ${BASE_URL}\n`);
assert(ADMIN_KEY, 'ADMIN_API_KEY is required (reads .env)');

const [A, P] = await Promise.all(TEST_USERS.map(loginOrRegister));
const stamp = Date.now().toString(36);
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 168, b: 132 } } }).png().toBuffer();

// ---------------------------------------------------------------- contact visibility
await step('mobile number & email are hidden until "show" is turned on', async () => {
  let pub = await api('GET', `/users/${A.user.id}`, { token: P.accessToken });
  assert(pub.phone === undefined, 'phone hidden by default');
  const me = await api('PATCH', '/users/me', { token: A.accessToken, body: { privacy: { showContact: true } } });
  eq(me.privacy.showContact, true, 'saved');
  pub = await api('GET', `/users/${A.user.id}`, { token: P.accessToken });
  eq(pub.phone, TEST_USERS[0].phone, 'phone visible when on');
  await api('PATCH', '/users/me', { token: A.accessToken, body: { privacy: { showContact: false } } });
  pub = await api('GET', `/users/${A.user.id}`, { token: P.accessToken });
  assert(pub.phone === undefined, 'hidden again');
});

// ---------------------------------------------------------------- search
const bizMobile = `8${String(Date.now()).slice(-9)}`;
let biz;
await step('search finds personal and business users by any word, number or email', async () => {
  biz = await otpUser(bizMobile, { accountType: 'business', businessName: `Zeta ${stamp} Traders`, businessAddress: 'Hazratganj, Lucknow', bio: 'Test' });
  const person = await otpUser(`p${stamp}@example.org`, { accountType: 'personal', name: `Kavya ${stamp} Rao` });
  const byWord = await api('GET', `/users/search?q=traders%20${stamp}`, { token: A.accessToken });
  assert(byWord.some((u) => u.id === biz.user.id), 'business found by middle / last word');
  const byPrefix = await api('GET', `/users/search?q=${stamp.slice(0, 4)}`, { token: A.accessToken });
  assert(byPrefix.some((u) => u.id === biz.user.id) && byPrefix.some((u) => u.id === person.user.id), 'both found by word prefix');
  const byNumber = await api('GET', `/users/search?q=${bizMobile}`, { token: A.accessToken });
  eq(byNumber[0]?.id, biz.user.id, 'found by 10 digit number');
  const byEmail = await api('GET', `/users/search?q=${encodeURIComponent(`P${stamp}@example.org`)}`, { token: A.accessToken });
  eq(byEmail[0]?.id, person.user.id, 'found by email');
  await api('PATCH', '/users/me', { token: person.accessToken, body: { privacy: { searchable: false } } });
  const hidden = await api('GET', `/users/search?q=kavya%20${stamp}`, { token: A.accessToken });
  assert(!hidden.length, '"Anyone can find me" off -> hidden');
});

// ---------------------------------------------------------------- DM protected files
let dmFile;
let dmMsg;
await step('1-to-1: private photo is encrypted, has no URL and opens with a token', async () => {
  const sec = await upload(A.accessToken, { buffer: png, filename: 'plan.png', mime: 'image/png', secure: true });
  assert(sec.secure && sec.secureFileId && !sec.url, 'secure upload');
  const pub = await upload(A.accessToken, { buffer: png, filename: 'x.png', mime: 'image/png' });
  await fails(api('POST', `/conversations/${(await api('POST', '/conversations', { token: A.accessToken, body: { userId: P.user.id } })).id}/messages`, {
    token: A.accessToken,
    body: { clientMsgId: clientId(), type: 'image', media: pub, visibility: 'private' },
  }), 'SECURE_UPLOAD_REQUIRED', 'public upload as private');

  const s = await connectSocket(A.accessToken);
  const res = await emit(s, 'message:send', {
    toUserId: P.user.id,
    clientMsgId: clientId(),
    type: 'image',
    text: 'Site plan - keep private',
    media: { secure: true, secureFileId: sec.secureFileId, mimeType: 'image/png', size: png.length, name: 'plan.png' },
    visibility: 'private',
  });
  s.close();
  dmMsg = res.message ?? res;
  eq(dmMsg.visibility, 'private', 'visibility');
  eq(dmMsg.media.secure, true, 'secure media');
  assert(!dmMsg.media.url, 'no public url');
  eq(dmMsg.permissions.canForward, false, 'cannot forward');
  dmFile = dmMsg.media.fileId;

  const t = await api('POST', `/files/${dmFile}/token`, { token: P.accessToken });
  eq(t.senderName, A.user.displayName ?? 'Aman', 'sender name for the viewer');
  eq(t.caption, 'Site plan - keep private', 'caption');
  assert(t.sentAt, 'date & time');
  eq(t.screenshotProtection, true, 'screenshots blocked');
  const bytes = Buffer.from(await (await fetch(`${BASE_URL}${t.streamPath}`)).arrayBuffer());
  assert(bytes.equals(png), 'decrypted bytes match the upload');
  const info = await api('GET', `/files/${dmFile}`, { token: P.accessToken });
  eq(info.direct, true, 'file info for direct chats');
});

await step('1-to-1: protected message cannot be forwarded; delete for everyone revokes the file', async () => {
  const s = await connectSocket(A.accessToken);
  await fails(emit(s, 'message:forward', { messageId: dmMsg.id, toUserIds: [P.user.id], clientMsgId: clientId() }), 'FORWARD_NOT_ALLOWED', 'forward');
  await emit(s, 'message:delete', { messageId: dmMsg.id, scope: 'everyone' });
  s.close();
  const err = await api('POST', `/files/${dmFile}/token`, { token: P.accessToken }).catch((e) => e);
  assert(['FILE_REVOKED', 'NOT_FOUND'].includes(err.code), `token after delete refused (got ${err.code})`);
});

// ---------------------------------------------------------------- plans
let free; // user whose trial ended
let owner; // group creator with premium
let group;
let groupFile;
await step('trial active for new accounts; after it ends direct messages need premium', async () => {
  free = await otpUser(`free${stamp}@example.org`, { accountType: 'personal', name: `Free ${stamp}` });
  eq(free.user.subscription.access, 'unclaimed', 'new account waits for "Claim free trial"');
  const s0 = await connectSocket(free.accessToken);
  const e0 = await emit(s0, 'message:send', { toUserId: A.user.id, clientMsgId: clientId(), type: 'text', text: 'hi' }).catch((e) => e);
  s0.close();
  eq(e0.code, 'SUBSCRIPTION_REQUIRED', 'cannot chat before claiming');
  eq(e0.details?.claimTrial, true, 'error asks to claim the trial');
  const claimed = await api('POST', '/subscription/claim-trial', { token: free.accessToken });
  eq(claimed.access, 'trial', 'trial after claim');
  await fails(api('POST', '/subscription/claim-trial', { token: free.accessToken }), 'TRIAL_ALREADY_CLAIMED', 'second claim');
  const st = await api('GET', '/subscription', { token: free.accessToken });
  eq(st.daysLeft, 7, '7 days');
  await admin('/users/access', { user: free.user.id, kind: 'trial', days: 0 });
  const after = await api('GET', '/subscription', { token: free.accessToken });
  eq(after.access, 'locked', 'locked after trial');
  const s = await connectSocket(free.accessToken);
  await fails(emit(s, 'message:send', { toUserId: A.user.id, clientMsgId: clientId(), type: 'text', text: 'hello' }), 'SUBSCRIPTION_REQUIRED', 'dm send');
  s.close();
});

await step('group: locked member cannot reply or open files until the creator allows it', async () => {
  owner = await otpUser(`own${stamp}@example.org`, { accountType: 'business', businessName: `Owner ${stamp}`, businessAddress: 'Lucknow', bio: '' });
  await admin('/users/access', { user: owner.user.id, kind: 'premium', days: 30 });
  const res = await api('POST', '/groups', { token: owner.accessToken, body: { name: `Premium ${stamp}`, invite: { expiry: '7d', maxJoins: 0 } } });
  group = res.group;
  await api('POST', `/invites/${res.invite.code}/join`, { token: free.accessToken, body: {} });
  const sec = await upload(owner.accessToken, { buffer: png, filename: 'g.png', mime: 'image/png', secure: true });
  const s = await connectSocket(owner.accessToken);
  const m = await emit(s, 'group:message:send', {
    groupId: group.id,
    clientMsgId: clientId(),
    type: 'image',
    text: 'Rate card',
    media: { secure: true, secureFileId: sec.secureFileId, mimeType: 'image/png', size: png.length, name: 'g.png' },
    visibility: 'private',
  });
  s.close();
  groupFile = m.media.fileId;

  const d = await api('GET', `/groups/${group.id}`, { token: free.accessToken });
  eq(d.premium.active, true, 'group is premium (creator has premium)');
  eq(d.premium.source, 'owner', 'source');
  eq(d.me.canSend, false, 'cannot reply yet');
  eq(d.me.sendBlockedReason.code, 'SUBSCRIPTION_REQUIRED', 'reason');
  eq(d.me.canOpenProtected, false, 'cannot open files yet');
  const fs = await connectSocket(free.accessToken);
  await fails(emit(fs, 'group:message:send', { groupId: group.id, clientMsgId: clientId(), type: 'text', text: 'hi' }), 'SUBSCRIPTION_REQUIRED', 'group send');
  fs.close();
  await fails(api('POST', `/files/${groupFile}/token`, { token: free.accessToken }), 'SUBSCRIPTION_REQUIRED', 'open file');
});

await step('group: creator enables "members without premium" -> reply and open files work', async () => {
  const d = await api('PATCH', `/groups/${group.id}/settings`, { token: owner.accessToken, body: { members: { freeAccess: true } } });
  eq(d.settings.members.freeAccess, true, 'option saved');
  const me = await api('GET', `/groups/${group.id}`, { token: free.accessToken });
  eq(me.me.canSend, true, 'can reply');
  eq(me.me.canOpenProtected, true, 'can open files');
  const fs = await connectSocket(free.accessToken);
  await emit(fs, 'group:message:send', { groupId: group.id, clientMsgId: clientId(), type: 'text', text: 'Thanks, received' });
  fs.close();
  const t = await api('POST', `/files/${groupFile}/token`, { token: free.accessToken });
  eq(t.senderName, `Owner ${stamp}`.slice(0, 20), 'viewer header shows the sender');
  eq(t.caption, 'Rate card', 'caption');
});

await step('group: creator premium ends -> blocked again; admin approval makes the group premium', async () => {
  await admin('/users/access', { user: owner.user.id, kind: 'premium', days: 0 });
  await admin('/users/access', { user: owner.user.id, kind: 'trial', days: 0 });
  let d = await api('GET', `/groups/${group.id}`, { token: free.accessToken });
  eq(d.premium.active, false, 'no longer premium');
  eq(d.me.canSend, false, 'blocked again');
  await admin('/groups/premium', { group: group.id, approved: true });
  d = await api('GET', `/groups/${group.id}`, { token: free.accessToken });
  eq(d.premium.source, 'approved', 'approved by admin');
  eq(d.me.canSend, true, 'members can reply again');
});

await step('extension request -> admin approves -> own access again', async () => {
  const r = await api('POST', '/subscription/requests', { token: free.accessToken, body: { kind: 'extension', reason: 'Testing', days: 5 } });
  eq(r.status, 'pending', 'pending');
  await fails(api('POST', '/subscription/requests', { token: free.accessToken, body: {} }), 'REQUEST_PENDING', 'second request');
  await admin(`/requests/${r.id}`, { approve: true });
  const st = await api('GET', '/subscription', { token: free.accessToken });
  eq(st.access, 'extended', 'extended');
  eq(st.daysLeft, 5, '5 days');
  const s = await connectSocket(free.accessToken);
  await emit(s, 'message:send', { toUserId: A.user.id, clientMsgId: clientId(), type: 'text', text: 'Back again' });
  s.close();
});

// Test accounts stay out of search.
for (const s of [biz, free, owner].filter(Boolean)) {
  await api('PATCH', '/users/me', { token: s.accessToken, body: { privacy: { searchable: false } } }).catch(() => {});
}
if (group) await api('DELETE', `/groups/${group.id}`, { token: owner.accessToken }).catch(() => {});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
process.exit(passed === results.length ? 0 : 1);
