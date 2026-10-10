import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ApiError } from '../../utils/ApiError.js';
import { Plan } from '../admin/admin.models.js';
import { UPLOAD_ROOT } from '../media/media.routes.js';
import { getSetting, updateSetting } from '../platform/platform.service.js';
import { ExtensionRequest } from './extensionRequest.model.js';

/**
 * UPI payments for premium plans: the admin sets the UPI ID / QR code (admin panel ->
 * Payments), the app shows them on checkout, the user pays in any UPI app and sends the
 * UTR (transaction ID). The admin checks the payment and approves -> premium for the plan.
 */
export async function paymentInfo() {
  const p = await getSetting('payment');
  return {
    enabled: p.enabled !== false && Boolean(p.upiId || p.qrImageUrl),
    upiId: p.upiId || null,
    payeeName: p.payeeName || 'SecureChat',
    qrImageUrl: p.qrImageUrl || null,
    instructions: p.instructions || '',
  };
}

export async function updatePaymentSettings(patch) {
  return updateSetting('payment', patch);
}

/** Admin uploads a QR image (PNG / JPG / WEBP). The old one is deleted. */
export async function saveQrImage(file) {
  if (!file) throw ApiError.badRequest('Choose a QR image');
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) throw ApiError.badRequest('QR must be a PNG, JPG or WEBP image');
  const dir = path.join(UPLOAD_ROOT, 'payment');
  await fs.mkdir(dir, { recursive: true });
  const ext = file.mimetype.includes('png') ? '.png' : file.mimetype.includes('webp') ? '.webp' : '.jpg';
  const name = `qr-${randomUUID()}${ext}`;
  await fs.writeFile(path.join(dir, name), file.buffer);
  await removeQrFile();
  return updateSetting('payment', { qrImageUrl: `/uploads/payment/${name}` });
}

async function removeQrFile() {
  const { qrImageUrl } = await getSetting('payment');
  if (qrImageUrl?.startsWith('/uploads/payment/')) {
    await fs.unlink(path.join(UPLOAD_ROOT, 'payment', path.basename(qrImageUrl))).catch(() => {});
  }
}

export async function deleteQrImage() {
  await removeQrFile();
  return updateSetting('payment', { qrImageUrl: null });
}

/** "I have paid": plan + UTR go to the admin; premium starts when the admin approves. */
export async function submitPayment(userId, { planId, utr }) {
  const info = await paymentInfo();
  if (!info.enabled) throw ApiError.forbidden('Payments are not available right now', 'PAYMENTS_DISABLED');
  const plan = await Plan.findOne({ _id: planId, archived: false, visible: true }).lean();
  if (!plan) throw ApiError.notFound('Plan not found');
  const code = utr.trim().toUpperCase();
  if (await ExtensionRequest.exists({ utr: code, status: { $ne: 'rejected' } })) {
    throw ApiError.conflict('This UTR / transaction ID was already sent', 'UTR_USED');
  }
  if (await ExtensionRequest.exists({ user: userId, status: 'pending' })) {
    throw ApiError.conflict('You already have a request waiting for the admin', 'REQUEST_PENDING');
  }
  const r = await ExtensionRequest.create({
    user: userId,
    kind: 'premium',
    days: plan.durationDays,
    reason: `${plan.name} plan - paid by UPI`,
    planId: plan._id,
    planName: plan.name,
    amount: plan.price,
    currency: plan.currency,
    utr: code,
    payTo: info.upiId,
  });
  return r.toObject();
}
