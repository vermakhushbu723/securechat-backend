/**
 * End-to-end test of the mailbox pool (rotation + failover) with local SMTP servers:
 * one mailbox with a wrong password, one that is busy (421 "too many messages"),
 * two that work. Runs its own API server on a separate test database so the live
 * pool is never touched.
 *   npm run test:mail
 */
import 'dotenv/config';

import { spawn, spawnSync } from 'node:child_process';
import dns from 'node:dns';

import mongoose from 'mongoose';
import { SMTPServer } from 'smtp-server';

// Same resolvers as the API (mongodb+srv lookups).
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map((x) => x.trim()).filter(Boolean));

const PORT = 4011;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const TEST_DB = 'securechat_mailtest';
const MONGO_URI = process.env.MONGO_URI.replace(/\/([^/?]*)(\?|$)/, `/${TEST_DB}$2`);
const EMAIL = 'mailtest-admin@example.org';
const PASSWORD = 'MailTest@2026';

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

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${json.error?.code}: ${json.error?.message}`);
    err.code = json.error?.code;
    err.status = res.status;
    throw err;
  }
  return json.data;
}

// ------------------------------------------------------------------ local SMTP servers
const inbox = { good1: [], good2: [] };
function smtp(port, { auth = 'ok', busy = false, box } = {}) {
  const server = new SMTPServer({
    secure: false,
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(a, _s, cb) {
      if (auth === 'bad') return cb(Object.assign(new Error('Invalid login'), { responseCode: 535 }));
      cb(null, { user: a.username });
    },
    onMailFrom(_a, _s, cb) {
      if (busy) return cb(Object.assign(new Error('Too many messages, try again later'), { responseCode: 421 }));
      cb();
    },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        if (box) inbox[box].push({ from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map((r) => r.address), raw });
        cb();
      });
    },
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const servers = await Promise.all([smtp(2531, { auth: 'bad' }), smtp(2532, { busy: true }), smtp(2533, { box: 'good1' }), smtp(2534, { box: 'good2' })]);

// ------------------------------------------------------------------ API server on the test database
const childEnv = { ...process.env, MONGO_URI, PORT: String(PORT), OTP_DEV_MODE: 'true', RUN_WORKERS: 'false', SMTP_HOST: '', LOG_LEVEL: 'warn' };
const made = spawnSync(process.execPath, ['scripts/admin.js', 'staff', EMAIL, PASSWORD, 'Mail Tester', 'super_admin'], { env: childEnv, encoding: 'utf8', timeout: 180_000 });
if (!/ready/.test(made.stdout ?? '')) console.log('staff setup output:', made.stdout, made.stderr, made.error?.message);
const server = spawn(process.execPath, ['src/server.js'], { env: childEnv, stdio: 'ignore' });
for (let i = 0; i < 240; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/ready`)).ok) break;
  } catch {}
  await sleep(500);
}

console.log(`\nSecureChat MAILBOX POOL test (test DB ${TEST_DB}, port ${PORT})\n`);
let token;
const admin = (method, path, body) => api(method, `/admin${path}`, { token, body });
const otp = (n) => api('POST', '/auth/otp/request', { body: { phone: `98765${String(10000 + n).slice(-5)}`, email: `user${n}@example.org` } });

