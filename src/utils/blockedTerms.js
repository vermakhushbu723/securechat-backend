/**
 * Admin "Blocked Keywords": words, sentences and links that cannot be sent in 1-to-1
 * chats or groups. The app runs the same rules while typing (send button disabled),
 * the server enforces them on every send / edit.
 *
 * Matching (case insensitive):
 *  - word / sentence: whole words; spaces inside a sentence match any whitespace.
 *    `partial` also matches inside longer words ("test" blocks "testing").
 *  - link: protocol and "www." are ignored, so "bit.ly" blocks "https://www.bit.ly/abc".
 */
const URLISH = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i;

/** Lower case, unicode normalised, single spaces. */
export const normalize = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Link text without protocol / www / trailing slash. */
export const normalizeLink = (s) => normalize(s).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

/** word | sentence | link, from what the admin typed. */
export function typeOf(text) {
  const t = String(text ?? '').trim();
  if (!/\s/.test(t) && URLISH.test(t)) return 'link';
  return /\s/.test(t) ? 'sentence' : 'word';
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compiles one term to a test function. */
export function compile(term) {
  if (term.type === 'link') {
    const needle = normalizeLink(term.text);
    return (text) => {
      const t = normalize(text);
      if (!needle) return false;
      // Links inside the message, with protocol / www removed.
      const links = t.replace(/https?:\/\//g, ' ').replace(/(^|[\s(])www\./g, '$1');
      return links.includes(needle);
    };
  }
  const words = normalize(term.text).split(' ').filter(Boolean).map(escape);
  if (!words.length) return () => false;
  const body = words.join('\\s+');
  const re = term.partial ? new RegExp(body, 'iu') : new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu');
  return (text) => re.test(String(text ?? '').normalize('NFKC'));
}

/** First matching term (or null). `scope`: 'direct' | 'groups'. */
export function findBlocked(text, compiled, scope) {
  if (!text || !String(text).trim()) return null;
  for (const c of compiled) {
    if (c.scope !== 'all' && c.scope !== scope) continue;
    if (c.test(text)) return c.term;
  }
  return null;
}
