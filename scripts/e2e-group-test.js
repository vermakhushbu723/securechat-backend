/**
 * End-to-end test of every group feature with 5 real users over real sockets:
 *   npm run test:groups      (server must be running)
 */
import sharp from 'sharp';

import { api, BASE_URL, clientId, connectSocket, emit, expectNoEvent, loginOrRegister, TEST_USERS, waitFor } from './lib/client.js';

// ---------------------------------------------------------------------------
const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32m✔\x1b[0m ${name} \x1b[90m(${Date.now() - started}ms)\x1b[0m`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  \x1b[31m✘ ${name}\x1b[0m\n      ${err.stack?.split('\n').slice(0, 2).join('\n      ') ?? err.message}`);
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
  assert(err, `${what}: expected error ${code}, but it succeeded`);
  eq(err.code, code, `${what} error code`);
  return err;
};
const send = (socket, groupId, p) => emit(socket, 'group:message:send', { groupId, clientMsgId: clientId(), type: 'text', ...p });
async function upload(token, { buffer, filename, mime, kind, duration, secure }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  if (kind) form.append('kind', kind);
  if (duration) form.append('duration', String(duration));
  if (secure) form.append('secure', 'true');
  return api('POST', '/media/upload', { token, form });
}

// ---------------------------------------------------------------------------
console.log(`\nSecureChat GROUP E2E test against ${BASE_URL}\n`);

const PASSWORD = 'Test@12345';
const EXTRA = [
  { name: 'Rahul Kumar', username: 'rahul_test', phone: '+919000000003', password: PASSWORD },
  { name: 'Neha Singh', username: 'neha_test', phone: '+919000000004', password: PASSWORD },
  { name: 'Amit Sharma', username: 'amit_test', phone: '+919000000005', password: PASSWORD },
];
const [A, P, R, N, M] = await Promise.all([...TEST_USERS, ...EXTRA].map(loginOrRegister));
const users = { A, P, R, N, M };
const id = (u) => u.user.id;
const tok = (u) => u.accessToken;
console.log(`  Users: ${Object.values(users).map((u) => u.user.displayName ?? u.user.name).join(', ')}\n`);

// Clean blocks + location settings from earlier runs.
for (const u of Object.values(users)) {
  for (const other of Object.values(users)) if (u !== other) await api('DELETE', `/users/${id(other)}/block`, { token: tok(u) });
  await api('PUT', '/location/settings', { token: tok(u), body: { mode: 'join', intervalMin: 10 } });
}

const s = {};
for (const [k, u] of Object.entries(users)) s[k] = await connectSocket(tok(u));

let g1; // main group (Aman owner)
let g2; // mandatory location group
let g3; // third group for forward chain
let invite1;

console.log('Groups & management');
await step('create group with settings (owner, invite link, system message)', async () => {
  const res = await api('POST', '/groups', {
    token: tok(A),
    body: {
      name: 'Lucknow Business Test',
      description: 'Business updates',
      category: 'Business',
      rules: 'Be respectful. No selling.',
      settings: { location: { requirement: 'optional', visibility: 'groupMembers' }, messages: { messageMode: 'user_select' } },
      invite: { expiry: '7d', maxJoins: 0 },
    },
  });
  g1 = res.group;
  invite1 = res.invite;
  eq(g1.role, 'owner', 'role');
  eq(g1.me.isAdmin, true, 'admin');
  eq(g1.settings.location.requirement, 'optional', 'location setting');
  assert(/^[A-Z]{3}-[A-Z0-9]{6}$/.test(invite1.code), `invite code format ${invite1.code}`);
  assert(invite1.url.endsWith(`/group/${invite1.code}`), 'invite url');
  const { items } = await api('GET', `/groups/${g1.id}/messages`, { token: tok(A) });
  assert(items.some((m) => m.type === 'system' && m.system.event === 'created'), 'created system message');
});

await step('invite preview works without login (no private data)', async () => {
  const res = await fetch(`${BASE_URL}/api/v1/invites/${invite1.code}`);
  const { data } = await res.json();
  eq(data.group.name, 'Lucknow Business Test', 'name');
  eq(data.state, 'Active', 'state');
  eq(data.group.location, 'optional', 'location requirement shown');
  assert(!JSON.stringify(data).includes('+91'), 'no phone numbers');
});

await step('join via invite link -> realtime member joined + system message', async () => {
  const joined = waitFor(s.A, 'group:member:joined', (e) => e.groupId === g1.id && e.userId === id(P));
  const sys = waitFor(s.A, 'group:message:new', (m) => m.groupId === g1.id && m.system?.event === 'joined');
  const res = await api('POST', `/invites/${invite1.code}/join`, { token: tok(P), body: {} });
  eq(res.status, 'active', 'join status');
  await joined;
  await sys;
  const again = await api('POST', `/invites/${invite1.code}/join`, { token: tok(P), body: {} });
  eq(again.alreadyMember, true, 'idempotent join');
});

await step('new member does not see history from before joining', async () => {
  await send(s.A, g1.id, { text: 'Only for early members' });
  const res = await api('POST', `/invites/${invite1.code}/join`, { token: tok(R), body: {} });
  eq(res.status, 'active', 'rahul joined');
  const { items } = await api('GET', `/groups/${g1.id}/messages`, { token: tok(R) });
  assert(!items.some((m) => m.text === 'Only for early members'), 'old message hidden for new member');
});

await step('mandatory location: join refused without location, allowed with it', async () => {
  const res = await api('POST', '/groups', {
    token: tok(A),
    body: { name: 'Field Team Test', settings: { location: { requirement: 'mandatory', shareMode: 'live', visibility: 'groupMembers' } } },
  });
  g2 = res.group;
  await fails(api('POST', `/invites/${res.invite.code}/join`, { token: tok(R), body: {} }), 'LOCATION_REQUIRED', 'join w/o location');
  const ok = await api('POST', `/invites/${res.invite.code}/join`, {
    token: tok(R),
    body: { location: { lat: 26.8467, lng: 80.9462, place: 'Hazratganj, Lucknow' }, shareMode: 'live' },
  });
  eq(ok.status, 'active', 'joined with location');
  const profile = await api('GET', `/groups/${g2.id}/members/${id(R)}`, { token: tok(A) });
  eq(profile.location.place, 'Hazratganj, Lucknow', 'location stored');
  await api('POST', `/invites/${res.invite.code}/join`, { token: tok(P), body: { location: { lat: 26.85, lng: 80.95 } } });
});

await step('approval flow: join request -> admin notified in realtime -> approve', async () => {
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { members: { approveNewMembers: true } } });
  const request = waitFor(s.A, 'group:join_request', (e) => e.groupId === g1.id && e.userId === id(N));
  const res = await api('POST', `/invites/${invite1.code}/join`, { token: tok(N), body: {} });
  eq(res.status, 'pending', 'pending');
  await request;
  const list = await api('GET', `/groups/${g1.id}/requests`, { token: tok(A) });
  assert(list.some((r) => r.userId === id(N)), 'request listed');
  await fails(api('GET', `/groups/${g1.id}/messages`, { token: tok(N) }), 'NOT_MEMBER', 'pending cannot read');
  const joinedEvt = waitFor(s.N, 'group:joined', (e) => e.groupId === g1.id);
  await api('POST', `/groups/${g1.id}/requests/${id(N)}/approve`, { token: tok(A) });
  await joinedEvt;
  const detail = await api('GET', `/groups/${g1.id}`, { token: tok(N) });
  eq(detail.role, 'member', 'neha is member');
});

