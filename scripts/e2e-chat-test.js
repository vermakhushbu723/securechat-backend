/**
 * End-to-end test of every 1-to-1 chat feature with two real users over
 * real sockets:  npm run test:e2e   (server must be running)
 */
import sharp from 'sharp';

import { api, BASE_URL, clientId, connectSocket, emit, expectNoEvent, loginOrRegister, TEST_USERS, waitFor } from './lib/client.js';

// ---------------------------------------------------------------------------
// Mini test runner
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
    console.log(`  \x1b[31m✘ ${name}\x1b[0m\n      ${err.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}
const eq = (a, b, what) => assert(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

async function upload(token, { buffer, filename, mime, kind, duration }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  if (kind) form.append('kind', kind);
  if (duration) form.append('duration', String(duration));
  return api('POST', '/media/upload', { token, form });
}

// ---------------------------------------------------------------------------
console.log(`\nSecureChat 1-to-1 E2E test against ${BASE_URL}\n`);

const [A, B] = await Promise.all(TEST_USERS.map(loginOrRegister));
const aId = A.user.id;
const bId = B.user.id;
const tokA = A.accessToken;
const tokB = B.accessToken;
console.log(`  Users: ${A.user.name} (${aId})  <->  ${B.user.name} (${bId})\n`);

// Clean state from previous runs.
await api('DELETE', `/users/${bId}/block`, { token: tokA });
await api('DELETE', `/users/${aId}/block`, { token: tokB });

let sA;
let sB;
let conv;
let textMsg;
let imageMsg;

console.log('Auth & users');
await step('refresh token rotation + reuse detection', async () => {
  const fresh = await api('POST', '/auth/login', { body: { identifier: TEST_USERS[0].username, password: TEST_USERS[0].password } });
  const rotated = await api('POST', '/auth/refresh', { body: { refreshToken: fresh.refreshToken } });
  assert(rotated.accessToken && rotated.refreshToken !== fresh.refreshToken, 'new token pair issued');
  const reuse = await api('POST', '/auth/refresh', { body: { refreshToken: fresh.refreshToken } }).catch((e) => e);
  eq(reuse.status, 401, 'reused refresh token rejected');
});
await step('OTP login (request + verify)', async () => {
  const { devCode } = await api('POST', '/auth/otp/request', { body: { phone: TEST_USERS[1].phone } });
  assert(/^\d{6}$/.test(devCode), 'dev code returned');
  const bad = await api('POST', '/auth/otp/verify', { body: { phone: TEST_USERS[1].phone, code: devCode === '000000' ? '111111' : '000000' } }).catch((e) => e);
  eq(bad.status, 400, 'wrong code rejected');
  const ok = await api('POST', '/auth/otp/verify', { body: { phone: TEST_USERS[1].phone, code: devCode } });
  eq(ok.user.id, bId, 'OTP logs into the same account');
});
await step('invalid credentials rejected', async () => {
  const err = await api('POST', '/auth/login', { body: { identifier: TEST_USERS[0].username, password: 'wrong-pass' } }).catch((e) => e);
  eq(err.status, 401, 'status');
});
await step('search user by name prefix (phone/email hidden)', async () => {
  const found = await api('GET', `/users/search?q=${encodeURIComponent('priya')}`, { token: tokA });
  const hit = found.find((u) => u.id === bId);
  assert(hit, 'Priya found');
  assert(!('phone' in hit) && !('email' in hit), 'private fields hidden');
});
await step('update profile (about) + privacy settings', async () => {
  const me = await api('PATCH', '/users/me', { token: tokB, body: { about: 'Available', privacy: { readReceipts: true, lastSeen: 'everyone' } } });
  eq(me.about, 'Available', 'about');
});

console.log('\nRealtime connection & presence');
await step('both users connect over WebSocket (JWT handshake)', async () => {
  [sA, sB] = await Promise.all([connectSocket(tokA), connectSocket(tokB)]);
});
await step('socket rejects invalid token', async () => {
  const err = await connectSocket('bad-token').catch((e) => e);
  eq(err.message, 'UNAUTHORIZED', 'connect_error');
});
await step('start conversation (idempotent for both sides)', async () => {
  conv = await api('POST', '/conversations', { token: tokA, body: { userId: bId } });
  const again = await api('POST', '/conversations', { token: tokB, body: { userId: aId } });
  eq(again.id, conv.id, 'same conversation id');
  eq(conv.peer.id, bId, 'peer');
});
await step('presence: A sees B online, then offline with last seen, then online', async () => {
  await emit(sA, 'presence:subscribe', { userIds: [bId] });
  const profile = await api('GET', `/users/${bId}`, { token: tokA });
  eq(profile.online, true, 'B online');
  const offline = waitFor(sA, 'presence', (p) => p.userId === bId && !p.online);
  sB.disconnect();
  const p = await offline;
  assert(p.lastSeenAt, 'last seen provided');
  const online = waitFor(sA, 'presence', (e) => e.userId === bId && e.online);
  sB = await connectSocket(tokB);
  await online;
  await emit(sB, 'presence:subscribe', { userIds: [aId] });
});

console.log('\nMessaging');
await step('typing indicator delivered in realtime (start / stop)', async () => {
  const start = waitFor(sB, 'typing', (t) => t.conversationId === conv.id && t.isTyping && t.kind === 'text');
  await emit(sA, 'typing', { conversationId: conv.id, isTyping: true });
  eq((await start).userId, aId, 'typing user');
  const stop = waitFor(sB, 'typing', (t) => !t.isTyping);
  await emit(sA, 'typing', { conversationId: conv.id, isTyping: false });
  await stop;
});
await step('recording (voice) indicator', async () => {
  const rec = waitFor(sB, 'typing', (t) => t.kind === 'recording' && t.isTyping);
  await emit(sA, 'typing', { conversationId: conv.id, isTyping: true, kind: 'recording' });
  await rec;
  await emit(sA, 'typing', { conversationId: conv.id, isTyping: false, kind: 'recording' });
});
await step('text message: realtime to B, synced to sender devices', async () => {
  const cmid = clientId();
  const onB = waitFor(sB, 'message:new', (m) => m.clientMsgId === cmid);
  const onA = waitFor(sA, 'message:new', (m) => m.clientMsgId === cmid);
  textMsg = await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'text', text: 'Hello Priya 👋' });
  const got = await onB;
  await onA;
  eq(got.id, textMsg.id, 'same id');
  eq(got.text, 'Hello Priya 👋', 'text');
  eq(got.status, 'sent', 'initial status');
});
await step('delivered receipt (✓✓) reaches sender in realtime', async () => {
  const status = waitFor(sA, 'message:status', (s) => s.conversationId === conv.id && s.status === 'delivered');
  await emit(sB, 'message:delivered', { conversationId: conv.id, upToMessageId: textMsg.id });
  eq((await status).upToMessageId, textMsg.id, 'upTo');
});
await step('emoji-only message', async () => {
  const cmid = clientId();
  const onB = waitFor(sB, 'message:new', (m) => m.clientMsgId === cmid);
  await emit(sB, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'text', text: '😂🔥❤️🎉' });
  eq((await onB).text, '😂🔥❤️🎉', 'emoji preserved');
});
await step('duplicate send with same clientMsgId is idempotent', async () => {
  const cmid = clientId();
  const first = await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'text', text: 'once' });
  const second = await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'text', text: 'once' });
  eq(second.id, first.id, 'same message');
});
await step('image upload (thumbnail + size) and image message', async () => {
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3366ff' } }).png().toBuffer();
  const media = await upload(tokA, { buffer: png, filename: 'photo.png', mime: 'image/png' });
  eq(media.kind, 'image', 'kind');
  eq(media.width, 800, 'width');
  assert(media.thumbUrl, 'thumbnail generated');
  const thumb = await fetch(`${BASE_URL}${media.thumbUrl}`);
  eq(thumb.status, 200, 'thumbnail served');
  const cmid = clientId();
  const onB = waitFor(sB, 'message:new', (m) => m.clientMsgId === cmid);
  imageMsg = await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'image', text: 'Look at this', media });
  const got = await onB;
  eq(got.media.url, media.url, 'media url');
  eq(got.text, 'Look at this', 'caption');
});
await step('video message', async () => {
  const media = await upload(tokB, { buffer: Buffer.alloc(2048, 1), filename: 'clip.mp4', mime: 'video/mp4', duration: 3 });
  eq(media.kind, 'video', 'kind');
  const cmid = clientId();
  const onA = waitFor(sA, 'message:new', (m) => m.clientMsgId === cmid);
  await emit(sB, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'video', media });
  eq((await onA).media.duration, 3, 'duration');
});
await step('voice note (recorded audio)', async () => {
  const media = await upload(tokA, { buffer: Buffer.alloc(4096, 2), filename: 'voice.m4a', mime: 'audio/mp4', kind: 'voice', duration: 7 });
  eq(media.kind, 'voice', 'kind');
  const cmid = clientId();
  const onB = waitFor(sB, 'message:new', (m) => m.clientMsgId === cmid);
  await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'voice', media });
  const got = await onB;
  eq(got.type, 'voice', 'type');
  eq(got.media.duration, 7, 'duration');
});
await step('audio file message', async () => {
  const media = await upload(tokB, { buffer: Buffer.alloc(1024, 3), filename: 'song.mp3', mime: 'audio/mpeg' });
  eq(media.kind, 'audio', 'kind');
  const cmid = clientId();
  const onA = waitFor(sA, 'message:new', (m) => m.clientMsgId === cmid);
  await emit(sB, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'audio', media });
  await onA;
});
await step('document / file message (served as attachment)', async () => {
  const media = await upload(tokA, { buffer: Buffer.from('%PDF-1.4 test document'), filename: 'invoice.pdf', mime: 'application/pdf' });
  eq(media.kind, 'file', 'kind');
  const served = await fetch(`${BASE_URL}${media.url}`);
  eq(served.headers.get('content-disposition'), 'attachment', 'download header');
  const cmid = clientId();
  const onB = waitFor(sB, 'message:new', (m) => m.clientMsgId === cmid);
  await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'file', media });
  eq((await onB).media.name, 'invoice.pdf', 'file name');
});
await step('dangerous upload (html / svg) rejected', async () => {
  const err = await upload(tokA, { buffer: Buffer.from('<script>x</script>'), filename: 'x.html', mime: 'text/html' }).catch((e) => e);
  eq(err.status, 400, 'rejected');
});
await step('location message', async () => {
  const cmid = clientId();
  const onB = waitFor(sB, 'message:new', (m) => m.clientMsgId === cmid);
  await emit(sA, 'message:send', {
    conversationId: conv.id,
    clientMsgId: cmid,
    type: 'location',
    location: { lat: 28.6139, lng: 77.209, name: 'India Gate', address: 'New Delhi' },
  });
  eq((await onB).location.name, 'India Gate', 'location');
});
await step('contact card message', async () => {
  const cmid = clientId();
  const onA = waitFor(sA, 'message:new', (m) => m.clientMsgId === cmid);
  await emit(sB, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'contact', contact: { name: 'Rahul', phone: '+911234567890' } });
  eq((await onA).contact.name, 'Rahul', 'contact');
});
await step('reply (quoted message)', async () => {
  const cmid = clientId();
  const onA = waitFor(sA, 'message:new', (m) => m.clientMsgId === cmid);
  await emit(sB, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'text', text: 'Hi Aman!', replyToId: textMsg.id });
  const got = await onA;
  eq(got.replyTo.id, textMsg.id, 'reply id');
  eq(got.replyTo.text, 'Hello Priya 👋', 'quoted text');
});
await step('empty text rejected by validation', async () => {
  const err = await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: clientId(), type: 'text', text: '   ' }).catch((e) => e);
  eq(err.code, 'BAD_REQUEST', 'code');
});

console.log('\nReactions, edit, receipts');
await step('emoji reaction add / change / remove (realtime)', async () => {
  let upd = waitFor(sA, 'message:updated', (m) => m.id === textMsg.id && m.reactions.some((r) => r.emoji === '❤️'));
  await emit(sB, 'message:react', { messageId: textMsg.id, emoji: '❤️' });
  await upd;
  upd = waitFor(sA, 'message:updated', (m) => m.id === textMsg.id && m.reactions.length === 1 && m.reactions[0].emoji === '👍');
  await emit(sB, 'message:react', { messageId: textMsg.id, emoji: '👍' });
  await upd;
  upd = waitFor(sA, 'message:updated', (m) => m.id === textMsg.id && m.reactions.length === 0);
  await emit(sB, 'message:react', { messageId: textMsg.id, emoji: null });
  await upd;
});
await step('edit message (realtime, marked edited)', async () => {
  const upd = waitFor(sB, 'message:updated', (m) => m.id === textMsg.id && m.edited);
  await emit(sA, 'message:edit', { messageId: textMsg.id, text: 'Hello Priya 👋 (edited)' });
  eq((await upd).text, 'Hello Priya 👋 (edited)', 'text');
});
await step("cannot edit someone else's message", async () => {
  const err = await emit(sB, 'message:edit', { messageId: textMsg.id, text: 'hack' }).catch((e) => e);
  eq(err.code, 'FORBIDDEN', 'code');
});
await step('unread count + read receipt (blue ✓✓) in realtime', async () => {
  const list = await api('GET', '/conversations', { token: tokB });
  const c = list.items.find((i) => i.id === conv.id);
  assert(c.unreadCount > 0, `B has unread (${c.unreadCount})`);
  const { items } = await api('GET', `/conversations/${conv.id}/messages?limit=1`, { token: tokB });
  const read = waitFor(sA, 'message:status', (s) => s.status === 'read' && s.conversationId === conv.id);
  const res = await emit(sB, 'conversation:read', { conversationId: conv.id, upToMessageId: items.at(-1).id });
  eq(res.unreadCount, 0, 'unread cleared');
  await read;
  const history = await api('GET', `/conversations/${conv.id}/messages?limit=100`, { token: tokA });
  assert(history.items.filter((m) => m.senderId === aId).every((m) => m.status === 'read'), 'all A messages read');
});
await step('message info (sent / delivered / read times)', async () => {
  const info = await api('GET', `/messages/${textMsg.id}/info`, { token: tokA });
  assert(info.sentAt && info.deliveredAt && info.readAt, 'all timestamps present');
});

console.log('\nStar, forward, delete');
await step('star / unstar message + starred list', async () => {
  await emit(sA, 'message:star', { messageId: imageMsg.id, starred: true });
  let starred = await api('GET', '/messages/starred', { token: tokA });
  assert(starred.some((m) => m.id === imageMsg.id), 'in starred list');
  const other = await api('GET', '/messages/starred', { token: tokB });
  assert(!other.some((m) => m.id === imageMsg.id), 'stars are private');
  await emit(sA, 'message:star', { messageId: imageMsg.id, starred: false });
  starred = await api('GET', '/messages/starred', { token: tokA });
  assert(!starred.some((m) => m.id === imageMsg.id), 'removed');
});
await step('forward message (marked forwarded)', async () => {
  const onB = waitFor(sB, 'message:new', (m) => m.forwarded && m.type === 'image');
  const [fwd] = await emit(sA, 'message:forward', { messageId: imageMsg.id, toUserIds: [bId], clientMsgId: clientId() });
  eq(fwd.forwardCount, 1, 'forward count');
  eq((await onB).media.url, imageMsg.media.url, 'same media');
});
await step('delete for me (only my devices notified)', async () => {
  const cmid = clientId();
  const m = await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'text', text: 'delete me' });
  const removed = waitFor(sA, 'message:removed', (e) => e.messageId === m.id);
  const quietB = expectNoEvent(sB, 'message:removed', (e) => e.messageId === m.id);
  await emit(sA, 'message:delete', { messageId: m.id, scope: 'me' });
  await removed;
  assert(await quietB, 'B not notified');
  const mine = await api('GET', `/conversations/${conv.id}/messages?limit=5`, { token: tokA });
  assert(!mine.items.some((x) => x.id === m.id), 'hidden for A');
  const theirs = await api('GET', `/conversations/${conv.id}/messages?limit=5`, { token: tokB });
  assert(theirs.items.some((x) => x.id === m.id), 'still visible for B');
});
await step('delete for everyone (realtime tombstone)', async () => {
  const cmid = clientId();
  const m = await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'text', text: 'oops wrong chat' });
  const upd = waitFor(sB, 'message:updated', (e) => e.id === m.id && e.deleted);
  await emit(sA, 'message:delete', { messageId: m.id, scope: 'everyone' });
  const got = await upd;
  eq(got.text, '', 'content wiped');
  const list = await api('GET', `/conversations/${conv.id}`, { token: tokB });
  eq(list.lastMessage.deleted, true, 'chat list preview updated');
});
await step("cannot delete someone else's message for everyone", async () => {
  const err = await emit(sB, 'message:delete', { messageId: textMsg.id, scope: 'everyone' }).catch((e) => e);
  eq(err.code, 'FORBIDDEN', 'code');
});

console.log('\nHistory, search, media');
await step('cursor pagination (before / after)', async () => {
  const page1 = await api('GET', `/conversations/${conv.id}/messages?limit=3`, { token: tokA });
  eq(page1.items.length, 3, 'page size');
  assert(page1.hasMore, 'has more');
  const page2 = await api('GET', `/conversations/${conv.id}/messages?limit=3&before=${page1.items[0].id}`, { token: tokA });
  assert(page2.items.every((m) => m.id < page1.items[0].id), 'older messages');
  const newer = await api('GET', `/conversations/${conv.id}/messages?after=${page2.items.at(-1).id}&limit=10`, { token: tokA });
  eq(newer.items[0].id, page1.items[0].id, 'after-cursor continues');
});
await step('search messages in chat', async () => {
  const hits = await api('GET', `/conversations/${conv.id}/search?q=Priya`, { token: tokA });
  assert(hits.some((m) => m.id === textMsg.id), 'found edited hello');
  const partial = await api('GET', `/conversations/${conv.id}/search?q=ook%20at`, { token: tokA });
  assert(partial.some((m) => m.id === imageMsg.id), 'substring fallback');
});
await step('media / docs / audio gallery', async () => {
  const media = await api('GET', `/conversations/${conv.id}/media?kind=media`, { token: tokB });
  assert(media.some((m) => m.type === 'image') && media.some((m) => m.type === 'video'), 'images + videos');
  const docs = await api('GET', `/conversations/${conv.id}/media?kind=docs`, { token: tokB });
  assert(docs.some((m) => m.media.name === 'invoice.pdf'), 'documents');
  const audio = await api('GET', `/conversations/${conv.id}/media?kind=audio`, { token: tokB });
  assert(audio.some((m) => m.type === 'voice') && audio.some((m) => m.type === 'audio'), 'voice + audio');
});

console.log('\nChat list & settings');
await step('chat list with peer, last message, unread, online', async () => {
  const { items } = await api('GET', '/conversations', { token: tokA });
  const c = items.find((i) => i.id === conv.id);
  assert(c, 'conversation listed');
  eq(c.peer.id, bId, 'peer');
  eq(c.peer.online, true, 'peer online');
  assert(c.lastMessage, 'last message');
});
await step('pin / mute / archive / unarchive (synced to own devices)', async () => {
  let upd = waitFor(sA, 'conversation:updated', (c) => c.id === conv.id && c.pinned);
  await api('PATCH', `/conversations/${conv.id}`, { token: tokA, body: { pinned: true } });
  await upd;
  upd = waitFor(sA, 'conversation:updated', (c) => c.id === conv.id && c.muted);
  await api('PATCH', `/conversations/${conv.id}`, { token: tokA, body: { muteSeconds: 8 * 3600 } });
  await upd;
  await api('PATCH', `/conversations/${conv.id}`, { token: tokA, body: { archived: true } });
  const archived = await api('GET', '/conversations?archived=true', { token: tokA });
  assert(archived.items.some((c) => c.id === conv.id && !c.pinned), 'archived (and unpinned)');
  await api('PATCH', `/conversations/${conv.id}`, { token: tokA, body: { archived: false, muteSeconds: 0 } });
  const back = await api('GET', `/conversations/${conv.id}`, { token: tokA });
  assert(!back.archived && !back.muted, 'restored');
});
await step('total unread badge endpoint', async () => {
  const u = await api('GET', '/conversations/unread', { token: tokB });
  assert(typeof u.total === 'number', 'total');
});

console.log('\nOffline delivery');
await step('message to offline user stays ✓, becomes ✓✓ when they reconnect', async () => {
  sB.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  const cmid = clientId();
  const m = await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: cmid, type: 'text', text: 'Are you there?' });
  eq(m.status, 'sent', 'single tick');
  const delivered = waitFor(sA, 'message:status', (s) => s.status === 'delivered' && s.upToMessageId >= m.id);
  sB = await connectSocket(tokB);
  await delivered;
  const sync = await api('GET', `/conversations/${conv.id}/messages?after=${textMsg.id}&limit=100`, { token: tokB });
  assert(sync.items.some((x) => x.id === m.id), 'missed message synced via REST');
});

console.log('\nBlocking');
await step('block: messages and typing are refused, then unblock restores', async () => {
  await api('POST', `/users/${aId}/block`, { token: tokB });
  const err = await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: clientId(), type: 'text', text: 'hello?' }).catch((e) => e);
  eq(err.code, 'BLOCKED', 'sender blocked');
  const quiet = expectNoEvent(sB, 'typing');
  await emit(sA, 'typing', { conversationId: conv.id, isTyping: true });
  assert(await quiet, 'typing suppressed');
  const blocked = await api('GET', '/users/blocked', { token: tokB });
  assert(blocked.some((u) => u.id === aId), 'in blocked list');
  await api('DELETE', `/users/${aId}/block`, { token: tokB });
  const ok = await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: clientId(), type: 'text', text: 'unblocked 🎉' });
  assert(ok.id, 'send works again');
});

console.log('\nClear & delete chat');
await step('clear chat hides history only for that user', async () => {
  await api('POST', `/conversations/${conv.id}/clear`, { token: tokB });
  const b = await api('GET', `/conversations/${conv.id}/messages`, { token: tokB });
  eq(b.items.length, 0, 'B history empty');
  const a = await api('GET', `/conversations/${conv.id}/messages`, { token: tokA });
  assert(a.items.length > 0, 'A history intact');
});
await step('delete chat hides it until a new message arrives', async () => {
  await api('DELETE', `/conversations/${conv.id}`, { token: tokB });
  let list = await api('GET', '/conversations', { token: tokB });
  assert(!list.items.some((c) => c.id === conv.id), 'hidden');
  const onB = waitFor(sB, 'message:new');
  await emit(sA, 'message:send', { conversationId: conv.id, clientMsgId: clientId(), type: 'text', text: 'new message after delete' });
  await onB;
  list = await api('GET', '/conversations', { token: tokB });
  assert(list.items.some((c) => c.id === conv.id), 'visible again');
});

sA.disconnect();
sB.disconnect();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}\n`);
process.exit(failed.length ? 1 : 0);
