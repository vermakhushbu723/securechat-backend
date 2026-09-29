/**
 * 1-to-1 privacy options (same as groups) + join permissions:
 *   npm run test:dm-privacy     (server must be running)
 */
import sharp from 'sharp';

import { api, BASE_URL, clientId, connectSocket, emit, loginOrRegister, TEST_USERS, waitFor } from './lib/client.js';

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

console.log(`\nSecureChat 1-to-1 PRIVACY + JOIN PERMISSIONS test against ${BASE_URL}\n`);
const [A, P] = await Promise.all(TEST_USERS.map(loginOrRegister));
const sa = await connectSocket(A.accessToken);
const sp = await connectSocket(P.accessToken);
const send = (p) => emit(sa, 'message:send', { toUserId: P.user.id, clientMsgId: clientId(), type: 'text', ...p });

await step('view once text: receiver sees a placeholder, opens it once', async () => {
  const got = waitFor(sp, 'message:new', (m) => m.viewOnce && m.senderId === A.user.id);
  const r = await send({ text: 'Secret code 4 you', expiry: 'view_once' });
  const mine = r.message ?? r;
  eq(mine.viewOnce, true, 'view once');
  eq(mine.text, 'Secret code 4 you', 'sender sees own text');
  const theirs = await got;
  eq(theirs.withheld, true, 'receiver placeholder');
  eq(theirs.text, '', 'content hidden');
  const opened = await api('POST', `/messages/${mine.id}/open`, { token: P.accessToken });
  eq(opened.text, 'Secret code 4 you', 'revealed on open');
  const again = await api('POST', `/messages/${mine.id}/open`, { token: P.accessToken }).catch((e) => e);
  eq(again.code, 'ALREADY_OPENED', 'only once');
  const list = await api('GET', `/conversations/${mine.conversationId}/messages?limit=5`, { token: P.accessToken });
  const row = list.items.find((m) => m.id === mine.id);
  eq(row.withheldReason, 'opened', 'shows "Opened" afterwards');
  eq(row.permissions.canForward, false, 'view once cannot be forwarded');
});

await step('public photo with downloads and screenshots turned off', async () => {
  const form = new FormData();
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 108, g: 43, b: 242 } } }).png().toBuffer();
  form.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
  const media = await api('POST', '/media/upload', { token: A.accessToken, form });
  const r = await send({ type: 'image', media, visibility: 'public', allowDownload: false, allowScreenshot: false });
  const m = r.message ?? r;
  eq(m.permissions.allowDownload, false, 'download off');
  eq(m.permissions.allowScreenshot, false, 'screenshot off');
  eq(m.permissions.canForward, true, 'public can still be forwarded');
});

await step('expiry 1 hour is stored; private text cannot be copied or forwarded', async () => {
  const r = await send({ text: 'Meeting at the office', visibility: 'private', expiry: '1h' });
  const m = r.message ?? r;
  const at = new Date(m.permissions.expiresAt).getTime();
  assert(Math.abs(at - (Date.now() + 3_600_000)) < 60_000, 'expires in about 1 hour');
  eq(m.permissions.canCopy, false, 'no copy');
  eq(m.permissions.canForward, false, 'no forward');
});

await step('silent message is stored as silent', async () => {
  const r = await send({ text: 'no ping', silent: true });
  eq((r.message ?? r).silent, true, 'silent');
});

await step('invite preview lists the group permissions to accept', async () => {
  const res = await api('POST', '/groups', {
    token: A.accessToken,
    body: {
      name: `Perm Test ${Date.now().toString(36)}`,
      settings: { location: { requirement: 'mandatory', shareMode: 'join', visibility: 'groupMembers' }, members: { restrictNewMembers: true } },
      invite: { expiry: '7d', maxJoins: 0 },
    },
  });
  const pv = await (await fetch(`${BASE_URL}/api/v1/invites/${res.invite.code}`)).json();
  const keys = pv.data.permissions.map((x) => x.key);
  for (const k of ['location', 'messages', 'protection', 'content', 'restricted', 'privacy']) assert(keys.includes(k), `permission "${k}" listed (${keys})`);
  assert(/turns on when you join/.test(pv.data.permissions[0].detail), 'location explains it turns on');

  // Joining with location turns the member's location sharing on.
  await api('PUT', '/location/settings', { token: P.accessToken, body: { mode: 'none', intervalMin: 10 } });
  const j = await api('POST', `/invites/${res.invite.code}/join`, { token: P.accessToken, body: { location: { lat: 26.85, lng: 80.95, place: 'Lucknow' }, shareMode: 'join' } });
  eq(j.status, 'active', 'joined');
  const me = await api('GET', '/users/me', { token: P.accessToken });
  eq(me.locationSettings.mode, 'join', 'location sharing turned on');
  await api('DELETE', `/groups/${res.group.id}`, { token: A.accessToken });
});

sa.close();
sp.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
process.exit(passed === results.length ? 0 : 1);
