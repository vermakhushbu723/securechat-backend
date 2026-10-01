import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { redis } from './db/redis.js';
import { requireAuth } from './middlewares/auth.js';
import { ApiError } from './utils/ApiError.js';
import { errorHandler, notFoundHandler } from './middlewares/error.js';
import { limiters, rateLimit } from './middlewares/rateLimit.js';
import authRoutes from './modules/auth/auth.routes.js';
import { conversationRouter, messageRouter } from './modules/chat/chat.routes.js';
import {
  fileRouter,
  groupMessageRouter,
  groupRouter,
  inviteRouter,
  locationRouter,
  reportRouter,
  streamSecureFile,
} from './modules/groups/group.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { activeTerms } from './modules/moderation/blockedTerm.service.js';
import { getSetting } from './modules/platform/platform.service.js';
import { subscriptionRouter } from './modules/subscription/subscription.routes.js';
import mediaRoutes, { UPLOAD_ROOT } from './modules/media/media.routes.js';
import userRoutes from './modules/users/user.routes.js';

const INLINE_MEDIA = /\.(jpe?g|png|gif|webp|heic|mp4|webm|mov|m4a|aac|mp3|ogg|oga|opus|wav)$/i;

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind nginx / cloud load balancer

  // Media is loaded cross-origin by the web app (Flutter web / PWA).
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.corsOrigins, credentials: env.corsOrigins !== '*' }));
  app.use(compression());
  app.use(express.json({ limit: '100kb' }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url.startsWith('/health') || req.url.startsWith('/uploads') },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
  app.get('/ready', async (_req, res) => {
    const mongo = mongoose.connection.readyState === 1;
    const timeout = new Promise((resolve) => setTimeout(resolve, 3_000, null));
    const redisOk = (await Promise.race([redis.ping().catch(() => null), timeout])) === 'PONG';
    res.status(mongo && redisOk ? 200 : 503).json({ ok: mongo && redisOk, mongo, redis: redisOk });
  });

  // In production serve uploads from S3/CDN; locally express.static is enough.
  app.use(
    '/uploads',
    express.static(UPLOAD_ROOT, {
      maxAge: '30d',
      immutable: true,
      index: false,
      dotfiles: 'deny',
      setHeaders(res, filePath) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (!INLINE_MEDIA.test(filePath)) res.setHeader('Content-Disposition', 'attachment');
      },
    }),
  );

  const api = express.Router();
  api.use(rateLimit(limiters.api, (req) => req.ip));
  api.use('/auth', authRoutes);
  // Public: invite preview (join page before login) and token-authenticated secure file stream.
  api.use('/invites', inviteRouter);
  api.get('/files/stream', streamSecureFile);
  // Admin panel (staff login / x-admin-key), separate from user auth.
  api.use('/admin', adminRouter);
  // App config for clients: maintenance banner, minimum app version, direct chat on/off.
  api.get('/config', async (_req, res) => {
    const sys = await getSetting('system');
    res.json({
      ok: true,
      data: {
        maintenance: sys.maintenance,
        maintenanceMessage: sys.maintenanceMessage,
        minAppVersion: sys.minAppVersion,
        directChat: sys.directChat,
        openRegistration: sys.openRegistration,
        maxFileMb: sys.maxFileMb,
      },
    });
  });
  // Maintenance mode (admin System Settings): the app API answers 503 until it is turned off.
  api.use(async (_req, _res, next) => {
    const sys = await getSetting('system');
    if (sys.maintenance) throw new ApiError(503, 'MAINTENANCE', sys.maintenanceMessage);
    next();
  });
  api.use(requireAuth);
  // Admin Blocked Keywords for the composer (send button disabled while typing).
  api.get('/blocked-terms', async (_req, res) => res.json({ ok: true, data: await activeTerms() }));
  api.use('/users', userRoutes);
  api.use('/conversations', conversationRouter);
  api.use('/messages', messageRouter);
  api.use('/media', mediaRoutes);
  api.use('/groups', groupRouter);
  api.use('/group-messages', groupMessageRouter);
  api.use('/files', fileRouter);
  api.use('/location', locationRouter);
  api.use('/reports', reportRouter);
  api.use('/subscription', subscriptionRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
