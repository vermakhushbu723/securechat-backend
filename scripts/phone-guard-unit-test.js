/**
 * Unit test of the mobile number protection engine (src/utils/phoneGuard.js).
 *   npm run test:phone-unit
 */
import { analyzePhone } from '../src/utils/phoneGuard.js';

const BLOCK = [
  '9876543210', '98765 43210', '98765-43210', '9 8 7 6 5 4 3 2 1 0', 'nine eight seven six five four three two one zero',
  'n i n e 8 7 6', '91', '98', '9@8', '9 8', '98.765.432.10', '9*8*7*6*5*4*3*2*1*0', '98/765/432/10',
  'My number is 9876543210', '98xxxx3210', '98 12 xx 45 67', 'नौ आठ सात छह पांच चार तीन दो एक शून्य',
  'nau aath saat chhah paanch chaar teen do ek zero', '९८७६५४३२१०', '98O7654321', 'call me on double nine eight',
  '+91 98765 43210', 'whatsapp 98', 'Order ID: 9876543210', 'my number is nine', '9​8​7',
];
const ALLOW = ['hello how are you', 'I have one question', 'do you need help?', 'no problem', 'meeting at 5 pm', 'see you in 1 minute', 'sat on the chair', 'call me later', 'phone is broken', 'my number is private'];

let failed = 0;
const check = (ok, label) => {
  if (!ok) failed++;
  console.log(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label}`);
};
for (const t of BLOCK) {
  const r = analyzePhone(t);
  check(r.action === 'block' || r.action === 'block_log', `blocks ${JSON.stringify(t)} (score ${r.score})`);
}
for (const t of ALLOW) check(analyzePhone(t).action === 'allow', `allows ${JSON.stringify(t)}`);
check(analyzePhone('6', { recentDigits: '987' }).action === 'block', 'combines fragments 9 / 8 / 7 / 6');
check(analyzePhone('0', { recentDigits: '987654321' }).reasons.some((r) => r.includes('mobile number split')), 'detects a mobile number split over messages');
check(analyzePhone('8', { recentDigits: '9' }).action === 'allow', 'two single digits alone are allowed');
check(analyzePhone('9876543210').action === 'block_log', '13+ score = block + admin log');
console.log(`\n${failed ? `${failed} failed` : 'all passed'}\n`);
process.exit(failed ? 1 : 0);
