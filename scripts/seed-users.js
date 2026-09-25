/**
 * Creates 5 more demo users (idempotent: existing ones are just logged in),
 * opens a chat between each of them and aman_test and sends a first message,
 * so they show up in the Direct list.   npm run seed:users
 */
import { api, clientId, loginOrRegister, TEST_USERS } from './lib/client.js';

const PASSWORD = 'Test@12345';
const USERS = [
  { name: 'Rahul Kumar', username: 'rahul_test', phone: '+919000000003', greeting: 'Hi Aman! Rahul here 👋' },
  { name: 'Neha Singh', username: 'neha_test', phone: '+919000000004', greeting: 'Hey, are we meeting today?' },
  { name: 'Amit Sharma', username: 'amit_test', phone: '+919000000005', greeting: 'Please check the design files 📄' },
  { name: 'Sohan Patel', username: 'sohan_test', phone: '+919000000006', greeting: 'Okay, see you soon 🙂' },
  { name: 'Riya Verma', username: 'riya_test', phone: '+919000000007', greeting: 'Thank you! ❤️' },
];

const aman = await loginOrRegister(TEST_USERS[0]);
console.log('\nDemo users:\n');
for (const u of USERS) {
  const { greeting, ...profile } = u;
  const s = await loginOrRegister({ ...profile, password: PASSWORD });
  const conv = await api('POST', '/conversations', { token: s.accessToken, body: { userId: aman.user.id } });
  if (!conv.lastMessage) {
    await api('POST', `/conversations/${conv.id}/messages`, {
      token: s.accessToken,
      body: { clientMsgId: clientId(), type: 'text', text: greeting },
    });
  }
  console.log(`  ${u.name.padEnd(12)} id=${s.user.id}  login: ${u.username} / ${PASSWORD}  (phone ${u.phone})`);
}
console.log(`\nEach one has a chat with ${TEST_USERS[0].name} (aman_test).\n`);