await step('decline join request (requester notified)', async () => {
  const declined = waitFor(s.M, 'group:request:declined', (e) => e.groupId === g1.id);
  await api('POST', `/invites/${invite1.code}/join`, { token: tok(M), body: {} });
  await api('POST', `/groups/${g1.id}/requests/${id(M)}/decline`, { token: tok(A) });
  await declined;
  const list = await api('GET', `/groups/${g1.id}/requests`, { token: tok(A) });
  assert(!list.some((r) => r.userId === id(M)), 'request removed');
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { members: { approveNewMembers: false } } });
});

await step('invite links: max joins, revoke, reset', async () => {
  const one = await api('POST', `/groups/${g2.id}/invites`, { token: tok(A), body: { expiry: '1h', maxJoins: 1, requireApproval: false } });
  await api('POST', `/invites/${one.code}/join`, { token: tok(N), body: { location: { lat: 26.9, lng: 80.9 } } });
  await fails(api('POST', `/invites/${one.code}/join`, { token: tok(M), body: { location: { lat: 26.9, lng: 80.9 } } }), 'INVITE_FULL', 'second join');
  const two = await api('POST', `/groups/${g2.id}/invites`, { token: tok(A), body: { expiry: 'never', maxJoins: 0, requireApproval: false } });
  await api('DELETE', `/groups/${g2.id}/invites/${two.code}`, { token: tok(A) });
  await fails(api('POST', `/invites/${two.code}/join`, { token: tok(M), body: { location: { lat: 1, lng: 1 } } }), 'INVITE_REVOKED', 'revoked link');
  const fresh = await api('POST', `/groups/${g2.id}/invites/reset`, { token: tok(A), body: { expiry: '24h', maxJoins: 100, requireApproval: false } });
  const links = await api('GET', `/groups/${g2.id}/invites`, { token: tok(A) });
  assert(links.filter((l) => l.state === 'Active').length === 1 && links[0].code === fresh.code, 'only the new link is active');
  await fails(api('POST', `/groups/${g2.id}/invites`, { token: tok(R), body: {} }), 'ADMIN_ONLY', 'member cannot create links');
});

await step('members list + member profile show display names only', async () => {
  const members = await api('GET', `/groups/${g1.id}/members`, { token: tok(P) });
  eq(members.length, 4, 'member count');
  eq(members[0].isMe, true, 'me first');
  assert(members.some((m) => m.role === 'owner' && m.displayName === 'Aman'), 'owner display name');
  const raw = JSON.stringify(members);
  assert(!raw.includes('+91') && !raw.includes('@') && !raw.includes('Verma'), 'no phone / email / full name');
  const prof = await api('GET', `/groups/${g1.id}/members/${id(R)}`, { token: tok(P) });
  eq(prof.displayName, 'Rahul', 'display name');
  eq(prof.canManage, false, 'regular member cannot manage');
});

await step('make admin / remove admin (system messages, member updated event)', async () => {
  const upd = waitFor(s.R, 'group:member:updated', (e) => e.userId === id(P) && e.role === 'admin');
  await api('PATCH', `/groups/${g1.id}/members/${id(P)}`, { token: tok(A), body: { role: 'admin' } });
  await upd;
  const settings = await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(P), body: { messages: { membersCanEditInfo: false } } });
  eq(settings.settings.messages.membersCanEditInfo, false, 'new admin can change settings');
  await fails(api('PATCH', `/groups/${g1.id}/members/${id(A)}`, { token: tok(P), body: { role: 'member' } }), 'FORBIDDEN', 'admin cannot demote creator');
  await api('PATCH', `/groups/${g1.id}/members/${id(P)}`, { token: tok(A), body: { role: 'member' } });
  const { items } = await api('GET', `/groups/${g1.id}/messages`, { token: tok(A) });
  assert(items.some((m) => m.system?.event === 'promoted') && items.some((m) => m.system?.event === 'demoted'), 'system messages');
});

