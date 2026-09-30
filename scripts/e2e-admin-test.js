/**
 * End-to-end test of the admin panel API (every sidebar screen) and its effect on the app:
 * staff login + 2-step, dashboard, users (block / suspend / restrict / access), groups,
 * members, invites, trials, plans, coupons, extension requests, location, message
 * monitoring, forward chains, content filters, security scopes, reports, analytics,
 * notifications, audit logs, staff + roles, system settings.
 *   npm run test:admin   (server running with OTP_DEV_MODE=true)
 *   ADMIN_EMAIL / ADMIN_PASSWORD = a super admin (node scripts/admin.js staff <email> <password>)
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
const fails = async (promise, code, what) => {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  assert(err, `${what}: expected ${code}, but it succeeded`);
  eq(err.code, code, `${what} error code`);
};

let token = null;
const admin = (method, path, body, t = token) => api(method, `/admin${path}`, { token: t, body });
async function raw(path, t = token) {
  return fetch(`${BASE_URL}/api/v1/admin${path}`, { headers: { authorization: `Bearer ${t}` } });
}

async function otpUser(identifier, profile) {
  const req = await api('POST', '/auth/otp/request', { body: { identifier } });
  const s = await api('POST', '/auth/otp/verify', { body: { identifier, code: req.devCode } });
  if (profile) s.user = await api('POST', '/users/me/profile', { token: s.accessToken, body: profile });
  await api('POST', '/subscription/claim-trial', { token: s.accessToken }).catch(() => {});
  return s;
}

console.log(`\nSecureChat ADMIN PANEL test against ${BASE_URL}\n`);
const stamp = Date.now().toString(36);
// Letters only: message text must not trip the number filter.
const word = `zork${stamp.replace(/[^a-z]/g, '')}q`;
const created = { users: [], groups: [], staff: [], plans: [], coupons: [] };

// ---------------------------------------------------------------- auth
await step('staff login: wrong password rejected, 2-step code required, session works', async () => {
  await fails(admin('POST', '/auth/login', { email: EMAIL, password: 'wrong-password' }, null), 'UNAUTHORIZED', 'wrong password');
  const ch = await admin('POST', '/auth/login', { email: EMAIL, password: PASSWORD }, null);
  let session = ch;
  if (ch.twoFactor) {
    assert(ch.challengeId && ch.devCode, '2-step challenge (dev code in test mode)');
    await fails(admin('POST', '/auth/verify', { challengeId: ch.challengeId, code: ch.devCode === '000000' ? '111111' : '000000' }, null), 'BAD_REQUEST', 'wrong code');
    session = await admin('POST', '/auth/verify', { challengeId: ch.challengeId, code: ch.devCode }, null);
  }
  token = session.token;
  eq(session.staff.role, 'super_admin', 'role');
  eq(session.staff.permissions.length, 6, 'all permissions');
  const me = await admin('GET', '/auth/me');
  eq(me.email, EMAIL, 'me');
});

await step('admin API refuses missing / app user tokens', async () => {
  await fails(admin('GET', '/dashboard', undefined, null), 'UNAUTHORIZED', 'no token');
  const u = await otpUser(`adm${stamp}x@example.org`);
  created.users.push(u.user.id);
  await fails(admin('GET', '/dashboard', undefined, u.accessToken), 'UNAUTHORIZED', 'app user token');
});

// ---------------------------------------------------------------- dashboard + search
await step('dashboard: real counts and pending actions', async () => {
  const d = await admin('GET', '/dashboard');
  assert(d.stats.totalUsers > 0, 'total users');
  assert(Array.isArray(d.blockedChart) && d.blockedChart.length === 7, '7 day chart');
  assert(typeof d.pending.extensionRequests === 'number', 'pending counts');
});

// ---------------------------------------------------------------- users
let A;
let B;
await step('users: list, search by name / SC id, details, edit profile', async () => {
  A = await otpUser(`9${String(Date.now()).slice(-9)}`, { accountType: 'personal', name: `Admintest ${stamp} Alpha` });
  B = await otpUser(`8${String(Date.now()).slice(-9)}`, { accountType: 'personal', name: `Admintest ${stamp} Beta` });
  created.users.push(A.user.id, B.user.id);
  const list = await admin('GET', `/users?q=${encodeURIComponent(`Admintest ${stamp}`)}`);
  eq(list.total, 2, 'found both by name');
  const row = list.items.find((u) => u.id === A.user.id);
  assert(row.phone && row.internalId.startsWith('SC-'), 'admin sees phone + user ID');
  const byId = await admin('GET', `/users?q=${row.internalId}`);
  eq(byId.items[0]?.id, A.user.id, 'search by SC id');
  const s = await admin('GET', `/search?q=${row.internalId}`);
  eq(s.users[0]?.id, A.user.id, 'top bar search');
  const d = await admin('GET', `/users/${A.user.id}`);
  eq(d.access, 'trial', 'claimed trial');
  const edited = await admin('PATCH', `/users/${A.user.id}`, { displayName: 'Alphie' });
  eq(edited.displayName, 'Alphie', 'display name edited');
  const act = await admin('GET', `/users/${A.user.id}/activity?days=1`);
  assert(act.events.some((e) => e.title === 'Logged in'), 'login in activity timeline');
  const loc = await admin('GET', `/users/${A.user.id}/location`);
  assert(loc.sharing && Array.isArray(loc.history), 'location view');
});

await step('users: CSV export', async () => {
  const res = await raw(`/users/export.csv?q=${stamp}`);
  eq(res.status, 200, 'status');
  assert(res.headers.get('content-type').includes('text/csv'), 'csv');
  const text = await res.text();
  assert(text.includes(`Admintest ${stamp} Alpha`), 'row in csv');
});

await step('user access: free -> premium -> locked -> trial extended (seen by the app)', async () => {
  const sub = () => api('GET', '/subscription', { token: A.accessToken });
  await admin('POST', '/users/access', { user: A.user.id, kind: 'free', days: 0 });
  eq((await sub()).access, 'free', 'free');
  await admin('POST', '/users/access', { user: A.user.id, kind: 'premium', days: 30 });
  eq((await sub()).access, 'premium', 'premium');
  await admin('POST', '/users/access', { user: A.user.id, kind: 'locked', days: 0 });
  eq((await sub()).access, 'locked', 'locked');
  await admin('POST', `/trials/${A.user.id}`, { action: 'extend', days: 3 });
  const st = await sub();
  eq(st.access, 'trial', 'trial again');
  eq(st.daysLeft, 3, '3 days');
  const acc = await admin('GET', '/access?filter=trial');
  assert(typeof acc.counts.premium === 'number', 'access counts');
});

await step('moderation: restrict (read only) and block really stop the user', async () => {
  const conv = await api('POST', '/conversations', { token: A.accessToken, body: { userId: B.user.id } });
  const send = () => api('POST', `/conversations/${conv.id}/messages`, { token: A.accessToken, body: { clientMsgId: clientId(), type: 'text', text: 'hello' } });
  await send();
  await admin('POST', `/users/${A.user.id}/action`, { action: 'restrict' });
  await fails(send(), 'ACCOUNT_RESTRICTED', 'restricted send');
  await admin('POST', `/users/${A.user.id}/action`, { action: 'unrestrict' });
  await send();
  await admin('POST', `/users/${A.user.id}/action`, { action: 'block', reason: 'test' });
  await fails(api('GET', '/users/me', { token: A.accessToken }), 'ACCOUNT_BLOCKED', 'blocked API');
  const blocked = await admin('GET', `/users/blocked?q=${stamp}`);
  assert(blocked.items.some((u) => u.id === A.user.id), 'in blocked list');
  await admin('POST', `/users/${A.user.id}/action`, { action: 'unblock' });
  await api('GET', '/users/me', { token: A.accessToken });
});

await step('moderation: suspended user cannot sign in; warning counts', async () => {
  await admin('POST', `/users/${B.user.id}/action`, { action: 'suspend', days: 2 });
  const phone = (await admin('GET', `/users/${B.user.id}`)).phone;
  const req = await api('POST', '/auth/otp/request', { body: { identifier: phone } });
  await fails(api('POST', '/auth/otp/verify', { body: { identifier: phone, code: req.devCode } }), 'ACCOUNT_SUSPENDED', 'suspended login');
  await admin('POST', `/users/${B.user.id}/action`, { action: 'unblock' });
  B = await otpUser(phone);
  const w = await admin('POST', `/users/${B.user.id}/action`, { action: 'warn' });
  eq(w.warnings, 1, 'warning added');
});

// ---------------------------------------------------------------- groups
let G;
await step('groups: create for a user, list, details, edit settings', async () => {
  const res = await admin('POST', '/groups', { name: `Admin Test ${stamp}`, creator: A.user.id, settings: { location: { requirement: 'optional' } } });
  G = res.group;
  created.groups.push(G.id);
  assert(res.invite.code, 'invite link created');
  eq(G.createdBy.id, A.user.id, 'creator');
  const list = await admin('GET', `/groups?q=${stamp}`);
  eq(list.items[0]?.id, G.id, 'listed');
  const byCode = await admin('GET', `/groups?q=${res.invite.code}`);
  eq(byCode.items[0]?.id, G.id, 'found by invite code');
  const edited = await admin('PATCH', `/groups/${G.id}`, { description: 'Edited by admin', settings: { messages: { messageMode: 'public' } } });
  eq(edited.settings.messages.messageMode, 'public', 'message mode');
  eq(edited.description, 'Edited by admin', 'description');
});

await step('group members: add, make admin, mute, remove', async () => {
  await admin('POST', `/groups/${G.id}/members`, { user: B.user.id });
  let members = await admin('GET', `/groups/${G.id}/members`);
  eq(members.length, 2, 'two members');
  await admin('PATCH', `/groups/${G.id}/members/${B.user.id}`, { role: 'admin' });
  members = await admin('GET', `/groups/${G.id}/members?role=admin`);
  eq(members[0]?.id, B.user.id, 'B is admin');
  await admin('PATCH', `/groups/${G.id}/members/${B.user.id}`, { role: 'member', restricted: true });
  await fails(api('POST', `/groups/${G.id}/messages`, { token: B.accessToken, body: { clientMsgId: clientId(), type: 'text', text: 'hi' } }), 'RESTRICTED', 'muted member');
  await admin('PATCH', `/groups/${G.id}/members/${B.user.id}`, { restricted: false });
  await api('POST', `/groups/${G.id}/messages`, { token: B.accessToken, body: { clientMsgId: clientId(), type: 'text', text: 'hi again' } });
  const locs = await admin('GET', `/groups/${G.id}/locations`);
  eq(locs.members.length, 2, 'location view lists members');
});

await step('groups: suspend blocks sending, restore allows it', async () => {
  await admin('POST', `/groups/${G.id}/status`, { suspended: true });
  await fails(api('POST', `/groups/${G.id}/messages`, { token: A.accessToken, body: { clientMsgId: clientId(), type: 'text', text: 'x' } }), 'GROUP_SUSPENDED', 'suspended');
  await admin('POST', `/groups/${G.id}/status`, { suspended: false });
  await api('POST', `/groups/${G.id}/messages`, { token: A.accessToken, body: { clientMsgId: clientId(), type: 'text', text: 'back' } });
});

await step('invite links: listed with stats, admin revoke', async () => {
  const links = await admin('GET', `/invites?q=${stamp}`);
  const link = links.items.find((l) => l.groupId === G.id);
  assert(link && link.state === 'Active', 'active link');
  assert(typeof links.stats.active === 'number', 'stats');
  await admin('POST', `/invites/${link.code}/revoke`);
  const after = await admin('GET', `/invites?q=${link.code}`);
  eq(after.items[0].state, 'Revoked', 'revoked');
});

await step('group-wise access: premium for all members', async () => {
  await admin('POST', `/groups/${G.id}/access`, { premium: true, days: 30 });
  const list = await admin('GET', `/access/groups?q=${stamp}`);
  eq(list.items[0].premiumApproved, true, 'premium approved');
  eq(list.items[0].freeAccess, true, 'members use it free');
  await admin('POST', `/groups/${G.id}/access`, { premium: false, freeAccess: false });
});

// ---------------------------------------------------------------- content
await step('content filter: abuse words, misspellings, Hindi numbers (engine test)', async () => {
  const before = await admin('GET', '/settings/content');
  // Earlier interrupted runs may have left test words behind.
  created.contentBefore = { ...before, abuseWords: before.abuseWords.filter((w) => !/^ZORK/.test(w) && w !== 'BADWORD') };
  await admin('PUT', '/settings/content', { abuseWords: [...created.contentBefore.abuseWords, word, 'badword'], misspellings: true, hindiNumbers: true });
  eq((await admin('POST', '/content/test', { text: `you are ${word}`, rules: ['abuse'] })).rule, 'abuse', 'custom word');
  eq((await admin('POST', '/content/test', { text: 'total b@dw0rd', rules: ['abuse'] })).rule, 'abuse', 'misspelling');
  eq((await admin('POST', '/content/test', { text: 'call me ek teen paanch', rules: ['numberWords'] })).rule, 'numberWords', 'Hindi numbers');
  eq((await admin('POST', '/content/test', { text: 'do you need help?', rules: ['numberWords'] })).allowed, true, 'normal English allowed');
});

await step('content moderation: blocked message is logged and actions work', async () => {
  await fails(api('POST', `/groups/${G.id}/messages`, { token: A.accessToken, body: { clientMsgId: clientId(), type: 'text', text: `hello ${word}` } }), 'CONTENT_BLOCKED', 'blocked in group');
  const log = await admin('GET', `/moderation/log?q=${stamp}`);
  const row = log.items.find((r) => r.userId === A.user.id);
  assert(row && row.rule === 'abuse', 'in blocked log');
  const w = await admin('POST', '/moderation/action', { action: 'warn', userId: A.user.id });
  assert(w.warnings >= 2, 'warned');
  await admin('POST', '/moderation/action', { action: 'restrict_member', userId: A.user.id, groupId: G.id });
  const m = (await admin('GET', `/groups/${G.id}/members`)).find((x) => x.id === A.user.id);
  eq(m.memberRestricted, true, 'restricted in group');
  await admin('PATCH', `/groups/${G.id}/members/${A.user.id}`, { restricted: false });
  await admin('PUT', '/settings/content', { abuseWords: created.contentBefore.abuseWords });
});

await step('abuse penalties: blocked messages within 24 hours mute the user', async () => {
  const cs = await admin('GET', '/settings/content');
  await admin('PUT', '/settings/content', { muteAfter: 2, suspendAfter: 0 });
  const send = (text) => api('POST', `/groups/${G.id}/messages`, { token: B.accessToken, body: { clientMsgId: clientId(), type: 'text', text } });
  await fails(send('you idiot'), 'CONTENT_BLOCKED', 'first block');
  await fails(send('stupid person'), 'CONTENT_BLOCKED', 'second block');
  await fails(send('hello again'), 'ACCOUNT_RESTRICTED', 'muted after 2 blocks');
  const u = await admin('GET', `/users/${B.user.id}`);
  eq(u.restricted, true, 'shown as read only');
  await admin('POST', `/users/${B.user.id}/action`, { action: 'unrestrict' });
  await admin('PUT', '/settings/content', { muteAfter: cs.muteAfter, suspendAfter: cs.suspendAfter });
  await send('hello after unmute');
});

let msg;
let G2;
await step('message monitoring: public text visible, metadata for every message', async () => {
  msg = await api('POST', `/groups/${G.id}/messages`, { token: A.accessToken, body: { clientMsgId: clientId(), type: 'text', text: `Monitor message ${word}x` } });
  const list = await admin('GET', `/messages?groupId=${G.id}`);
  const row = list.items.find((m) => m.id === msg.id);
  eq(row.content, `Monitor message ${word}x`, 'public content');
  assert(typeof list.stats.messages24h === 'number', 'stats');
});

await step('forward chains: listed, detail tree, stop forwarding, delete chain', async () => {
  G2 = (await admin('POST', '/groups', { name: `Admin Test ${stamp} B`, creator: A.user.id })).group;
  created.groups.push(G2.id);
  await api('POST', '/group-messages/forward', { token: A.accessToken, body: { messageIds: [msg.id], toGroupIds: [G2.id], clientMsgId: clientId() } });
  const chains = await admin('GET', `/forward-chains?q=${msg.id}`);
  eq(chains.items[0]?.id, msg.id, 'root listed');
  const d = await admin('GET', `/forward-chains/${msg.id}`);
  eq(d.nodes.length, 2, 'original + copy');
  await admin('POST', `/forward-chains/${msg.id}/freeze`, { frozen: true });
  await fails(api('POST', '/group-messages/forward', { token: A.accessToken, body: { messageIds: [msg.id], toGroupIds: [G2.id], clientMsgId: clientId() } }), 'FORWARD_FROZEN', 'frozen');
  const del = await admin('POST', `/forward-chains/${msg.id}/delete`);
  eq(del.deleted, 2, 'chain deleted');
});

await step('security settings: group scope and user scope are enforced', async () => {
  const g = await admin('GET', '/settings/security');
  assert(g.values.screenshotProtection !== undefined, 'global values');
  const gs = await admin('PUT', `/settings/security?scope=group&targetId=${G.id}`, { publicForwarding: false });
  eq(gs.values.publicForwarding, false, 'group value saved');
  const detail = await admin('GET', `/groups/${G.id}`);
  eq(detail.settings.security.publicForwarding, false, 'group setting changed');
  await admin('PUT', `/settings/security?scope=group&targetId=${G.id}`, { publicForwarding: true, privateMessages: true });
  await admin('PUT', `/settings/security?scope=user&targetId=${A.user.id}`, { privateMessages: false });
  await fails(api('POST', `/groups/${G.id}/messages`, { token: A.accessToken, body: { clientMsgId: clientId(), type: 'text', text: 'secret', visibility: 'private' } }), 'PRIVATE_DISABLED', 'user private off');
  await admin('PUT', `/settings/security?scope=user&targetId=${A.user.id}`, { privateMessages: true });
});

await step('location management: dashboard + settings', async () => {
  const l = await admin('GET', '/locations');
  assert(typeof l.stats.live === 'number' && Array.isArray(l.groups), 'overview');
  const s = await admin('PUT', '/settings/location', { autoDeleteDays: 30 });
  eq(s.autoDeleteDays, 30, 'saved');
});

// ---------------------------------------------------------------- reports
await step('abuse reports: list, review, warn user', async () => {
  await api('POST', '/reports', { token: B.accessToken, body: { type: 'user', userId: A.user.id, groupId: G.id, reasons: ['spam'], details: `admin test ${stamp}` } });
  const list = await admin('GET', `/reports?q=${stamp}`);
  const r = list.items[0];
  assert(r && r.target.id === A.user.id, 'report listed');
  eq((await admin('POST', `/reports/${r.id}`, { action: 'review' })).status, 'reviewing', 'under review');
  const done = await admin('POST', `/reports/${r.id}`, { action: 'warn', note: 'first warning' });
  eq(done.status, 'resolved', 'resolved');
  assert(done.resolution.includes('warned'), 'resolution note');
});

await step('analytics: 14 day series + CSV', async () => {
  const a = await admin('GET', '/analytics?days=14');
  eq(a.newUsers.length, 14, 'new users series');
  eq(a.messages.length, 14, 'messages series');
  assert(a.kpis.newUsers >= 2, 'kpi');
  eq((await raw('/analytics/export.csv?days=14')).status, 200, 'csv');
});

// ---------------------------------------------------------------- subscription
await step('plans + coupons: create, edit, archive; app sees visible plans', async () => {
  const p = await admin('POST', '/plans', { name: `Test ${stamp}`, price: 99, period: 'month', durationDays: 30, features: ['Groups', 'Secure files'] });
  created.plans.push(p.id);
  eq((await admin('PATCH', `/plans/${p.id}`, { price: 149 })).price, 149, 'edited');
  const pub = await api('GET', '/subscription/plans', { token: B.accessToken });
  assert(pub.some((x) => x.id === p.id), 'visible to the app');
  await admin('PATCH', `/plans/${p.id}`, { archived: true });
  const pub2 = await api('GET', '/subscription/plans', { token: B.accessToken });
  assert(!pub2.some((x) => x.id === p.id), 'archived hidden');
  const c = await admin('POST', '/coupons', { code: `T${stamp}`.slice(0, 20), percentOff: 20, description: 'Test' });
  eq(c.state, 'Active', 'coupon active');
  await admin('DELETE', `/coupons/${c.id}`);
});

await step('extension requests: approve as premium, trial settings respected', async () => {
  const before = await admin('GET', '/settings/subscription');
  await admin('POST', '/users/access', { user: B.user.id, kind: 'locked', days: 0 });
  const r = await api('POST', '/subscription/requests', { token: B.accessToken, body: { kind: 'extension', reason: 'admin test', days: 7 } });
  const list = await admin('GET', '/requests?status=pending');
  assert(list.items.some((x) => x.id === r.id), 'pending request listed');
  await admin('POST', `/requests/${r.id}`, { approve: true, days: 30, as: 'premium' });
  eq((await api('GET', '/subscription', { token: B.accessToken })).access, 'premium', 'premium granted');
  await admin('PUT', '/settings/subscription', { allowExtensionRequests: false });
  await fails(api('POST', '/subscription/requests', { token: B.accessToken, body: { kind: 'extension' } }), 'REQUESTS_DISABLED', 'requests off');
  await admin('PUT', '/settings/subscription', { allowExtensionRequests: before.allowExtensionRequests });
  const trials = await admin('GET', '/trials');
  assert(typeof trials.stats.active === 'number', 'trial stats');
});

// ---------------------------------------------------------------- system
await step('system settings: direct chat off, registration closed, maintenance mode', async () => {
  const before = await admin('GET', '/settings/system');
  await admin('PUT', '/settings/system', { directChat: false });
  await fails(api('POST', '/conversations', { token: A.accessToken, body: { userId: B.user.id } }), 'DIRECT_CHAT_DISABLED', 'direct chat off');
  await admin('PUT', '/settings/system', { directChat: true, openRegistration: false });
  const req = await api('POST', '/auth/otp/request', { body: { identifier: `new${stamp}@example.org` } });
  await fails(api('POST', '/auth/otp/verify', { body: { identifier: `new${stamp}@example.org`, code: req.devCode } }), 'REGISTRATION_CLOSED', 'registration closed');
  await admin('PUT', '/settings/system', { openRegistration: true, maintenance: true });
  await fails(api('GET', '/users/me', { token: A.accessToken }), 'MAINTENANCE', 'maintenance');
  const cfg = await api('GET', '/config');
  eq(cfg.maintenance, true, 'public config');
  await admin('PUT', '/settings/system', { maintenance: before.maintenance, directChat: before.directChat, openRegistration: before.openRegistration });
  await api('GET', '/users/me', { token: A.accessToken });
  const h = await admin('GET', '/system/health');
  assert(h.services.length >= 6, 'service health');
});

await step('notifications: send now reaches users, scheduled can be cancelled', async () => {
  const n = await admin('POST', '/notifications', { title: `Test ${stamp}`, body: 'Admin test broadcast', audience: 'premium', channels: ['in_app', 'sms'] });
  eq(n.status, 'sent', 'sent');
  assert(n.recipients >= 1, 'recipients');
  assert(n.skipped.includes('sms'), 'sms skipped (no provider)');
  const s = await admin('POST', '/notifications', { title: `Later ${stamp}`, body: 'Scheduled', audience: 'all', channels: ['push'], scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
  eq(s.status, 'scheduled', 'scheduled');
  eq((await admin('POST', `/notifications/${s.id}/cancel`)).status, 'cancelled', 'cancelled');
});

await step('staff + roles: moderator is limited by role permissions', async () => {
  const s = await admin('POST', '/staff', { name: `Mod ${stamp}`, email: `mod${stamp}@example.org`, role: 'moderator' });
  created.staff.push(s.staff.id);
  assert(s.tempPassword, 'temporary password');
  await admin('PATCH', `/staff/${s.staff.id}`, { twoFactor: false });
  const modSession = await admin('POST', '/auth/login', { email: `mod${stamp}@example.org`, password: s.tempPassword }, null);
  await admin('GET', '/users', undefined, modSession.token);
  await fails(admin('GET', '/settings/system', undefined, modSession.token), 'NO_PERMISSION', 'moderator cannot open settings');
  await fails(admin('POST', '/staff', { name: 'x', email: `x${stamp}@example.org`, role: 'support' }, modSession.token), 'NO_PERMISSION', 'only super admin adds staff');
  const roles = await admin('GET', '/roles');
  assert(roles.roles.moderator.includes('users'), 'roles');
});

await step('audit log records admin actions + CSV', async () => {
  const log = await admin('GET', '/audit-logs?q=Blocked user');
  assert(log.items.some((l) => l.action === 'Blocked user'), 'block action logged');
  const cat = await admin('GET', '/audit-logs?category=groups');
  assert(cat.items.every((l) => l.category === 'groups'), 'category filter');
  eq((await raw('/audit-logs/export.csv?days=1')).status, 200, 'csv');
});

// ---------------------------------------------------------------- cleanup
for (const id of created.groups) await admin('DELETE', `/groups/${id}`).catch(() => {});
for (const id of created.staff) await admin('DELETE', `/staff/${id}`).catch(() => {});
for (const id of created.users) await admin('POST', `/users/${id}/action`, { action: 'delete' }).catch(() => {});
for (const id of created.plans) await admin('PATCH', `/plans/${id}`, { archived: true }).catch(() => {});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
process.exit(passed === results.length ? 0 : 1);
