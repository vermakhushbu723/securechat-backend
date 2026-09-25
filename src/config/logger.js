import pino from 'pino';

import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { pid: process.pid },
  redact: ['req.headers.authorization', 'password', 'refreshToken', 'accessToken'],
  timestamp: pino.stdTimeFunctions.isoTime,
});