await step('restrict member (read only) blocks sending, unrestrict restores', async () => {
  await api('PATCH', `/groups/${g1.id}/members/${id(R)}`, { token: tok(A), body: { restricted: true } });
  await fails(send(s.R, g1.id, { text: 'hello' }), 'RESTRICTED', 'restricted send');
  await api('PATCH', `/groups/${g1.id}/members/${id(R)}`, { token: tok(A), body: { restricted: false } });
  assert((await send(s.R, g1.id, { text: 'I can talk again' })).id, 'send after unrestrict');
});

await step('who can send = admins only / mute group', async () => {
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { messages: { whoCanSend: 'admins' } } });
  await fails(send(s.P, g1.id, { text: 'hi' }), 'ADMINS_ONLY', 'member send');
  assert((await send(s.A, g1.id, { text: 'Admin announcement' })).id, 'admin can send');
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { messages: { whoCanSend: 'all' }, members: { muteGroup: true } } });
  await fails(send(s.P, g1.id, { text: 'hi' }), 'ADMINS_ONLY', 'muted group');
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { members: { muteGroup: false } } });
});

await step('members can send media = off', async () => {
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { messages: { membersCanSendMedia: false } } });
  const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#f00' } }).png().toBuffer();
  const media = await upload(tok(P), { buffer: png, filename: 'x.png', mime: 'image/png' });
  await fails(send(s.P, g1.id, { type: 'image', media }), 'MEDIA_DISABLED', 'member media');
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { messages: { membersCanSendMedia: true } } });
});

await step('restrict new members (read only for 24h)', async () => {
  const res = await api('POST', '/groups', { token: tok(M), body: { name: 'Newbie Test', settings: { members: { restrictNewMembers: true } } } });
  await api('POST', `/invites/${res.invite.code}/join`, { token: tok(N), body: {} });
  await fails(send(s.N, res.group.id, { text: 'hello' }), 'NEW_MEMBER_RESTRICTED', 'new member');
  const d = await api('GET', `/groups/${res.group.id}`, { token: tok(N) });
  eq(d.me.canSend, false, 'canSend flag');
  eq(d.me.sendBlockedReason.code, 'NEW_MEMBER_RESTRICTED', 'reason');
  await api('DELETE', `/groups/${res.group.id}`, { token: tok(M) });
});

await step('edit group info: admins only unless members can edit', async () => {
  await fails(api('PATCH', `/groups/${g1.id}`, { token: tok(P), body: { description: 'x' } }), 'ADMIN_ONLY', 'member edit');
  const upd = waitFor(s.P, 'group:updated', (e) => e.groupId === g1.id);
  await api('PATCH', `/groups/${g1.id}`, { token: tok(A), body: { name: 'Lucknow Business Community Test' } });
  await upd;
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { messages: { membersCanEditInfo: true } } });
  const d = await api('PATCH', `/groups/${g1.id}`, { token: tok(P), body: { description: 'Edited by member' } });
  eq(d.description, 'Edited by member', 'member edit allowed');
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { messages: { membersCanEditInfo: false } } });
});

await step('group list filters, stats, pin / mute / archive', async () => {
  const created = await api('GET', '/groups?filter=created', { token: tok(A) });
  assert(created.some((g) => g.id === g1.id) && created.every((g) => g.role === 'owner'), 'created filter');
  const joined = await api('GET', '/groups?filter=joined', { token: tok(R) });
  assert(joined.some((g) => g.id === g1.id), 'joined filter');
  const loc = await api('GET', '/groups?filter=location', { token: tok(R) });
  assert(loc.some((g) => g.id === g2.id), 'location filter');
  await api('PATCH', `/groups/${g1.id}/me`, { token: tok(R), body: { pinned: true, muteSeconds: -1 } });
  const muted = await api('GET', '/groups?filter=muted', { token: tok(R) });
  assert(muted.some((g) => g.id === g1.id && g.pinned), 'muted + pinned');
  const all = await api('GET', '/groups', { token: tok(R) });
  eq(all[0].id, g1.id, 'pinned first');
  await api('PATCH', `/groups/${g1.id}/me`, { token: tok(R), body: { archived: true } });
  const archived = await api('GET', '/groups?filter=archived', { token: tok(R) });
  assert(archived.some((g) => g.id === g1.id && !g.pinned), 'archived (unpinned)');
  await api('PATCH', `/groups/${g1.id}/me`, { token: tok(R), body: { archived: false, muteSeconds: 0 } });
  const stats = await api('GET', '/groups/stats', { token: tok(R) });
  assert(stats.groups >= 2 && typeof stats.unread === 'number', 'stats');
});

console.log('\nRealtime messaging');
let textMsg;
await step('text message realtime to every member (display name, no phone)', async () => {
  const cmid = clientId();
  const got = Promise.all([s.P, s.R, s.N].map((sock) => waitFor(sock, 'group:message:new', (m) => m.clientMsgId === cmid)));
  textMsg = await emit(s.A, 'group:message:send', { groupId: g1.id, clientMsgId: cmid, type: 'text', text: 'Hello team 👋' });
  const [p] = await got;
  eq(p.senderName, 'Aman', 'sender display name');
  eq(p.visibility, 'public', 'visibility');
  eq(textMsg.status, 'sent', 'sender tick');
  assert(!JSON.stringify(p).includes('+91'), 'no phone');
});

