import { ApiError } from '../../utils/ApiError.js';
import { clearCooldown, encryptSecret, invalidateAccounts, MailAccount, poolStatus, testAccount } from '../mail/mail.pool.js';

/** Admin "Email Accounts": the mailboxes OTP codes and notices are sent from. */
export async function listAccounts() {
  return { accounts: await poolStatus(), defaults: { host: 'smtp.hostinger.com', port: 465 } };
}

/** Adds mailboxes (or updates the password of an existing one). */
export async function addAccounts(list, { host = 'smtp.hostinger.com', port = 465, dailyLimit = 500 } = {}) {
  const added = [];
  const updated = [];
  for (const { email, password } of list) {
    const e = email.trim().toLowerCase();
    const set = { host, port, secure: port === 465, pass: encryptSecret(password), lastError: null, lastErrorAt: null };
    const existing = await MailAccount.findOne({ email: e }).select('_id').lean();
    if (existing) {
      await MailAccount.updateOne({ _id: existing._id }, { $set: set });
      await clearCooldown(String(existing._id));
      updated.push(e);
    } else {
      await MailAccount.create({ email: e, dailyLimit, ...set });
      added.push(e);
    }
  }
  await invalidateAccounts();
  return { added, updated, accounts: await poolStatus() };
}

export async function updateAccount(id, { email, active, dailyLimit, password, host, port }) {
  const set = {};
  if (email !== undefined) {
    if (await MailAccount.exists({ email, _id: { $ne: id } })) throw ApiError.conflict('Another mailbox already uses this email');
    set.email = email;
  }
  if (active !== undefined) set.active = active;
  if (dailyLimit !== undefined) set.dailyLimit = dailyLimit;
  if (host !== undefined) set.host = host;
  if (port !== undefined) Object.assign(set, { port, secure: port === 465 });
  if (password) Object.assign(set, { pass: encryptSecret(password), lastError: null, lastErrorAt: null });
  const a = await MailAccount.findByIdAndUpdate(id, { $set: set }, { returnDocument: 'after', lean: true });
  if (!a) throw ApiError.notFound('Mailbox not found');
  if (password) await clearCooldown(id);
  await invalidateAccounts();
  return { id: String(a._id), email: a.email };
}

export async function setPasswordAll(password) {
  const rows = await MailAccount.find({}).select('_id').lean();
  for (const r of rows) {
    await MailAccount.updateOne({ _id: r._id }, { $set: { pass: encryptSecret(password), lastError: null, lastErrorAt: null } });
    await clearCooldown(String(r._id));
  }
  await invalidateAccounts();
  return { updated: rows.length };
}

export async function deleteAccount(id) {
  const a = await MailAccount.findByIdAndDelete(id).lean();
  if (!a) throw ApiError.notFound('Mailbox not found');
  await invalidateAccounts();
  return { deleted: true, email: a.email };
}

export async function makeReady(id) {
  await clearCooldown(id);
  return { ready: true };
}

export const sendTest = (id, to) => testAccount(id, to);