try {
  await step('test API server starts on the test database, admin signs in', async () => {
    token = (await api('POST', '/admin/auth/login', { body: { email: EMAIL, password: PASSWORD } })).token;
  });

  await step('no mailbox yet: OTP falls back to test mode (code returned, not emailed)', async () => {
    const r = await otp(1);
    eq(r.emailed, false, 'not emailed');
    assert(r.devCode, 'test code returned');
  });

  let accounts;
  await step('admin adds 4 mailboxes (passwords stored encrypted)', async () => {
    const r = await admin('POST', '/mail-accounts', {
      host: '127.0.0.1',
      port: 2531,
      accounts: [{ email: 'otp0@prosecurely.online', password: 'wrong' }],
    });
    eq(r.added.length, 1, 'first added');
    for (const [email, port] of [['otp1@prosecurely.online', 2532], ['otp2@prosecurely.online', 2533], ['otp3@prosecurely.online', 2534]]) {
      await admin('POST', '/mail-accounts', { host: '127.0.0.1', port, accounts: [{ email, password: 'secret' }] });
    }
    accounts = (await admin('GET', '/mail-accounts')).accounts;
    eq(accounts.length, 4, 'four mailboxes');
    const raw = await mongoose.createConnection(MONGO_URI).asPromise();
    const row = await raw.db.collection('mailaccounts').findOne({ email: 'otp2@prosecurely.online' });
    assert(row.pass && !row.pass.includes('secret'), 'password is not stored in plain text');
    await raw.close();
  });

  await step('emails are delivered even when mailboxes fail (wrong password, busy)', async () => {
    for (let n = 2; n <= 7; n++) {
      const r = await otp(n);
      eq(r.emailed, true, `OTP ${n} emailed`);
      assert(!r.devCode, 'no test code once email works');
    }
    eq(inbox.good1.length + inbox.good2.length, 6, 'all 6 codes delivered');
    assert(inbox.good1.every((m) => m.from === 'otp2@prosecurely.online') && inbox.good2.every((m) => m.from === 'otp3@prosecurely.online'), 'sent from the working mailbox addresses');
    assert(/is your SecureChat code/.test(inbox.good1[0]?.raw ?? inbox.good2[0].raw), 'OTP subject');
  });

  await step('working mailboxes take turns (rotation)', async () => {
    assert(inbox.good1.length > 0 && inbox.good2.length > 0, `both used: ${inbox.good1.length} / ${inbox.good2.length}`);
  });

  await step('failing mailboxes rest with the reason shown to the admin', async () => {
    const list = (await admin('GET', '/mail-accounts')).accounts;
    const bad = list.find((a) => a.email === 'otp0@prosecurely.online');
    const busy = list.find((a) => a.email === 'otp1@prosecurely.online');
    eq(bad.status, 'Resting', 'wrong password mailbox resting');
    assert(/password/i.test(bad.coolingReason), `reason: ${bad.coolingReason}`);
    assert(bad.coolingSeconds > 3000, 'rests about an hour');
    eq(busy.status, 'Resting', 'busy mailbox resting');
    assert(/busy|limit/i.test(busy.coolingReason), `reason: ${busy.coolingReason}`);
    const good = list.filter((a) => a.status === 'Ready');
    eq(good.length, 2, 'two ready');
    eq(good.reduce((s, a) => s + a.sentToday, 0), 6, 'sent today counted');
  });

  await step('daily limit: a full mailbox is skipped', async () => {
    const g1 = (await admin('GET', '/mail-accounts')).accounts.find((a) => a.email === 'otp2@prosecurely.online');
    await admin('PATCH', `/mail-accounts/${g1.id}`, { dailyLimit: g1.sentToday });
    const before = inbox.good1.length;
    for (let n = 8; n <= 9; n++) await otp(n);
    eq(inbox.good1.length, before, 'full mailbox not used');
    const st = (await admin('GET', '/mail-accounts')).accounts.find((a) => a.email === 'otp2@prosecurely.online');
    eq(st.status, 'Daily limit', 'status');
    await admin('PATCH', `/mail-accounts/${g1.id}`, { dailyLimit: 500 });
  });

  await step('admin test button: works for a good mailbox, explains a bad one', async () => {
    const list = (await admin('GET', '/mail-accounts')).accounts;
    const ok = await admin('POST', `/mail-accounts/${list.find((a) => a.email === 'otp3@prosecurely.online').id}/test`, { to: 'admin@example.org' });
    eq(ok.ok, true, 'good mailbox');
    const bad = await admin('POST', `/mail-accounts/${list.find((a) => a.email === 'otp0@prosecurely.online').id}/test`, { to: 'admin@example.org' });
    eq(bad.ok, false, 'bad mailbox');
    assert(/password/i.test(bad.error), `error: ${bad.error}`);
  });

  await step('every mailbox down: OTP request fails clearly (no fake "sent")', async () => {
    const list = (await admin('GET', '/mail-accounts')).accounts;
    for (const a of list.filter((x) => x.status === 'Ready')) await admin('PATCH', `/mail-accounts/${a.id}`, { active: false });
    let err = null;
    try {
      await otp(10);
    } catch (e) {
      err = e;
    }
    assert(err, 'request should fail');
    eq(err.code, 'EMAIL_UNAVAILABLE', 'error code');
    eq(err.status, 503, 'status');
  });

  await step('fixed password: mailbox ready again right away', async () => {
    const list = (await admin('GET', '/mail-accounts')).accounts;
    const bad = list.find((a) => a.email === 'otp0@prosecurely.online');
    await admin('PATCH', `/mail-accounts/${bad.id}`, { password: 'fixed', port: 2533 });
    const after = (await admin('GET', '/mail-accounts')).accounts.find((a) => a.email === 'otp0@prosecurely.online');
    eq(after.status, 'Ready', 'ready after a new password');
    const r = await otp(11);
    eq(r.emailed, true, 'sent through the fixed mailbox');
  });
} finally {
  server.kill();
  for (const s of servers) s.close();
  const conn = await mongoose.createConnection(MONGO_URI).asPromise();
  await conn.dropDatabase();
  await conn.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
process.exit(passed === results.length ? 0 : 1);