await step('typing & recording indicator to other members', async () => {
  const t = waitFor(s.A, 'group:typing', (e) => e.groupId === g1.id && e.userId === id(P) && e.isTyping);
  const quiet = expectNoEvent(s.P, 'group:typing', (e) => e.userId === id(P));
  await emit(s.P, 'group:typing', { groupId: g1.id, isTyping: true });
  await t;
  assert(await quiet, 'sender does not get own typing');
  const rec = waitFor(s.A, 'group:typing', (e) => e.kind === 'recording');
  await emit(s.P, 'group:typing', { groupId: g1.id, isTyping: true, kind: 'recording' });
  await rec;
});

await step('delivered + read pointers -> sender gets ✓✓ then blue ✓✓', async () => {
  const delivered = waitFor(s.A, 'group:status', (e) => e.groupId === g1.id && e.deliveredUpTo >= textMsg.id);
  for (const u of [P, R, N]) await emit(s[Object.keys(users).find((k) => users[k] === u)], 'group:delivered', { groupId: g1.id, upToMessageId: textMsg.id });
  await delivered;
  const read = waitFor(s.A, 'group:status', (e) => e.groupId === g1.id && e.readUpTo >= textMsg.id);
  await emit(s.P, 'group:read', { groupId: g1.id, upToMessageId: textMsg.id });
  await emit(s.R, 'group:read', { groupId: g1.id, upToMessageId: textMsg.id });
  const res = await emit(s.N, 'group:read', { groupId: g1.id, upToMessageId: textMsg.id });
  eq(res.unreadCount, 0, 'unread cleared');
  await read;
  const msg = await api('GET', `/group-messages/${textMsg.id}`, { token: tok(A) });
  eq(msg.status, 'read', 'read status for sender');
});

await step('message info: read by / delivered / pending', async () => {
  const m = await send(s.A, g1.id, { text: 'Info check' });
  await emit(s.P, 'group:read', { groupId: g1.id, upToMessageId: m.id });
  await emit(s.R, 'group:delivered', { groupId: g1.id, upToMessageId: m.id });
  const info = await api('GET', `/group-messages/${m.id}/info`, { token: tok(A) });
  assert(info.readBy.some((x) => x.userId === id(P)), 'priya read');
  assert(info.deliveredTo.some((x) => x.userId === id(R)), 'rahul delivered');
  assert(info.pending.some((x) => x.userId === id(N)) || info.deliveredTo.some((x) => x.userId === id(N)), 'neha pending/delivered');
  const other = await api('GET', `/group-messages/${m.id}/info`, { token: tok(R) });
  eq(other.receiptsVisible, false, 'receipts only for sender/admins');
});

await step('content filter blocks numbers, number words, links, contacts, abuse (+warnings)', async () => {
  const cases = [
    ['Call me 9876543210', 'numbers'],
    ['My number is nine eight seven', 'numberWords'],
    ['T H R E E two one', 'numberWords'],
    ['Visit www.example.com', 'links'],
    ['ping me on whatsapp', 'externalContact'],
    ['mail me test@example.org', 'personalInfo'],
    ['you idiot', 'abuse'],
    ['buy now buy now buy now', 'spam'],
  ];
  let last = 0;
  for (const [text, rule] of cases) {
    const err = await fails(send(s.P, g1.id, { text }), 'CONTENT_BLOCKED', text);
    eq(err.details.rule, rule, `rule for "${text}"`);
    assert(err.details.warnings > last, 'warning counter increments');
    last = err.details.warnings;
  }
});

await step('group content rules: numbers allowed when turned off, abuse still global', async () => {
  const rules = ['numberWords', 'spam', 'links', 'personalInfo', 'externalContact'];
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { contentRules: rules } });
  assert((await send(s.P, g1.id, { text: 'Meeting at 5' })).id, 'digits allowed');
  const err = await fails(send(s.P, g1.id, { text: 'stupid idea' }), 'CONTENT_BLOCKED', 'abuse');
  eq(err.details.rule, 'abuse', 'global abuse rule');
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { contentRules: [...rules, 'numbers', 'abuse'] } });
});

await step('privacy levels: private / highly protected, group message mode override', async () => {
  const priv = await send(s.A, g1.id, { text: 'Confidential plan', visibility: 'private' });
  eq(priv.visibility, 'private', 'private');
  eq(priv.permissions.canForward, false, 'no forward');
  eq(priv.permissions.allowDownload, false, 'no download');
  const high = await send(s.A, g1.id, { text: 'Top secret', visibility: 'highly_protected' });
  eq(high.permissions.watermark, true, 'watermark');
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { messages: { messageMode: 'private' } } });
  const forced = await send(s.P, g1.id, { text: 'I chose public', visibility: 'public' });
  eq(forced.visibility, 'private', 'group mode forces private');
  await api('PATCH', `/groups/${g1.id}/settings`, { token: tok(A), body: { messages: { messageMode: 'user_select' } } });
});

await step('reply with quoted message', async () => {
  const cmid = clientId();
  const got = waitFor(s.A, 'group:message:new', (m) => m.clientMsgId === cmid);
  await emit(s.P, 'group:message:send', { groupId: g1.id, clientMsgId: cmid, type: 'text', text: 'Replying!', replyToId: textMsg.id });
  const m = await got;
  eq(m.replyTo.id, textMsg.id, 'reply id');
  eq(m.replyTo.senderName, 'Aman', 'reply sender');
});

