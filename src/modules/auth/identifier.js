const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Login field: mobile number or email ID.
 * Mobile numbers are stored with the country code; a plain 10 digit number is an Indian (+91) number.
 * Returns `{ kind: 'phone' | 'email', value }` or null when neither.
 */
export function normalizeIdentifier(raw) {
  const v = String(raw ?? '').trim();
  if (v.includes('@')) {
    const email = v.toLowerCase();
    return EMAIL.test(email) && email.length <= 100 ? { kind: 'email', value: email } : null;
  }
  const digits = v.replace(/[\s()-]/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return { kind: 'phone', value: `+91${digits}` };
  if (/^0[6-9]\d{9}$/.test(digits)) return { kind: 'phone', value: `+91${digits.slice(1)}` };
  if (/^\+\d{8,15}$/.test(digits)) return { kind: 'phone', value: digits };
  if (/^91[6-9]\d{9}$/.test(digits)) return { kind: 'phone', value: `+${digits}` };
  return null;
}
