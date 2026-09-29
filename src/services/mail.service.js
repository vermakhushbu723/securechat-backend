import nodemailer from 'nodemailer';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

let transport = null;

/** SMTP is optional: without SMTP_HOST the OTP is only logged (and returned in OTP_DEV_MODE). */
export const mailEnabled = () => Boolean(env.SMTP_HOST);

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

export async function sendOtpEmail(to, code) {
  if (!mailEnabled()) {
    logger.info({ to }, 'SMTP not configured - OTP email not sent');
    return false;
  }
  await getTransport().sendMail({
    from: env.SMTP_FROM || env.SMTP_USER,
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