let secureMsg;
let securePng;
await step('public image, voice, document, location, contact messages', async () => {
  const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#3366ff' } }).png().toBuffer();
  const img = await upload(tok(A), { buffer: png, filename: 'photo.png', mime: 'image/png' });
  const im = await send(s.A, g1.id, { type: 'image', text: 'Team photo', media: img });
  eq(im.media.secure, false, 'public media has url');
  const voice = await upload(tok(P), { buffer: Buffer.alloc(3000, 1), filename: 'v.m4a', mime: 'audio/mp4', kind: 'voice', duration: 4 });
  eq((await send(s.P, g1.id, { type: 'voice', media: voice })).type, 'voice', 'voice');
  const doc = await upload(tok(A), { buffer: Buffer.from('%PDF-1.4 x'), filename: 'Agenda.pdf', mime: 'application/pdf' });
  eq((await send(s.A, g1.id, { type: 'file', media: doc })).media.name, 'Agenda.pdf', 'doc');
  eq((await send(s.R, g1.id, { type: 'location', location: { lat: 26.84, lng: 80.94, name: 'Office' } })).location.name, 'Office', 'location');
  eq((await send(s.N, g1.id, { type: 'contact', contact: { name: 'Pooja', phone: '+91 00000 11111' } })).contact.name, 'Pooja', 'contact');
});

await step('protected file: encrypted upload, no URL, token-only secure stream', async () => {
  securePng = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#aa2255' } }).png().toBuffer();
  const media = await upload(tok(A), { buffer: securePng, filename: 'Pricing_Q4.png', mime: 'image/png', secure: true });
  eq(media.secure, true, 'secure upload');
  eq(media.url, null, 'no public url');
  const cmid = clientId();
  const got = waitFor(s.P, 'group:message:new', (m) => m.clientMsgId === cmid);
  secureMsg = await emit(s.A, 'group:message:send', { groupId: g1.id, clientMsgId: cmid, type: 'image', media, visibility: 'private' });
  const seen = await got;
  eq(seen.media.secure, true, 'member sees secure media');
  assert(!seen.media.url, 'member gets no url');
  const t = await api('POST', `/files/${seen.media.fileId}/token`, { token: tok(P) });
  eq(t.watermark.name, 'Priya', 'watermark viewer name');
  const res = await fetch(`${BASE_URL}${t.streamPath}`);
  eq(res.status, 200, 'stream ok');
  eq(res.headers.get('cache-control'), 'no-store, private, max-age=0', 'no-store');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert(bytes.equals(securePng), 'decrypted bytes equal original');
  const bad = await fetch(`${BASE_URL}/api/v1/files/stream?token=nope`);
  eq(bad.status, 401, 'bad token rejected');
  const outsider = await fails(api('POST', `/files/${seen.media.fileId}/token`, { token: tok(M) }), 'NOT_MEMBER', 'non-member token');
  assert(outsider, 'outsider denied');
});

await step('protected content cannot be sent as a public URL', async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer();
  const media = await upload(tok(A), { buffer: png, filename: 'x.png', mime: 'image/png' });
  await fails(send(s.A, g1.id, { type: 'image', media, visibility: 'private' }), 'SECURE_UPLOAD_REQUIRED', 'private + public url');
});

await step('file permissions (admins only) + access log', async () => {
  await api('PATCH', `/files/${secureMsg.media.fileId}/permissions`, { token: tok(A), body: { whoCanView: 'admins', accessExpiry: '24h', allowDownload: true } });
  const info = await api('GET', `/files/${secureMsg.media.fileId}`, { token: tok(A) });
  eq(info.permissions.whoCanView, 'admins', 'admins only');
  eq(info.permissions.allowDownload, false, 'download still blocked for private');
  await fails(api('POST', `/files/${secureMsg.media.fileId}/token`, { token: tok(R) }), 'ADMINS_ONLY', 'member blocked');
  await api('POST', `/files/${secureMsg.media.fileId}/events`, { token: tok(P), body: { action: 'download_blocked' } });
  const log = await api('GET', `/files/${secureMsg.media.fileId}/access-log`, { token: tok(A) });
  const actions = log.map((l) => l.action);
  assert(actions.includes('viewed') && actions.includes('download_blocked') && actions.includes('denied') && actions.includes('uploaded'), `log actions ${actions}`);
  await fails(api('GET', `/files/${secureMsg.media.fileId}/access-log`, { token: tok(R) }), 'FORBIDDEN', 'member cannot read log');
});

await step('view once: withheld for members, opens exactly once', async () => {
  const cmid = clientId();
  const got = waitFor(s.P, 'group:message:new', (m) => m.clientMsgId === cmid);
  const mine = await emit(s.A, 'group:message:send', { groupId: g1.id, clientMsgId: cmid, type: 'text', text: 'Secret code word', visibility: 'private', expiry: 'view_once' });
  eq(mine.text, 'Secret code word', 'sender sees own text');
  const seen = await got;
  eq(seen.withheld, true, 'withheld');
  eq(seen.text, '', 'no text in realtime payload');
  const opened = await api('POST', `/group-messages/${seen.id}/open`, { token: tok(P) });
  eq(opened.text, 'Secret code word', 'revealed once');
  await fails(api('POST', `/group-messages/${seen.id}/open`, { token: tok(P) }), 'ALREADY_OPENED', 'second open');
  const after = await api('GET', `/group-messages/${seen.id}`, { token: tok(P) });
  eq(after.withheldReason, 'opened', 'shows opened');
});

