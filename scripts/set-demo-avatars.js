/**
 * Gives a few demo users a profile photo (DP):   npm run seed:avatars
 * Illustrated avatars from DiceBear (avataaars); falls back to a generated
 * gradient image when offline. Uploaded through /media/upload like the app does.
 */
import sharp from 'sharp';

import { api, loginOrRegister, TEST_USERS } from './lib/client.js';

const PASSWORD = 'Test@12345';
const TARGETS = [
  { username: 'priya_test', seed: 'Priya', colors: ['#f472b6', '#8b5cf6'], style: 'top=straight01&hairColor=2c1b18&backgroundColor=ffd5dc' },
  { username: 'rahul_test', seed: 'Rahul', colors: ['#38bdf8', '#6366f1'], style: 'top=shortFlat&hairColor=2c1b18&backgroundColor=b6e3f4' },
  { username: 'neha_test', seed: 'Neha', colors: ['#fbbf24', '#f97316'], style: 'top=bob&hairColor=4a312c&backgroundColor=c0aede' },
];

async function avatarPng({ seed, colors, style }) {
  try {
    const res = await fetch(`https://api.dicebear.com/9.x/avataaars/png?seed=${seed}&size=256&${style}&mouth=smile&eyes=happy&eyebrows=defaultNatural&facialHairProbability=0&accessoriesProbability=0&skinColor=d08b5b&clothing=blazerAndShirt`);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  } catch {
    // offline -> generated image below
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs>
    <rect width="256" height="256" fill="url(#g)"/>
    <circle cx="128" cy="100" r="46" fill="#fff" opacity=".9"/><ellipse cx="128" cy="232" rx="86" ry="70" fill="#fff" opacity=".9"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

for (const t of TARGETS) {
  const known = TEST_USERS.find((u) => u.username === t.username);
  const session = known
    ? await loginOrRegister(known)
    : await api('POST', '/auth/login', { body: { identifier: t.username, password: PASSWORD } });
  const form = new FormData();
  form.append('file', new Blob([await avatarPng(t)], { type: 'image/png' }), `${t.seed.toLowerCase()}-dp.png`);
  const media = await api('POST', '/media/upload', { token: session.accessToken, form });
  const me = await api('PATCH', '/users/me', { token: session.accessToken, body: { avatarUrl: media.url } });
  console.log(`  ${me.name.padEnd(13)} DP -> ${me.avatarUrl}`);
}
console.log('\nDone. Other users see the new photo in the chat list, chat header and contact info.\n');
