/**
 * End-to-end test: UPI payments for premium plans.
 * Admin sets the UPI ID / QR -> the app shows plans + UPI details -> the user sends the UTR ->
 * the admin approves -> premium for the plan's days (or rejects).
 *   npm run test:payment   (server running, OTP_DEV_MODE=true; ADMIN_EMAIL / ADMIN_PASSWORD = staff)
 */
import 'dotenv/config';

import { api, BASE_URL } from './lib/client.js';

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
const SERVER = BASE_URL;

async function otpUser(name) {
  const identifier = `py${stamp}${name.toLowerCase()}@example.org`;
  const req = await api('POST', '/auth/otp/request', { body: { identifier } });
  const s = await api('POST', '/auth/otp/verify', { body: { identifier, code: req.devCode } });
  s.user = await api('POST', '/users/me/profile', { token: s.accessToken, body: { accountType: 'personal', name: `Py ${stamp} ${name}` } });
  await api('POST', '/subscription/claim-trial', { token: s.accessToken }).catch(() => {});
  return s;
}

console.log(`\nSecureChat UPI PAYMENTS test against ${BASE_URL}\n`);
token = (await api('POST', '/admin/auth/login', { body: { email: EMAIL, password: PASSWORD } })).token;
const before = await admin('GET', '/settings/payment');
const [A, B] = [await otpUser('Payer'), await otpUser('Other')];
const as = (s) => (method, path, body) => api(method, path, { token: s.accessToken, body });
let plan;

await step('admin: UPI ID flipflops@upi is set by default, edit works, a wrong UPI ID is refused', async () => {
  eq(before.upiId, 'flipflops@upi', 'default UPI ID');
  await fails(admin('PUT', '/settings/payment', { upiId: 'not a upi' }), 'BAD_REQUEST', 'invalid UPI ID');
  const r = await admin('PUT', '/settings/payment', { upiId: `test${stamp}@okaxis`, payeeName: 'SecureChat Test' });
  eq(r.upiId, `test${stamp}@okaxis`, 'edited');
});

await step('admin uploads a QR image; it is served to the app', async () => {
  // 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'qr.png');
  const res = await fetch(`${BASE_URL}/api/v1/admin/settings/payment/qr`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  const j = await res.json();
  assert(j.ok, `upload: ${JSON.stringify(j.error)}`);
  assert(j.data.qrImageUrl?.startsWith('/uploads/payment/'), `url ${j.data.qrImageUrl}`);
  const img = await fetch(`${SERVER}${j.data.qrImageUrl}`);
  eq(img.status, 200, 'QR served');
  const bad = new FormData();
  bad.append('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg');
  const r2 = await (await fetch(`${BASE_URL}/api/v1/admin/settings/payment/qr`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: bad })).json();
  eq(r2.ok, false, 'svg refused');
});

await step('app: plans from the admin panel and the UPI details for checkout', async () => {
  plan = await admin('POST', '/plans', { name: `Pay ${stamp}`, price: 199, durationDays: 30, features: ['Unlimited chats'] });
  const plans = await as(A)('GET', '/subscription/plans');
  assert(plans.some((p) => p.id === plan.id && p.price === 199 && p.durationDays === 30), 'new plan listed');
  const info = await as(A)('GET', '/subscription/payment-info');
  eq(info.enabled, true, 'enabled');
  eq(info.upiId, `test${stamp}@okaxis`, 'UPI ID');
  eq(info.payeeName, 'SecureChat Test', 'payee');
  assert(info.qrImageUrl, 'QR');
});

await step('user sends the UTR: wrong formats refused, payment waits for the admin', async () => {
  await fails(as(A)('POST', '/subscription/payments', { planId: plan.id, utr: '12' }), 'BAD_REQUEST', 'too short');
  await fails(as(A)('POST', '/subscription/payments', { planId: plan.id, utr: '4123-4567' }), 'BAD_REQUEST', 'symbols');
  const r = await as(A)('POST', '/subscription/payments', { planId: plan.id, utr: `41${stamp}9012` });
  eq(r.status, 'pending', 'pending');
  eq(r.payment.amount, 199, 'amount');
  eq(r.payment.payTo, `test${stamp}@okaxis`, 'paid to');
  const s = await as(A)('GET', '/subscription');
  eq(s.requests[0].payment.utr, `41${stamp}9012`.toUpperCase(), 'shown in My Subscription');
});

await step('same UTR twice / a second payment while one waits are refused', async () => {
  await fails(as(B)('POST', '/subscription/payments', { planId: plan.id, utr: `41${stamp}9012` }), 'UTR_USED', 'UTR reused');
  await fails(as(A)('POST', '/subscription/payments', { planId: plan.id, utr: `99${stamp}1111` }), 'REQUEST_PENDING', 'second payment');
});

await step('admin approves -> premium for the plan days, seen by the app', async () => {
  const list = await admin('GET', '/requests?status=pending&limit=100');
  const r = list.items.find((x) => x.user.id === A.user.id);
  assert(r?.payment?.utr === `41${stamp}9012`.toUpperCase(), 'payment listed for the admin');
  await admin('POST', `/requests/${r.id}`, { approve: true, as: 'premium' });
  const s = await as(A)('GET', '/subscription');
  eq(s.access, 'premium', 'premium');
  assert(s.daysLeft >= 29, `days left ${s.daysLeft}`);
  eq(s.requests[0].status, 'approved', 'approved');
});

await step('admin rejects a payment -> no premium, the user can send again', async () => {
  await as(B)('POST', '/subscription/payments', { planId: plan.id, utr: `77${stamp}2222` });
  const r = (await admin('GET', '/requests?status=pending&limit=100')).items.find((x) => x.user.id === B.user.id);
  await admin('POST', `/requests/${r.id}`, { approve: false });
  const s = await as(B)('GET', '/subscription');
  assert(s.access !== 'premium', 'not premium');
  eq(s.requests[0].status, 'rejected', 'rejected');
  const again = await as(B)('POST', '/subscription/payments', { planId: plan.id, utr: `77${stamp}2222` });
  eq(again.status, 'pending', 'sent again (rejected UTR can be reused)');
});

await step('payments turned off: checkout says so and new payments are refused', async () => {
  await admin('PUT', '/settings/payment', { enabled: false });
  eq((await as(A)('GET', '/subscription/payment-info')).enabled, false, 'off');
  const C = await otpUser('Third');
  await fails(as(C)('POST', '/subscription/payments', { planId: plan.id, utr: `55${stamp}3333` }), 'PAYMENTS_DISABLED', 'off');
  await admin('POST', `/users/${C.user.id}/action`, { action: 'delete' }).catch(() => {});
});

// cleanup: UPI back to what it was, QR removed, plan archived, users deleted
await admin('DELETE', '/settings/payment/qr').catch(() => {});
await admin('PUT', '/settings/payment', { enabled: before.enabled !== false, upiId: before.upiId ?? 'flipflops@upi', payeeName: before.payeeName ?? 'SecureChat' }).catch(() => {});
if (plan) await admin('PATCH', `/plans/${plan.id}`, { archived: true, visible: false }).catch(() => {});
for (const s of [A, B]) await admin('POST', `/users/${s.user.id}/action`, { action: 'delete' }).catch(() => {});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
process.exit(passed === results.length ? 0 : 1);