await step('message expiry (24h option) wipes content + revokes file', async () => {
  const media = await upload(tok(A), { buffer: securePng, filename: 'temp.png', mime: 'image/png', secure: true });
  const m = await send(s.A, g1.id, { type: 'image', media, visibility: 'private', expiry: '24h' });
  assert(m.permissions.expiresAt, 'expiresAt set');
  // Fast-forward: move expiry to the past and run the sweeper the worker runs every minute.
  const { connectMongo, disconnectMongo } = await import('../src/db/mongo.js');
  const { GroupMessage } = await import('../src/modules/groups/groupMessage.model.js');
  const { expireMessages } = await import('../src/modules/groups/groupMessage.service.js');
  await connectMongo();
  await GroupMessage.updateOne({ _id: m.id }, { $set: { 'permissions.expiresAt': new Date(Date.now() - 1000) } });
  assert((await expireMessages()) >= 1, 'sweeper expired messages');
  await disconnectMongo();
  const after = await api('GET', `/group-messages/${m.id}`, { token: tok(P) });
  eq(after.expired, true, 'expired');
  eq(after.media, null, 'content wiped');
  await fails(api('POST', `/files/${media.secureFileId}/token`, { token: tok(P) }), 'FILE_REVOKED', 'file revoked');
});

await step('edit (content re-checked), reactions, star', async () => {
  const m = await send(s.P, g1.id, { text: 'Draft text' });
  const upd = waitFor(s.A, 'group:message:updated', (e) => e.id === m.id && e.edited);
  await emit(s.P, 'group:message:edit', { messageId: m.id, text: 'Final text' });
  await upd;
  await fails(emit(s.P, 'group:message:edit', { messageId: m.id, text: 'call 12345' }), 'CONTENT_BLOCKED', 'edit filtered');
  await fails(emit(s.R, 'group:message:edit', { messageId: m.id, text: 'hack' }), 'FORBIDDEN', 'edit others');
  const react = waitFor(s.P, 'group:message:updated', (e) => e.id === m.id && e.reactions.some((r) => r.emoji === '❤️'));
  await emit(s.A, 'group:message:react', { messageId: m.id, emoji: '❤️' });
  await react;
  await emit(s.R, 'group:message:star', { messageId: m.id, starred: true });
  const starred = await api('GET', '/group-messages/starred', { token: tok(R) });
  assert(starred.some((x) => x.id === m.id && x.groupName), 'starred list');
});

let original;
let copyInG2;
let copyInG3;
await step('forward public message (chain linked), private blocked, private-mode target blocked', async () => {
  const g3res = await api('POST', '/groups', { token: tok(R), body: { name: 'Sales North Test' } });
  g3 = g3res.group;
  await api('POST', `/invites/${g3res.invite.code}/join`, { token: tok(N), body: {} });
  original = await send(s.A, g1.id, { text: 'Offer valid this week' });
  const got = waitFor(s.P, 'group:message:new', (m) => m.groupId === g2.id && m.forwarded);
  [copyInG2] = await emit(s.R, 'group:message:forward', { messageIds: [original.id], toGroupIds: [g2.id], clientMsgId: clientId() });
  eq(copyInG2.forwarded, true, 'forwarded flag');
  eq(copyInG2.forwardDepth, 1, 'depth 1');
  await got;
  [copyInG3] = await emit(s.R, 'group:message:forward', { messageIds: [copyInG2.id], toGroupIds: [g3.id], clientMsgId: clientId() });
  eq(copyInG3.forwardDepth, 2, 'depth 2');
  const priv = await send(s.A, g1.id, { text: 'Private note', visibility: 'private' });
  await fails(emit(s.P, 'group:message:forward', { messageIds: [priv.id], toGroupIds: [g2.id], clientMsgId: clientId() }), 'FORWARD_NOT_ALLOWED', 'private forward');
  await api('PATCH', `/groups/${g3.id}/settings`, { token: tok(R), body: { messages: { messageMode: 'private' } } });
  await fails(emit(s.R, 'group:message:forward', { messageIds: [original.id], toGroupIds: [g3.id], clientMsgId: clientId() }), 'FORWARD_NOT_ALLOWED', 'private-only group');
  await api('PATCH', `/groups/${g3.id}/settings`, { token: tok(R), body: { messages: { messageMode: 'user_select' } } });
});

await step('forward chain tree + forwarded message details', async () => {
  const chain = await api('GET', `/group-messages/${original.id}/chain`, { token: tok(A) });
  eq(chain.totals.forwards, 2, 'forwards');
  eq(chain.totals.groups, 3, 'groups');
  eq(chain.tree.children[0].children[0].to, 'Sales North Test', 'A -> B -> C');
  assert(chain.totals.usersReached >= 3, 'users reached');
  const d = await api('GET', `/group-messages/${copyInG3.id}/forward-details`, { token: tok(N) });
  eq(d.origin.senderName, 'Aman', 'original sender');
  eq(d.origin.groupName, 'Lucknow Business Community Test', 'original group');
  eq(d.copy.level, 2, 'level');
  eq(d.copy.forwardedBy, 'Rahul', 'forwarded by');
});

