/**
 * End-to-end test: Search Permissions (platform / user / group level) and the mandatory
 * mobile number protection in 1-to-1 chats and groups.
 *   npm run test:search-phone   (server running, OTP_DEV_MODE=true; ADMIN_EMAIL / ADMIN_PASSWORD = staff)
 */
import 'dotenv/config';

import { api, BASE_URL, clientId } from './lib/client.js';

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
  const identifier = `sp${stamp}${name.toLowerCase()}@example.org`;
  const req = await api('POST', '/auth/otp/request', { body: { identifier } });
  const s = await api('POST', '/auth/otp/verify', { body: { identifier, code: req.devCode } });
  s.user = await api('POST', '/users/me/profile', { token: s.accessToken, body: { accountType: 'personal', name: `Sp ${stamp} ${name}` } });
  await api('POST', '/subscription/claim-trial', { token: s.accessToken }).catch(() => {});
  return s;
}

console.log(`\nSecureChat SEARCH PERMISSIONS + MOBILE NUMBER PROTECTION test against ${BASE_URL}\n`);
token = (await api('POST', '/admin/auth/login', { body: { email: EMAIL, password: PASSWORD } })).token;
const before = await admin('GET', '/search-permissions');
const contentBefore = await admin('GET', '/settings/content');
const [A, B, C, D] = [await otpUser('Alpha'), await otpUser('Beta'), await otpUser('Gamma'), await otpUser('Delta')];
const created = { users: [A, B, C, D].map((u) => u.user.id), groups: [] };
const searchFor = (s, q = `sp ${stamp}`) => api('GET', `/users/search?q=${encodeURIComponent(q)}`, { token: s.accessToken });

// ------------------------------------------------------------------ search permissions
await step('by default users can search other users', async () => {
  const r = await searchFor(A);
  assert(r.some((u) => u.id === B.user.id), 'B found');
  const p = await api('GET', '/users/me/search-permission', { token: A.accessToken });
  eq(p.users, true, 'allowed');
});

await step('admin turns 1-to-1 search off for everyone -> nobody can search', async () => {
  await admin('PUT', '/search-permissions', { userSearch: false });
  const err = await fails(searchFor(A), 'SEARCH_DISABLED', 'search off');
  assert(err.message.includes('turned off'), 'reason shown');
  const p = await api('GET', '/users/me/search-permission', { token: B.accessToken });
  eq(p.users, false, 'B sees it off');
  eq((await api('GET', '/config')).userSearch, false, 'public config');
  await admin('PUT', '/search-permissions', { userSearch: true });
  await searchFor(A);
});

await step('admin turns search off for one user only', async () => {
  await admin('POST', `/users/${A.user.id}/search`, { allowed: false });
  const err = await fails(searchFor(A), 'SEARCH_DISABLED', 'A blocked');
  assert(err.message.includes('your account'), 'user reason');
  await searchFor(B); // others still can
  const o = await admin('GET', `/search-permissions?q=${stamp}`);
  assert(o.users.items.some((u) => u.id === A.user.id), 'listed in admin');
  const listed = await admin('GET', `/users?filter=search_off&q=${encodeURIComponent(`Sp ${stamp}`)}`);
  eq(listed.items[0]?.id, A.user.id, 'users filter');
  await admin('POST', `/users/${A.user.id}/search`, { allowed: true });
  await searchFor(A);
});

let G;
const members = (s, q) => api('GET', `/groups/${G.id}/members${q ? `?q=${encodeURIComponent(q)}` : ''}`, { token: s.accessToken });

await step('group member search: platform switch blocks everyone, list itself still opens', async () => {
  G = (await admin('POST', '/groups', { name: `Search Test ${stamp}`, creator: A.user.id })).group;
  created.groups.push(G.id);
  await admin('POST', `/groups/${G.id}/members`, { user: B.user.id });
  assert((await members(B, 'Alpha')).length === 1, 'search works by default');
  await admin('PUT', '/search-permissions', { groupMemberSearch: false });
  await fails(members(B, 'Alpha'), 'SEARCH_DISABLED', 'member search off');
  await fails(members(A, 'Beta'), 'SEARCH_DISABLED', 'group owner too');
  eq((await members(B)).length, 2, 'member list without search still works');
  await admin('PUT', '/search-permissions', { groupMemberSearch: true });
});

await step('group admin turns member search off: members blocked, group admins exempt', async () => {
  await api('PATCH', `/groups/${G.id}/settings`, { token: A.accessToken, body: { members: { memberSearch: false } } });
  const err = await fails(members(B, 'Alpha'), 'SEARCH_DISABLED', 'member blocked');
  assert(err.message.includes('group admin'), 'group reason');
  eq((await members(A, 'Beta')).length, 1, 'owner can still search');
  const dB = await api('GET', `/groups/${G.id}`, { token: B.accessToken });
  eq(dB.me.canSearchMembers, false, 'member flag');
  const dA = await api('GET', `/groups/${G.id}`, { token: A.accessToken });
  eq(dA.me.canSearchMembers, true, 'owner flag');
  const o = await admin('GET', '/search-permissions');
  assert(o.groups.items.some((g) => g.id === G.id), 'group listed for the admin');
});

