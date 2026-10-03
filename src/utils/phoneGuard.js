/**
 * Mobile number anti-sharing engine (mandatory for every user, 1-to-1 chats and groups).
 *
 * RAW MESSAGE -> unicode normalisation -> zero-width / symbol removal -> Hindi + English
 * number words -> digit extraction -> 10 digit mobile detection -> space / symbol bypass ->
 * previous message combination -> context -> repeated attempts -> RISK SCORE ->
 * ALLOW (0-4) / MASK (5-7) / BLOCK (8-12) / BLOCK + ADMIN LOG (13+).
 *
 * Platform rule on top of the score: two or more digits in one message ("91", "9 8",
 * "9@8", "nine eight") are never allowed. The app runs the same single-message rules
 * while typing; the server also combines the sender's recent fragments.
 */

const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤﻿­]/g;

// Strong English words count alone with context; all words count inside a run of 2+.
const EN = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
// Hindi (Devanagari) words.
const HI = { शून्य: '0', सुन्न: '0', एक: '1', दो: '2', तीन: '3', चार: '4', पांच: '5', पाँच: '5', छह: '6', छः: '6', छे: '6', सात: '7', आठ: '8', नौ: '9', दस: '10' };
// Hinglish words. Several are also English words ("do", "no", "sat"), so they only count inside a run.
const HINGLISH = {
  shunya: '0', sunya: '0', sunna: '0', ek: '1', do: '2', teen: '3', tin: '3', char: '4', chaar: '4', paanch: '5', panch: '5', paach: '5',
  chhah: '6', chhe: '6', chah: '6', che: '6', cheh: '6', saat: '7', sat: '7', aath: '8', ath: '8', nau: '9', no: '9', das: '10',
  o: '0', // "9 o 8"
};
const MULTIPLIERS = { double: 2, triple: 3, dubal: 2, tripal: 3 };

const CONTEXT_MED = /\b(mobile|mob|number|num|no\.?|phone|ph|contact|reach\s+me|mera\s+number|my\s+number|number\s+bhejo|contact\s+karo|phone\s+karo|nambar|numbr)\b/i;
const CONTEXT_HIGH = /\b(whats\s?app|wa|call\s+me|call\s+karo|ping\s+me|telegram|signal|dm\s+me)\b/i;
const MOBILE = /(?<!\d)(?:91|0)?([6-9]\d{9})(?!\d)/;

/** Unicode digits (Devanagari, Arabic-Indic, full width ...) -> ASCII. */
function asciiDigits(s) {
  return s.replace(/\p{Nd}/gu, (d) => {
    const cp = d.codePointAt(0);
    for (const zero of [0x0966, 0x0660, 0x06f0, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0xff10]) {
      if (cp >= zero && cp <= zero + 9) return String(cp - zero);
    }
    return d;
  });
}

/**
 * Tokens: digit groups, words and single letters. Single letters in a row ("n i n e")
 * are joined. Everything else (spaces, - . / * @ , etc.) only separates tokens.
 */