await step('delete middle copy for everyone -> copy + downstream removed, original stays', async () => {
  const preview = await api('GET', `/group-messages/${copyInG2.id}/delete-preview`, { token: tok(R) });
  eq(preview.isOriginal, false, 'middle copy');
  eq(preview.copiesAffected, 2, 'copy + downstream');
  const inG3 = waitFor(s.N, 'group:message:updated', (m) => m.id === copyInG3.id && m.deleted);
  const res = await emit(s.R, 'group:message:delete', { messageId: copyInG2.id, scope: 'everyone', chain: true });
  eq(res.deleted, 2, 'deleted count');
  await inG3;
  const orig = await api('GET', `/group-messages/${original.id}`, { token: tok(A) });
  eq(orig.deleted, false, 'original still active');
  const status = await api('GET', `/group-messages/${copyInG2.id}/deletion`, { token: tok(R) });
  eq(status.copiesRemoved, 2, 'copies removed');
  assert(status.locations.some((l) => l.status === 'Active' && l.label.startsWith('Original')), 'original location active');
});

await step('delete original for everyone -> whole chain removed (realtime in every group)', async () => {
  const again = await send(s.A, g1.id, { text: 'Chain root' });
  const [c1] = await emit(s.P, 'group:message:forward', { messageIds: [again.id], toGroupIds: [g2.id], clientMsgId: clientId() });
  const [c2] = await emit(s.R, 'group:message:forward', { messageIds: [c1.id], toGroupIds: [g3.id], clientMsgId: clientId() });
  const events = Promise.all([
    waitFor(s.P, 'group:message:updated', (m) => m.id === c1.id && m.deleted),
    waitFor(s.N, 'group:message:updated', (m) => m.id === c2.id && m.deleted),
  ]);
  const res = await emit(s.A, 'group:message:delete', { messageId: again.id, scope: 'everyone', chain: true });
  eq(res.deleted, 3, 'all copies');
  eq(res.groups, 3, 'three groups');
  await events;
  const st = await api('GET', `/group-messages/${again.id}/deletion`, { token: tok(A) });
  eq(st.statusFlow[2], 'LINKED COPIES DELETED', 'status flow');
});

await step('delete permissions: members cannot delete others, admins can (moderation)', async () => {
  const m = await send(s.P, g1.id, { text: 'Member message' });
  await fails(emit(s.R, 'group:message:delete', { messageId: m.id, scope: 'everyone' }), 'FORBIDDEN', 'member deletes other');
  const res = await emit(s.A, 'group:message:delete', { messageId: m.id, scope: 'everyone' });
  eq(res.deleted, 1, 'admin deleted');
  const after = await api('GET', `/group-messages/${m.id}`, { token: tok(P) });
  eq(after.deletedReason, 'admin', 'reason admin');
});

await step('delete for me hides only for me', async () => {
  const m = await send(s.A, g1.id, { text: 'Hide for Priya' });
  const removed = waitFor(s.P, 'group:message:removed', (e) => e.messageId === m.id);
  await emit(s.P, 'group:message:delete', { messageId: m.id, scope: 'me' });
  await removed;
  const mine = await api('GET', `/groups/${g1.id}/messages?limit=10`, { token: tok(P) });
  assert(!mine.items.some((x) => x.id === m.id), 'hidden for priya');
  const others = await api('GET', `/groups/${g1.id}/messages?limit=10`, { token: tok(R) });
  assert(others.items.some((x) => x.id === m.id), 'visible for rahul');
});

await step('search with filters + media gallery kinds', async () => {
  const hits = await api('GET', `/groups/${g1.id}/search?q=Hello`, { token: tok(P) });
  assert(hits.some((m) => m.id === textMsg.id), 'text search');
  const photos = await api('GET', `/groups/${g1.id}/search?filter=photos`, { token: tok(P) });
  assert(photos.length && photos.every((m) => m.type === 'image'), 'photos filter');
  const protectedHits = await api('GET', `/groups/${g1.id}/search?filter=protected`, { token: tok(P) });
  assert(protectedHits.length && protectedHits.every((m) => m.visibility !== 'public'), 'protected filter');
  const docs = await api('GET', `/groups/${g1.id}/media?kind=docs`, { token: tok(P) });
  assert(docs.some((m) => m.media?.name === 'Agenda.pdf'), 'docs gallery');
  const prot = await api('GET', `/groups/${g1.id}/media?kind=protected`, { token: tok(A) });
  assert(prot.some((m) => m.id === secureMsg.id), 'protected gallery');
});

await step('block member: blocker stops receiving their messages', async () => {
  await api('POST', `/users/${id(R)}/block`, { token: tok(N) });
  const cmid = clientId();
  const quiet = expectNoEvent(s.N, 'group:message:new', (m) => m.clientMsgId === cmid);
  const toPriya = waitFor(s.P, 'group:message:new', (m) => m.clientMsgId === cmid);
  await emit(s.R, 'group:message:send', { groupId: g1.id, clientMsgId: cmid, type: 'text', text: 'Hi all' });
  await toPriya;
  assert(await quiet, 'neha did not receive');
  const hist = await api('GET', `/groups/${g1.id}/messages?limit=5`, { token: tok(N) });
  assert(!hist.items.some((m) => m.senderId === id(R)), 'history hides blocked member');
  await api('DELETE', `/users/${id(R)}/block`, { token: tok(N) });
});

