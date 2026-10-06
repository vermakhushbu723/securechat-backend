import { logger } from '../config/logger.js';
import { mailEnabled as poolEnabled, sendFromPool } from '../modules/mail/mail.pool.js';

/**
 * Outgoing email (OTP codes, admin notices) through the mailbox pool
 * (admin panel -> Email Accounts, or SMTP_HOST / SMTP_USER / SMTP_PASS in .env).
 * Without any mailbox the OTP is only logged (and returned in OTP_DEV_MODE).
 */
export const mailEnabled = () => poolEnabled();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** true = sent, false = no mailbox configured; throws 503 EMAIL_UNAVAILABLE when every mailbox failed. */
export async function sendOtpEmail(to, code) {
  if (!(await poolEnabled())) {
    logger.info({ to }, 'No mailbox configured - OTP email not sent');
    return false;
  }
  await sendFromPool({
    to,
    subject: `${code} is your SecureChat code`,
    text: `Your SecureChat verification code is ${code}. It expires in 5 minutes. Do not share it with anyone.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #E7E3F8;border-radius:12px">
      <h2 style="color:#6C2BF2;margin:0 0 12px">SecureChat</h2>
      <p style="color:#1A1640">Your verification code is</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#1A1640;margin:8px 0">${code}</p>
      <p style="color:#6B6790;font-size:13px">It expires in 5 minutes. Do not share it with anyone.</p>
    </div>`,
  });
  return true;
}

/** Admin broadcast (Notifications screen, channel "Email"). */
export async function sendNoticeEmail(to, title, body) {
  if (!(await poolEnabled())) return false;
  await sendFromPool({
    to,
    subject: title,
    text: body,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #E7E3F8;border-radius:12px">
      <h2 style="color:#6C2BF2;margin:0 0 12px">SecureChat</h2>
      <h3 style="color:#1A1640;margin:0 0 8px">${escapeHtml(title)}</h3>
      <p style="color:#1A1640;white-space:pre-line">${escapeHtml(body)}</p>
    </div>`,
  });
  return true;
}
