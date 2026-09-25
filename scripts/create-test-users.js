/**
 * Creates (or logs in) the two test users and opens a conversation between them.
 * Use these credentials to log in from two browsers / devices in the user app.
 */
import { api, loginOrRegister, TEST_USERS } from './lib/client.js';

const [a, b] = await Promise.all(TEST_USERS.map(loginOrRegister));
const conversation = await api('POST', '/conversations', { token: a.accessToken, body: { userId: b.user.id } });

console.log('\nTest users ready:\n');
for (const [u, s] of [
  [TEST_USERS[0], a],
  [TEST_USERS[1], b],
]) {
  console.log(`  ${u.name.padEnd(14)} id=${s.user.id}  login: ${u.username} / ${u.password}  (phone ${u.phone})`);
}
console.log(`\n  Conversation id: ${conversation.id}\n`);
