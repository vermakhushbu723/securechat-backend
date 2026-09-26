/**
 * End-to-end test of the login flow: one field (mobile number or email ID) -> OTP ->
 * Personal / Business profile -> settings (search visibility, group location).
 *   npm run test:auth      (server must be running with OTP_DEV_MODE=true)
 */
import { api, BASE_URL, loginOrRegister, TEST_USERS } from './lib/client.js';

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

async function otpLogin(identifier) {
  const req = await api('POST', '/auth/otp/request', { body: { identifier } });
  assert(req.devCode, 'dev code returned (OTP_DEV_MODE=true)');
  return { req, res: await api('POST', '/auth/otp/verify', { body: { identifier, code: req.devCode } }) };
}

console.log(`\nSecureChat AUTH E2E test against ${BASE_URL}\n`);
const stamp = Date.now().toString(36);
const email = `biz_${stamp}@example.org`;
const mobile = `9${String(Date.now()).slice(-9)}`; // 10 digit Indian number
let biz; // business account (email)
let person; // personal account (mobile)

await step('invalid identifier is rejected', async () => {
  const err = await api('POST', '/auth/otp/request', { body: { identifier: 'hello' } }).catch((e) => e);
  eq(err.status, 400, 'status');
});

await step('email OTP creates a new account that still needs the profile step', async () => {
  const { req, res } = await otpLogin(email.toUpperCase());
  eq(req.kind, 'email', 'kind');
  eq(req.sentTo, email, 'email is normalised to lower case');
  eq(res.isNew, true, 'isNew');
  eq(res.profileCompleted, false, 'profileCompleted');
  eq(res.user.email, email, 'email stored');
  biz = res;
});

await step('wrong code is refused', async () => {
  const req = await api('POST', '/auth/otp/request', { body: { identifier: email } });
  const wrong = req.devCode === '000000' ? '111111' : '000000';
  const err = await api('POST', '/auth/otp/verify', { body: { identifier: email, code: wrong } }).catch((e) => e);
  eq(err.status, 400, 'status');
});

await step('Business profile: business name, address and bio', async () => {
  const bad = await api('POST', '/users/me/profile', { token: biz.accessToken, body: { accountType: 'business', businessName: 'X' } }).catch((e) => e);
  eq(bad.status, 400, 'address required');
  const me = await api('POST', '/users/me/profile', {
    token: biz.accessToken,
    body: { accountType: 'business', businessName: 'Verma Traders', businessAddress: 'Aminabad, Lucknow', bio: 'Wholesale garments' },
  });
  eq(me.accountType, 'business', 'type');
  eq(me.name, 'Verma Traders', 'business name is the display name');
  eq(me.businessAddress, 'Aminabad, Lucknow', 'address');
  eq(me.about, 'Wholesale garments', 'bio');
  eq(me.profileCompleted, true, 'profile completed');
});

await step('logging in again is not a new account', async () => {
  const { res } = await otpLogin(email);
  eq(res.isNew, false, 'isNew');
  eq(res.profileCompleted, true, 'profileCompleted');
  eq(res.user.id, biz.user.id, 'same user');
});

await step('mobile OTP (10 digits, no +91) creates a Personal account', async () => {
  const { req, res } = await otpLogin(mobile);
  eq(req.kind, 'phone', 'kind');
  eq(req.sentTo, `+91${mobile}`, 'number stored with +91');
  eq(res.isNew, true, 'isNew');
  const me = await api('POST', '/users/me/profile', { token: res.accessToken, body: { accountType: 'personal', name: 'Khushi Test' } });
  eq(me.accountType, 'personal', 'type');
  eq(me.name, 'Khushi Test', 'name');
  eq(me.businessAddress, null, 'no business address');
  person = { ...res, user: me };
});

await step('existing test user logs in with the plain 10 digit number', async () => {
  const aman = TEST_USERS[0];
  const { res } = await otpLogin(aman.phone.replace('+91', ''));
  eq(res.isNew, false, 'existing account');
  eq(res.user.username, aman.username, 'same user as password login');
  eq(res.profileCompleted, true, 'old accounts count as completed');
});

await step('business profile is public (name, type, address), phone / email stay private', async () => {
  const pub = await api('GET', `/users/${biz.user.id}`, { token: person.accessToken });
  eq(pub.accountType, 'business', 'type');
  eq(pub.businessAddress, 'Aminabad, Lucknow', 'address');
  assert(pub.email === undefined && pub.phone === undefined, 'no email / phone in public profile');
});

await step('Settings: "Anyone can find me" off hides the user from search', async () => {
  const found = await api('GET', `/users/search?q=${encodeURIComponent('Verma Traders')}`, { token: person.accessToken });
  assert(found.some((u) => u.id === biz.user.id), 'found while searchable');
  const me = await api('PATCH', '/users/me', { token: biz.accessToken, body: { privacy: { searchable: false } } });
  eq(me.privacy.searchable, false, 'saved');
  const hidden = await api('GET', `/users/search?q=${encodeURIComponent('Verma Traders')}`, { token: person.accessToken });
  assert(!hidden.some((u) => u.id === biz.user.id), 'hidden from search');
  await api('PATCH', '/users/me', { token: biz.accessToken, body: { privacy: { searchable: true } } });
  const again = await api('GET', `/users/search?q=${encodeURIComponent('Verma Traders')}`, { token: person.accessToken });
  assert(again.some((u) => u.id === biz.user.id), 'found again');
});

await step('Settings: group user location off / on', async () => {
  const off = await api('PUT', '/location/settings', { token: person.accessToken, body: { mode: 'none', intervalMin: 10 } });
  eq(off.settings.mode, 'none', 'off');
  const me = await api('GET', '/users/me', { token: person.accessToken });
  eq(me.locationSettings.mode, 'none', 'profile shows off');
  const on = await api('PUT', '/location/settings', { token: person.accessToken, body: { mode: 'join', intervalMin: 10 } });
  eq(on.settings.mode, 'join', 'on');
});

await step('password login still works for existing users', async () => {
  const s = await loginOrRegister(TEST_USERS[1]);
  assert(s.accessToken, 'token');
});

// Test accounts stay out of other people's search results.
for (const s of [biz, person].filter(Boolean)) {
  await api('PATCH', '/users/me', { token: s.accessToken, body: { privacy: { searchable: false } } }).catch(() => {});
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
process.exit(passed === results.length ? 0 : 1);