function tokenize(text) {
  const raw = text.match(/[\p{L}\p{M}]+|\d+|[x*#]{2,}/giu) ?? [];
  const out = [];
  let letters = '';
  const flush = () => {
    if (letters) out.push(letters);
    letters = '';
  };
  for (const t of raw) {
    if (/^[a-z]$/i.test(t)) letters += t;
    else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out;
}

/** "98O7" -> "9807", "9l2" -> "912" (only inside tokens that already contain digits). */
function leet(token) {
  if (!/\d/.test(token) || !/[oil]/i.test(token) || /[a-hj-km-np-z]/i.test(token)) return token;
  return token.replace(/[oO]/g, '0').replace(/[iIlL]/g, '1');
}

/**
 * Analyse one message.
 * opts.recentDigits: digits from the sender's recent short messages in the same chat (server).
 * opts.attempts: blocked attempts in the last minutes (server).
 */
export function analyzePhone(input, { recentDigits = '', attempts = 0 } = {}) {
  const reasons = [];
  let score = 0;
  const add = (n, why) => {
    score += n;
    reasons.push(why);
  };
  const original = String(input ?? '');
  if (!original.trim()) return { score: 0, action: 'allow', reasons, digits: '', masked: original };

  // 1. Normalise
  let text = original.normalize('NFKC');
  const hadZeroWidth = ZERO_WIDTH.test(text);
  text = text.replace(ZERO_WIDTH, '');
  const unicodeDigits = /\p{Nd}/u.test(text.replace(/[0-9]/g, ''));
  text = asciiDigits(text).toLowerCase();

  // 2. Tokens -> numeric runs (separators keep a run going, other words end it)
  const tokens = tokenize(text);
  // Letters typed apart ("n i n e") were joined by tokenize: the word is not in the original text.
  const spelled = tokens.some((t) => t.length > 1 && /^[a-z]+$/.test(t) && !original.toLowerCase().includes(t));
  let leeted = false;
  const runs = [];
  let run = null;
  let pendingMultiplier = 1;
  const endRun = () => {
    if (run) runs.push(run);
    run = null;
  };
  for (const raw of tokens) {
    const t = leet(raw);
    if (t !== raw) leeted = true;
    let digits = null;
    let kind = null;
    if (/^\d+$/.test(t)) [digits, kind] = [t, 'digit'];
    else if (EN[t]) [digits, kind] = [EN[t], 'strong'];
    else if (HI[t]) [digits, kind] = [HI[t], 'strong'];
    else if (HINGLISH[t]) [digits, kind] = [HINGLISH[t], 'weak'];
    else if (/^[x*#]{2,}$/i.test(t)) [digits, kind] = ['', 'mask'];
    else if (MULTIPLIERS[t]) {
      pendingMultiplier = MULTIPLIERS[t];
      continue;
    }
    if (kind === null) {
      pendingMultiplier = 1;
      endRun();
      continue;
    }
    if (pendingMultiplier > 1 && digits) digits = digits.repeat(pendingMultiplier);
    pendingMultiplier = 1;
    run ??= { parts: [], words: 0, weakOnly: true, masks: 0 };
    run.parts.push({ digits, kind, token: raw });
    if (kind === 'strong' || kind === 'weak') run.words += 1;
    if (kind !== 'weak' && kind !== 'mask') run.weakOnly = false;
    if (kind === 'mask') run.masks += 1;
  }
  endRun();

  const hasContext = CONTEXT_MED.test(text) || CONTEXT_HIGH.test(text);
  // A run counts when it has 2+ numeric parts, a real digit, or a number word next to context.
  const counted = runs.filter((r) => {
    const numeric = r.parts.filter((p) => p.kind !== 'mask');
    if (numeric.length >= 2) return true;
    if (numeric.some((p) => p.kind === 'digit')) return true;
    return numeric.length === 1 && numeric[0].kind === 'strong' && hasContext;
  });
  const digits = counted.map((r) => r.parts.map((p) => p.digits).join('')).join('');
  const usedWords = counted.some((r) => r.words > 0);
  const bypass = counted.some((r) => r.parts.filter((p) => p.kind !== 'mask').length >= 2 && r.parts.some((p) => p.kind === 'digit'));

  // 3. Scores
  if (digits.length >= 2) add(8, 'numbers are not allowed');
  const mobile = counted.some((r) => MOBILE.test(r.parts.map((p) => p.digits).join(''))) || MOBILE.test(digits);
  if (mobile) {
    add(8, '10 digit mobile number');
    add(3, 'starts with 6-9');
  }
  if (bypass) add(5, 'spaces / symbols between digits');
  if (usedWords) add(6, 'number written in words');
  if (counted.some((r) => r.masks > 0) && digits.length >= 2) add(5, 'partly hidden number (xxxx)');
  if (hadZeroWidth || unicodeDigits || leeted || (spelled && usedWords)) add(10, 'disguised number');
  if (CONTEXT_HIGH.test(text) && digits.length) add(4, 'WhatsApp / call context');
  else if (CONTEXT_MED.test(text) && digits.length) add(3, 'mobile / number context');
  if (recentDigits && digits.length) {
    const combined = recentDigits + digits;
    if (combined.length >= 4) add(8, 'number split across messages');
    if (MOBILE.test(combined)) add(8, 'mobile number split across messages');
  }
  if (attempts > 0 && digits.length) add(5, 'repeated attempt');

  const action = score >= 13 ? 'block_log' : score >= 8 ? 'block' : score >= 5 ? 'mask' : 'allow';
  let masked = original;
  if (action === 'mask') {
    const hide = new Set(counted.flatMap((r) => r.parts.filter((p) => p.kind !== 'mask').map((p) => p.token.toLowerCase())));
    masked = original.replace(/[\p{L}\p{M}]+|\d+/gu, (w) => (hide.has(w.toLowerCase()) || /^\d+$/.test(w) ? '*'.repeat(w.length) : w));
  }
  return { score, action, reasons, digits, masked };
}
