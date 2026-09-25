import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import jwt from 'jsonwebtoken';

import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { FileAccessLog, SecureFile } from './secureFile.model.js';

export const SECURE_ROOT = path.resolve(env.SECURE_UPLOAD_DIR);
const KEY = Buffer.from(env.FILE_ENCRYPTION_KEY, 'hex');
const TOKEN_TTL_SEC = 30 * 60; // "Session 30 min" in the secure viewer

/** Encrypts an uploaded temp file into secure storage and deletes the plaintext. */
export async function storeEncrypted(tempPath, { owner, name, mimeType, kind, size, width, height, duration }) {
  const now = new Date();
  const rel = path.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), `${randomUUID()}.enc`);
  const dest = path.join(SECURE_ROOT, rel);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  try {
    await pipeline(fs.createReadStream(tempPath), cipher, fs.createWriteStream(dest));
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
  const file = await SecureFile.create({
    owner,
    name,
    mimeType,
    kind,
    size,
    width,
    height,
    duration,
    path: rel,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  });
  await logFileAction(file._id, owner, 'uploaded');
  return file;
}

/** Decrypting read stream (the auth tag is verified when the stream ends). */
export function openDecryptedStream(file) {
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(file.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(file.authTag, 'hex'));
  return fs.createReadStream(path.join(SECURE_ROOT, file.path)).pipe(decipher);
}

export function signFileToken(userId, fileId) {
  return {
    token: jwt.sign({ typ: 'file', fid: String(fileId) }, env.FILE_TOKEN_SECRET, {
      subject: String(userId),
      expiresIn: TOKEN_TTL_SEC,
    }),
    expiresIn: TOKEN_TTL_SEC,
  };
}

export function verifyFileToken(token) {
  try {
    const p = jwt.verify(token, env.FILE_TOKEN_SECRET);
    if (p.typ !== 'file') throw new Error('bad type');
    return { userId: p.sub, fileId: p.fid };
  } catch {
    throw ApiError.unauthorized('Viewer session expired, open the file again');
  }
}

export function logFileAction(fileId, userId, action, ip) {
  return FileAccessLog.create({ file: fileId, user: userId, action, ip });
}

/** Revokes every file attached to the given messages (delete / expiry). */
export async function revokeFilesOfMessages(messageIds) {
  if (!messageIds.length) return;
  await SecureFile.updateMany({ message: { $in: messageIds }, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
