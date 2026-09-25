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

const DIGITS = /\d/;
const LINK = /(https?:\/\/|www\.|\.com\b|\.in\b|\.net\b|t\.me\/|bit\.ly)/i;
const CONTACT = /(whats\s?app|telegram|insta(gram)?|snapchat|facebook|@\w{3,})/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PERSONAL = /(aadhaar|aadhar|pan\s?card|passport|address\s*:)/i;
const REPEAT = /\b(\w+(?:\s+\w+){0,2})\b(?:\s+\1\b){2,}/i;

/**
 * Upper-case word tokens. Letters separated by spaces ("T H R E E") are
 * joined and digits act as separators ("ONE1" -> "ONE").
 */
export function tokens(text) {
  const raw = text
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
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

/** Returns the first violated rule name, or null when the text is allowed. */
export function checkContent(text, { enabled, abuseWords }) {
  if (!text) return null;
  const on = new Set(enabled);
  const abuse = new Set(abuseWords.map((w) => w.toUpperCase()));
  const words = tokens(text);
  if (on.has('abuse') && words.some((w) => abuse.has(w))) return 'abuse';
  if (on.has('numbers') && DIGITS.test(text)) return 'numbers';
  if (on.has('numberWords') && words.some((w) => NUMBER_WORDS.has(w))) return 'numberWords';
  if (on.has('spam') && REPEAT.test(text)) return 'spam';
  if (on.has('links') && LINK.test(text)) return 'links';
  if (on.has('personalInfo') && (EMAIL.test(text) || PERSONAL.test(text))) return 'personalInfo';
  if (on.has('externalContact') && CONTACT.test(text)) return 'externalContact';
  return null;
}