await step('platform admin turns the group member search back on', async () => {
  await admin('POST', `/groups/${G.id}/member-search`, { enabled: true });
  eq((await members(B, 'Alpha')).length, 1, 'member can search again');
});

// ------------------------------------------------------------------ mobile number protection
let conv;
const dm = (s, c, text) => api('POST', `/conversations/${c.id}/messages`, { token: s.accessToken, body: { clientMsgId: clientId(), type: 'text', text } });

await step('1-to-1: every numeric form is refused (digits, 2 digits, symbols, words, Hindi)', async () => {
  // Restrictions are tested separately below.
  await admin('PUT', '/settings/content', { phoneRestrictAfter: 0 });
  conv = await api('POST', '/conversations', { token: B.accessToken, body: { userId: A.user.id } });
  for (const text of ['9876543210', '98765 43210', '91', '9@8', '9 8', 'nine eight seven', 'नौ आठ सात', 'nau aath saat', '98xxxx3210', 'My number is 9876543210']) {
    const err = await fails(dm(B, conv, text), 'CONTENT_BLOCKED', text);
    eq(err.details.rule, 'phone', `rule for "${text}"`);
  }
});

await step('1-to-1: normal messages still go through', async () => {
  const c2 = await api('POST', '/conversations', { token: C.accessToken, body: { userId: A.user.id } });
  for (const text of ['hello how are you', 'I have one question', 'meeting at noon', 'thanks a lot']) await dm(C, c2, text);
});

await step('a number split over several messages is caught (9 / 8 / 7 / 6)', async () => {
  // Admin Blocked Keywords may already refuse single digits; then each fragment is refused anyway.
  const c3 = await api('POST', '/conversations', { token: D.accessToken, body: { userId: A.user.id } });
  const kw = await admin('POST', '/blocked-terms/test', { text: '9' });
  if (!kw.allowed) {
    const err = await fails(dm(D, c3, '9'), 'CONTENT_BLOCKED', 'single digit (blocked keyword)');
    eq(err.details.rule, 'keyword', 'refused by the keyword list');
    return;
  }
  await dm(D, c3, '9');
  await dm(D, c3, '8');
  await dm(D, c3, '7');
  const err = await fails(dm(D, c3, '6'), 'CONTENT_BLOCKED', 'fourth fragment');
  assert(err.details.reasons.some((r) => r.includes('split')), 'split reason');
});

await step('groups: numbers refused, contact cards with a number refused, edits checked', async () => {
  const send = (body) => api('POST', `/groups/${G.id}/messages`, { token: B.accessToken, body: { clientMsgId: clientId(), ...body } });
  const err = await fails(send({ type: 'text', text: 'whatsapp me 98' }), 'CONTENT_BLOCKED', 'group number');
  eq(err.details.rule, 'phone', 'phone rule');
  await fails(send({ type: 'contact', contact: { name: 'Rahul', phone: '+911234567890' } }), 'CONTENT_BLOCKED', 'contact card');
  const ok = await send({ type: 'text', text: 'normal group text' });
  await fails(api('PATCH', `/group-messages/${ok.id}`, { token: B.accessToken, body: { text: 'now 9876543210' } }), 'CONTENT_BLOCKED', 'edit into a number');
});

await step('repeated attempts: read only for 1 hour (admin can lift it)', async () => {
  await admin('PUT', '/settings/content', { phoneRestrictAfter: 3 });
  const c4 = await api('POST', '/conversations', { token: C.accessToken, body: { userId: B.user.id } });
  await fails(dm(C, c4, '98'), 'CONTENT_BLOCKED', 'attempt 1');
  await fails(dm(C, c4, '87'), 'CONTENT_BLOCKED', 'attempt 2');
  const third = await fails(dm(C, c4, '76'), 'CONTENT_BLOCKED', 'attempt 3');
  eq(third.details.restricted, true, 'restricted after 3');
  await fails(dm(C, c4, 'hello'), 'ACCOUNT_RESTRICTED', 'read only now');
  await admin('POST', `/users/${C.user.id}/action`, { action: 'unrestrict' });
  await dm(C, c4, 'hello again');
});

await step('admin: phone test box and moderation log', async () => {
  const t = await admin('POST', '/phone/test', { text: 'call me 98765 43210' });
  assert(t.score >= 13 && t.action === 'block_log', 'high score');
  assert(t.reasons.length >= 3, 'reasons');
  const log = await admin('GET', '/moderation/log?rule=phone');
  assert(log.items.some((r) => r.rule === 'phone'), 'phone blocks logged');
});

// cleanup
await admin('PUT', '/search-permissions', before.global).catch(() => {});
await admin('PUT', '/settings/content', { phoneRestrictAfter: contentBefore.phoneRestrictAfter ?? 3 }).catch(() => {});
for (const id of created.groups) await admin('DELETE', `/groups/${id}`).catch(() => {});
for (const id of created.users) await admin('POST', `/users/${id}/action`, { action: 'delete' }).catch(() => {});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
process.exit(passed === results.length ? 0 : 1);
