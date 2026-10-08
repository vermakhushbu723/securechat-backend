/**
 * Server side message processing engine (the client runs the same rules only
 * for instant feedback). Order follows the spec:
 * abuse -> numbers -> number words -> spam -> links -> personal info -> external contact.
 */
const NUMBER_WORDS = new Set([
  'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
  'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
  'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY',
  'HUNDRED', 'THOUSAND', 'LAKH', 'CRORE', 'MILLION', 'BILLION',
]);

// Hindi / Hinglish number words (admin: "Hindi number words (ek, do, teen...)"). Words that are
// also common English words ("do", "no", "sat") are left out so normal messages still pass.
const HINDI_NUMBER_WORDS = new Set([
  'SHUNYA', 'EK', 'TEEN', 'CHAAR', 'PAANCH', 'PANCH', 'CHHE', 'CHHAH', 'SAAT', 'AATH',
  'NAU', 'DAS', 'GYARAH', 'BARAH', 'TERAH', 'CHAUDAH', 'PANDRAH', 'SOLAH', 'SATRAH', 'ATHARAH', 'UNNIS',
  'BEES', 'TEES', 'CHALIS', 'PACHAS', 'SATTAR', 'ASSI', 'NABBE', 'SAU', 'HAZAR', 'HAZAAR',
]);

// Hinglish abuse list used when "Hindi / Hinglish word list" is on.
export const HINGLISH_ABUSE = ['KAMINA', 'KAMINE', 'KUTTA', 'KUTTE', 'HARAMI', 'SAALA', 'SALA', 'GADHA', 'ULLU', 'BEWAKOOF', 'CHUTIYA', 'BHADWA'];

const DIGITS = /\d/;
// Links: http / https, www., any "name.tld" (also "name . com", "name dot com", "name(dot)in").
const TLDS =
  'com|net|org|in|co|io|ai|app|dev|me|info|biz|xyz|online|site|store|shop|live|link|club|tech|tv|us|uk|ly|gl|gg|cc|ws|pro|top|vip|blog|news|edu|gov|page|website|space|fun|icu|cloud|digital|email|world|today|life|one|ink|ru|cn|de|fr|jp|au|ca|pk|bd|np|lk|ae|sa|eu|asia|mobi|tk|ml|ga|cf|gq|im|fm|sh|tel|to|be|lol|wiki|work|art|bio|chat|social|media|zone|network|group|team|agency|services|solutions';
const DOT = '[.\\u3002\\uFF0E]';
const LINK_PATTERNS = [
  /\b(?:h\s*t\s*t\s*p\s*s?|hxxps?|ftp)\s*:\s*\/?\s*\/?/i, // http:// https:// (also "h t t p s :")
  /\b(?:https?|hxxps?)\b/i, // the word http / https alone
  new RegExp(`\\bw\\s*w\\s*w\\s*${DOT}`, 'i'), // www.
  new RegExp(`\\b[a-z0-9][a-z0-9-]*(?:${DOT}[a-z0-9-]+)*${DOT}(?:${TLDS})\\b`, 'i'), // name.tld
  new RegExp(`\\b[a-z0-9][a-z0-9-]*(?:\\s+${DOT}\\s*|${DOT}\\s+)(?:com|net|org)\\b`, 'i'), // name . com
  new RegExp(`(?:[([{<]\\s*dot\\s*[)\\]}>]|\\bdot\\b)\\s*(?:${TLDS})\\b`, 'i'), // name dot com, name(dot)in
  /\b(?:t\.me|wa\.me|bit\.ly|tinyurl|goo\.gl)\b/i,
];

/** True when the text has a link or a domain in any form. */
export function containsLink(text) {
  if (!text) return false;
  return LINK_PATTERNS.some((r) => r.test(text));
}
const CONTACT = /(whats\s?app|telegram|insta(gram)?|snapchat|facebook|@\w{3,})/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PERSONAL = /(aadhaar|aadhar|pan\s?card|passport|address\s*:)/i;
const REPEAT = /\b(\w+(?:\s+\w+){0,2})\b(?:\s+\1\b){2,}/i;
const LEET = { '@': 'A', 4: 'A', 8: 'B', 3: 'E', 1: 'I', '!': 'I', 0: 'O', $: 'S', 5: 'S', 7: 'T' };

/**
 * Upper-case word tokens. Letters separated by spaces ("T H R E E") are
 * joined and digits act as separators ("ONE1" -> "ONE").
 */
export function tokens(text, { normalize = true } = {}) {
  const raw = text
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  if (!normalize) return raw;
  const out = [];
  let buffer = '';
  for (const t of raw) {
    if (t.length === 1) {
      buffer += t;
    } else {
      if (buffer) {
        out.push(buffer);
        buffer = '';
      }
      out.push(t);
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

/** "b@dw0rd" -> "BADWORD" (only used for the abuse check). */
const deLeet = (text) => text.replace(/[@4831!0$57]/g, (c) => LEET[c] ?? c);

/**
 * Abuse word matcher. `word*` matches any word starting with `word`; multi word
 * phrases ("free recharge") match the normalised text. Sensitivity 3 also matches
 * a blocked word inside a longer word.
 */
function matchesAbuse(text, list, { misspellings, sensitivity }) {
  if (!list.length) return false;
  const words = tokens(misspellings ? deLeet(text) : text);
  const joined = ` ${words.join(' ')} `;
  for (const raw of list) {
    const w = raw.toUpperCase().trim();
    if (!w) continue;
    if (w.includes(' ')) {
      if (joined.includes(` ${w} `)) return true;
    } else if (w.endsWith('*')) {
      const stem = w.slice(0, -1);
      if (stem && words.some((t) => t.startsWith(stem))) return true;
    } else if (words.includes(w) || (sensitivity >= 3 && w.length >= 4 && words.some((t) => t.includes(w)))) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the first violated rule name, or null when the text is allowed.
 * Options (admin panel): abuse word list, Hinglish list, misspelling detection,
 * sensitivity 1-3, Hindi number words.
 */
export function checkContent(text, { enabled, abuseWords = [], hinglish = false, misspellings = false, sensitivity = 2, hindiNumbers = false, normalization = true }) {
  if (!text) return null;
  const on = new Set(enabled);
  const words = tokens(text, { normalize: normalization });
  const abuseList = [...abuseWords, ...(hinglish ? HINGLISH_ABUSE : [])];
  if (on.has('abuse') && matchesAbuse(text, abuseList, { misspellings, sensitivity })) return 'abuse';
  if (on.has('numbers') && DIGITS.test(text)) return 'numbers';
  if (on.has('numberWords') && words.some((w) => NUMBER_WORDS.has(w) || (hindiNumbers && HINDI_NUMBER_WORDS.has(w)))) return 'numberWords';
  if (on.has('spam') && REPEAT.test(text)) return 'spam';
  if (on.has('links') && containsLink(text)) return 'links';
  if (on.has('personalInfo') && (EMAIL.test(text) || PERSONAL.test(text))) return 'personalInfo';
  if (on.has('externalContact') && CONTACT.test(text)) return 'externalContact';
  return null;
}
