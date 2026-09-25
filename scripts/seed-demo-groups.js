/**
 * Creates demo groups with the seed users and a real conversation in them
 * (text, reply, reactions, image, protected file, location, forward) so the
 * app has live data to look at:
 *   npm run seed:groups      (server must be running, run seed:users first)
 */
import sharp from 'sharp';

import { api, BASE_URL, clientId, connectSocket, emit, loginOrRegister, TEST_USERS } from './lib/client.js';

const PASSWORD = 'Test@12345';
const EXTRA = [
  { name: 'Rahul Kumar', username: 'rahul_test', phone: '+919000000003', password: PASSWORD },
  { name: 'Neha Singh', username: 'neha_test', phone: '+919000000004', password: PASSWORD },
  { name: 'Amit Sharma', username: 'amit_test', phone: '+919000000005', password: PASSWORD },
  { name: 'Sohan Patel', username: 'sohan_test', phone: '+919000000006', password: PASSWORD },
  { name: 'Riya Verma', username: 'riya_test', phone: '+919000000007', password: PASSWORD },
];

console.log(`\nSeeding demo groups against ${BASE_URL}\n`);
const [A, P, R, N, M, S, V] = await Promise.all([...TEST_USERS, ...EXTRA].map(loginOrRegister));
const tok = (u) => u.accessToken;
const sock = {};
for (const [k, u] of Object.entries({ A, P, R, N, M, S, V })) sock[k] = await connectSocket(tok(u));

const send = (k, groupId, p) => emit(sock[k], 'group:message:send', { groupId, clientMsgId: clientId(), type: 'text', ...p });
async function upload(u, { buffer, filename, mime, secure }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  if (secure) form.append('secure', 'true');
  return api('POST', '/media/upload', { token: tok(u), form });
}
const join = (u, code, body = {}) => api('POST', `/invites/${code}/join`, { token: tok(u), body });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Re-running replaces the demo groups instead of duplicating them.
const DEMO = ['Lucknow Business Community', 'Field Team Lucknow', 'Design Review'];
for (const u of [A, P, R]) {
  const mine = await api('GET', '/groups?filter=created', { token: tok(u) });
  for (const g of mine.items ?? mine) if (DEMO.includes(g.name)) await api('DELETE', `/groups/${g.id}`, { token: tok(u) });
}

// Everyone shares location on join; live for two members.
for (const u of [A, P, R, N, M, S, V]) await api('PUT', '/location/settings', { token: tok(u), body: { mode: 'join', intervalMin: 10 } });

// ---------------------------------------------------------------- group 1
const { group: g1, invite: inv1 } = await api('POST', '/groups', {
  token: tok(A),
  body: {
    name: 'Lucknow Business Community',
    description: 'Business updates, meetups and deals around Lucknow',
    category: 'Business',
    rules: '1. Be respectful\n2. No spam or selling\n3. Protected files stay in the app',
    settings: {
      location: { requirement: 'optional', visibility: 'groupMembers', shareMode: 'join' },
      messages: { messageMode: 'user_select', membersCanSendMedia: true },
      security: { dynamicWatermark: true, trackForwardChain: true },
    },
    invite: { expiry: '7d', maxJoins: 0 },
  },
});
const places = [
  [P, 26.8467, 80.9462, 'Hazratganj, Lucknow'],
  [R, 26.8606, 80.9956, 'Gomti Nagar, Lucknow'],
  [N, 26.8923, 80.9425, 'Aliganj, Lucknow'],
  [M, 26.8497, 80.9227, 'Aminabad, Lucknow'],
  [S, 26.8381, 80.9346, 'Charbagh, Lucknow'],
  [V, 26.8728, 80.9869, 'Indira Nagar, Lucknow'],
];
for (const [u, lat, lng, place] of places) await join(u, inv1.code, { location: { lat, lng, place }, shareMode: 'join' });
await api('POST', '/location/update', { token: tok(A), body: { lat: 26.855, lng: 80.95, place: 'Kaiserbagh, Lucknow', source: 'manual' } });

// Rahul becomes admin.
await api('PATCH', `/groups/${g1.id}/members/${R.user.id}`, { token: tok(A), body: { role: 'admin' } });

const m1 = await send('A', g1.id, { text: 'Welcome everyone to Lucknow Business Community! 🎉' });
await pause(150);
await send('P', g1.id, { text: 'Thanks Aman! Happy to be here.' });
await send('R', g1.id, { text: 'Meetup this Saturday evening at Hazratganj. Who is coming?', replyToId: m1.id });
const m4 = await send('N', g1.id, { text: 'Count me in 🙋‍♀️' });
await emit(sock.A, 'group:message:react', { messageId: m4.id, emoji: '❤️' });
await emit(sock.R, 'group:message:react', { messageId: m4.id, emoji: '👍' });