await step('report message and member -> My reports', async () => {
  await api('POST', '/reports', { token: tok(P), body: { type: 'message', messageId: textMsg.id, reasons: ['Spam or misleading'], details: 'test' } });
  await api('POST', '/reports', { token: tok(P), body: { type: 'user', userId: id(R), groupId: g1.id, reasons: ['Harassment or bullying'] } });
  await api('POST', '/reports', { token: tok(P), body: { type: 'group', groupId: g1.id, reasons: ['Something else'] } });
  const mine = await api('GET', '/reports/mine', { token: tok(P) });
  assert(mine.filter((r) => ['message', 'user', 'group'].includes(r.type)).length >= 3, 'reports listed');
  eq(mine.find((r) => r.type === 'message').groupName, 'Lucknow Business Community Test', 'report group');
});

console.log('\nLocation');
await step('live location update reaches members + members location view', async () => {
  await api('PUT', '/location/settings', { token: tok(R), body: { mode: 'live', intervalMin: 5, liveForMinutes: 60 } });
  const evt = waitFor(s.P, 'group:location', (e) => e.groupId === g2.id && e.userId === id(R));
  const up = await api('POST', '/location/update', { token: tok(R), body: { lat: 26.86, lng: 80.95, place: 'Gomti Nagar', source: 'live' } });
  eq(up.mode, 'live', 'live mode');
  const e = await evt;
  eq(e.status, 'Live', 'live status');
  const locs = await api('GET', `/groups/${g2.id}/locations`, { token: tok(P) });
  eq(locs.allowed, true, 'visible to members');
  assert(locs.members.find((m) => m.userId === id(R)).place === 'Gomti Nagar', 'place');
  assert(locs.counts.live >= 1, 'live count');
  const me = await api('GET', '/location/me', { token: tok(R) });
  assert(me.groups.some((g) => g.groupId === g2.id), 'groups using my location');
  const hist = await api('GET', '/location/history?range=today', { token: tok(R) });
  assert(hist.items.length >= 2 && hist.items.some((h) => h.source === 'join'), 'history');
});

await step('location visibility admin only / location off', async () => {
  await api('PATCH', `/groups/${g2.id}/settings`, { token: tok(A), body: { location: { visibility: 'adminOnly' } } });
  const member = await api('GET', `/groups/${g2.id}/locations`, { token: tok(P) });
  eq(member.allowed, false, 'hidden for members');
  const admin = await api('GET', `/groups/${g2.id}/locations`, { token: tok(A) });
  eq(admin.allowed, true, 'admin sees');
  await api('PUT', '/location/settings', { token: tok(R), body: { mode: 'none', intervalMin: 10 } });
  const off = await api('GET', `/groups/${g2.id}/locations`, { token: tok(A) });
  eq(off.members.find((m) => m.userId === id(R)).status, 'Off', 'off after disabling');
  await fails(api('POST', '/location/update', { token: tok(R), body: { lat: 1, lng: 1 } }), 'LOCATION_OFF', 'update while off');
  await api('DELETE', '/location/history', { token: tok(R) });
});

console.log('\nMembership lifecycle');
await step('offline member: messages delivered on reconnect', async () => {
  s.N.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  const m = await send(s.A, g1.id, { text: 'While Neha is offline' });
  const status = waitFor(s.A, 'group:status', (e) => e.groupId === g1.id && e.deliveredUpTo >= m.id, 10_000);
  for (const k of ['P', 'R']) await emit(s[k], 'group:delivered', { groupId: g1.id, upToMessageId: m.id });
  s.N = await connectSocket(tok(N));
  await status;
});

await step('remove member -> removed user notified, loses access, system message', async () => {
  const gone = waitFor(s.N, 'group:removed', (e) => e.groupId === g1.id && e.reason === 'removed');
  const sys = waitFor(s.P, 'group:message:new', (m) => m.system?.event === 'removed');
  await api('DELETE', `/groups/${g1.id}/members/${id(N)}`, { token: tok(A) });
  await gone;
  await sys;
  await fails(api('GET', `/groups/${g1.id}/messages`, { token: tok(N) }), 'NOT_MEMBER', 'no access');
  const quiet = expectNoEvent(s.N, 'group:message:new', (m) => m.groupId === g1.id);
  await send(s.A, g1.id, { text: 'After removal' });
  assert(await quiet, 'removed user gets no messages');
});

await step('leave group; owner leaving transfers ownership', async () => {
  await api('POST', `/groups/${g1.id}/leave`, { token: tok(R) });
  await fails(api('GET', `/groups/${g1.id}`, { token: tok(R) }), 'NOT_MEMBER', 'left');
  await api('PATCH', `/groups/${g2.id}/members/${id(P)}`, { token: tok(A), body: { role: 'admin' } });
  await api('POST', `/groups/${g2.id}/leave`, { token: tok(A) });
  const d = await api('GET', `/groups/${g2.id}`, { token: tok(P) });
  eq(d.role, 'owner', 'admin became owner');
});

await step('delete group (creator only) -> every member notified', async () => {
  await fails(api('DELETE', `/groups/${g1.id}`, { token: tok(P) }), 'OWNER_ONLY', 'member delete');
  const gone = waitFor(s.P, 'group:removed', (e) => e.groupId === g1.id && e.reason === 'deleted');
  await api('DELETE', `/groups/${g1.id}`, { token: tok(A) });
  await gone;
  await fails(api('GET', `/groups/${g1.id}`, { token: tok(A) }), 'NOT_FOUND', 'group gone');
  await api('DELETE', `/groups/${g2.id}`, { token: tok(P) });
  await api('DELETE', `/groups/${g3.id}`, { token: tok(R) });
});

for (const sock of Object.values(s)) sock.disconnect();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}\n`);
process.exit(failed.length ? 1 : 0);
