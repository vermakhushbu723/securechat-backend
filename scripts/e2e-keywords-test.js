/**
 * End-to-end test: admin login with email + password only, and admin "Blocked Keywords"
 * (words, sentences, links) refused in 1-to-1 chats and groups, live list for the app.
 *   npm run test:keywords   (server running; ADMIN_EMAIL / ADMIN_PASSWORD = a staff account)
 */
import 'dotenv/config';

import { api, BASE_URL, clientId, connectSocket, loginOrRegister, TEST_USERS, waitFor } from './lib/client.js';

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
  assert(err, `${what}: expected ${code}, but it was sent`);
  eq(err.code, code, `${what} error code`);
  return err;
}

let token;
const admin = (method, path, body) => api(method, `/admin${path}`, { token, body });

console.log(`\nSecureChat BLOCKED KEYWORDS test against ${BASE_URL}\n`);
// Letters only (group number filters must not interfere).
const tag = Date.now().toString(36).replace(/[^a-z]/g, '').slice(-5).padEnd(5, 'q');
const WORD = `zebra${tag}`;
const SENTENCE = `meet me behind ${tag} gate`;
const LINK = `bad${tag}.example`;
const PARTIAL = `blk${tag}`;
const DM_ONLY = `dmonly${tag}`;
const created = [];

await step('admin login: email + password only (no code)', async () => {
  const s = await api('POST', '/admin/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  eq(s.twoFactor, false, 'no 2-step');
  assert(s.token && s.staff, 'session returned directly');
  token = s.token;
  await fails(api('POST', '/admin/auth/login', { body: { email: EMAIL, password: 'wrong-password' } }), 'UNAUTHORIZED', 'wrong password');
});

const [A, B] = await Promise.all(TEST_USERS.map(loginOrRegister));
const sock = await connectSocket(B.accessToken);

await step('admin adds a word, a sentence, a link, a partial word and a 1-to-1 only word', async () => {
  const update = waitFor(sock, 'blocked-terms:updated');
  const r = await admin('POST', '/blocked-terms', { texts: [WORD, SENTENCE, `https://www.${LINK}/`] });
  eq(r.added.length, 3, 'three added');
  eq(r.added.find((t) => t.text === SENTENCE)?.type, 'sentence', 'sentence type');
  eq(r.added.find((t) => t.text.includes(LINK))?.type, 'link', 'link type');
  const p = await admin('POST', '/blocked-terms', { texts: [PARTIAL], partial: true });
  const d = await admin('POST', '/blocked-terms', { texts: [DM_ONLY], scope: 'direct' });
  created.push(...r.added, ...p.added, ...d.added);
  const dup = await admin('POST', '/blocked-terms', { texts: [WORD.toUpperCase()] });
  eq(dup.skipped.length, 1, 'duplicate skipped');
  await update; // every open app is told to refresh
  const list = await admin('GET', `/blocked-terms?q=${tag}`);
  eq(list.total, 5, 'listed');
});

await step('the app gets the live list (used to disable the send button while typing)', async () => {
  const data = await api('GET', '/blocked-terms', { token: A.accessToken });
  for (const t of [WORD, SENTENCE, PARTIAL, DM_ONLY]) assert(data.terms.some((x) => x.text === t), `${t} in app list`);
  assert(data.version, 'version');
});

let conv;
const dm = (text) => api('POST', `/conversations/${conv.id}/messages`, { token: A.accessToken, body: { clientMsgId: clientId(), type: 'text', text } });

await step('1-to-1: blocked word / sentence / link cannot be sent (any case, spacing, URL form)', async () => {
  conv = await api('POST', '/conversations', { token: A.accessToken, body: { userId: B.user.id } });
  const err = await fails(dm(`hello ${WORD}`), 'CONTENT_BLOCKED', 'word');
  eq(err.details.rule, 'keyword', 'rule keyword');
  await fails(dm(`${WORD.toUpperCase()}!`), 'CONTENT_BLOCKED', 'upper case');
  await fails(dm(`please ${SENTENCE.toUpperCase().replace(/ /g, '   ')} tonight`), 'CONTENT_BLOCKED', 'sentence with extra spaces');
  await fails(dm(`see http://${LINK}/page`), 'CONTENT_BLOCKED', 'link without www');
  await fails(dm(`open www.${LINK}`), 'CONTENT_BLOCKED', 'link with www');
  await fails(dm(`${PARTIAL}ing is here`), 'CONTENT_BLOCKED', 'partial word inside a longer word');
  await fails(dm(`only here ${DM_ONLY}`), 'CONTENT_BLOCKED', '1-to-1 only word in 1-to-1');
});

await step('1-to-1: normal text and look-alike words still go through', async () => {
  await dm('hello there, normal message');
  await dm(`${WORD}s is a different word`); // whole-word match
  await dm(`meet me behind the gate`);
});

let msg;
await step('1-to-1: editing a message into a blocked word is refused', async () => {
  msg = await dm('fine text');
  await fails(api('PATCH', `/messages/${msg.id}`, { token: A.accessToken, body: { text: `now ${WORD}` } }), 'CONTENT_BLOCKED', 'edit');
});

let group;
await step('group: blocked word / sentence refused, 1-to-1 only word allowed', async () => {
  group = (await admin('POST', '/groups', { name: `Keyword Test ${tag}`, creator: A.user.id })).group;
  await admin('POST', `/groups/${group.id}/members`, { user: B.user.id });
  const send = (text) => api('POST', `/groups/${group.id}/messages`, { token: B.accessToken, body: { clientMsgId: clientId(), type: 'text', text } });
  const err = await fails(send(`group ${WORD}`), 'CONTENT_BLOCKED', 'group word');
  eq(err.details.rule, 'keyword', 'rule keyword');
  await fails(send(`hey ${SENTENCE}`), 'CONTENT_BLOCKED', 'group sentence');
  await send(`this has ${DM_ONLY} in it`); // scope: 1-to-1 only
  await send('ordinary group message');
});

await step('admin test box, moderation log, hit counter', async () => {
  const t = await admin('POST', '/blocked-terms/test', { text: `x ${DM_ONLY} y` });
  eq(t.direct, DM_ONLY, 'blocked in 1-to-1');
  eq(t.groups, null, 'allowed in groups');
  const log = await admin('GET', '/moderation/log?rule=keyword');
  assert(log.items.some((r) => r.rule === 'keyword'), 'keyword blocks in the log');
  const list = await admin('GET', `/blocked-terms?q=${WORD}`);
  assert(list.items[0].hits >= 3, 'hit counter');
});

await step('turning a keyword off allows it again; deleting removes it', async () => {
  const w = created.find((t) => t.text === WORD);
  await admin('PATCH', `/blocked-terms/${w.id}`, { active: false });
  await dm(`allowed again ${WORD}`);
  await admin('PATCH', `/blocked-terms/${w.id}`, { active: true });
  await fails(dm(`blocked again ${WORD}`), 'CONTENT_BLOCKED', 'on again');
});

// Cleanup
for (const t of created) await admin('DELETE', `/blocked-terms/${t.id}`).catch(() => {});
if (group) await admin('DELETE', `/groups/${group.id}`).catch(() => {});
sock.close();
await step('cleanup: keywords removed, text allowed', async () => {
  await dm(`after cleanup ${WORD}`);
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
process.exit(passed === results.length ? 0 : 1);