const png = await sharp({ create: { width: 640, height: 400, channels: 3, background: { r: 99, g: 102, b: 241 } } })
  .composite([{ input: Buffer.from('<svg width="640" height="400"><text x="50%" y="50%" font-size="44" fill="white" text-anchor="middle" font-family="Arial">Meetup Venue</text></svg>'), top: 0, left: 0 }])
  .png()
  .toBuffer();
const img = await upload(M, { buffer: png, filename: 'venue.png', mime: 'image/png' });
await send('M', g1.id, { type: 'image', text: 'Venue photo', media: img, visibility: 'public', allowDownload: true });

const pricing = Buffer.from('Q4 PRICING (CONFIDENTIAL)\n\nBasic   : 999 / month\nPro     : 2499 / month\nEnterprise: on request\n\nDo not share outside the group.\n');
const sec = await upload(A, { buffer: pricing, filename: 'Pricing_Q4.txt', mime: 'text/plain', secure: true });
const secMsg = await send('A', g1.id, {
  type: 'file',
  text: 'Quarterly pricing - private, view only in app',
  media: { secureFileId: sec.secureFileId, mimeType: 'text/plain', size: pricing.length, name: 'Pricing_Q4.txt' },
  visibility: 'private',
});
const hp = await upload(A, { buffer: png, filename: 'Board_Plan.png', mime: 'image/png', secure: true });
await send('A', g1.id, {
  type: 'image',
  text: 'Board plan - highly protected',
  media: { secureFileId: hp.secureFileId, mimeType: 'image/png', size: png.length, name: 'Board_Plan.png' },
  visibility: 'highly_protected',
});
await send('S', g1.id, { type: 'location', location: { lat: 26.8381, lng: 80.9346, name: 'Charbagh, Lucknow' } });
await send('V', g1.id, { text: 'I will share details in the meetup 🙂' });

// ---------------------------------------------------------------- group 2
const { group: g2, invite: inv2 } = await api('POST', '/groups', {
  token: tok(R),
  body: {
    name: 'Field Team Lucknow',
    description: 'Live location group for the field team',
    category: 'Work',
    settings: { location: { requirement: 'mandatory', shareMode: 'live', liveIntervalMin: 10, visibility: 'groupMembers' } },
    invite: { expiry: '24h', maxJoins: 20 },
  },
});
for (const [u, lat, lng, place] of [places[1], places[2], places[4]].map((p, i) => [[A, N, S][i], p[1], p[2], p[3]])) {
  await join(u, inv2.code, { location: { lat, lng, place }, shareMode: 'live' });
}
// Live location for Rahul and Neha (after every group exists, so all of them get it).
for (const u of [R, N]) {
  await api('PUT', '/location/settings', { token: tok(u), body: { mode: 'live', intervalMin: 10, liveForMinutes: 480 } });
}
await api('POST', '/location/update', { token: tok(R), body: { lat: 26.8612, lng: 80.9961, place: 'Gomti Nagar, Lucknow', source: 'live' } });
await api('POST', '/location/update', { token: tok(N), body: { lat: 26.8918, lng: 80.9431, place: 'Aliganj, Lucknow', source: 'live' } });
await send('R', g2.id, { text: 'Please keep live location ON during duty hours.' });
await send('A', g2.id, { text: 'Done ✅' });

// ---------------------------------------------------------------- group 3
const { group: g3, invite: inv3 } = await api('POST', '/groups', {
  token: tok(P),
  body: {
    name: 'Design Review',
    description: 'Admins only announcements',
    category: 'Work',
    settings: { messages: { whoCanSend: 'admins', messageMode: 'public' }, members: { approveNewMembers: true } },
    invite: { expiry: '7d', maxJoins: 0, requireApproval: true },
  },
});
await join(A, inv3.code);
await join(M, inv3.code);
await api('POST', `/groups/${g3.id}/requests/${A.user.id}/approve`, { token: tok(P) });
await api('POST', `/groups/${g3.id}/requests/${M.user.id}/approve`, { token: tok(P) });
await send('P', g3.id, { text: 'New design files will be shared here. Only admins can post.' });
await emit(sock.P, 'group:message:forward', { messageIds: [m1.id], toGroupIds: [g3.id], clientMsgId: clientId() }).catch((e) => console.log('  forward:', e.message));

for (const s of Object.values(sock)) s.close();

console.log('  Created:');
for (const [g, inv] of [[g1, inv1], [g2, inv2], [g3, inv3]]) console.log(`   - ${g.name.padEnd(28)} id=${g.id}  invite=${inv.code}`);
console.log(`\n  Protected file id: ${sec.secureFileId} (message ${secMsg.id})`);
console.log(`  Login any user with password ${PASSWORD}: aman_test, priya_test, rahul_test, neha_test, amit_test, sohan_test, riya_test\n`);
process.exit(0);
