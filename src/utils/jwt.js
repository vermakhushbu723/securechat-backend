import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

export function signAccessToken(userId) {
  return jwt.sign({ typ: 'access' }, env.JWT_ACCESS_SECRET, {
    subject: String(userId),
    expiresIn: env.JWT_ACCESS_TTL,
  });
}

export function signRefreshToken(userId) {
  const jti = randomUUID();
  const token = jwt.sign({ typ: 'refresh' }, env.JWT_REFRESH_SECRET, {
    subject: String(userId),
    jwtid: jti,
    expiresIn: `${env.JWT_REFRESH_TTL_DAYS}d`,
  });
  return { token, jti };
}

export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (payload.typ !== 'access') throw new Error('wrong token type');
    return payload;
  } catch {
    throw ApiError.unauthorized('Invalid or expired access token');
  }
}

export function verifyRefreshToken(token) {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET);
    if (payload.typ !== 'refresh') throw new Error('wrong token type');
    return payload;
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }
}
