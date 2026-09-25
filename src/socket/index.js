import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createRedis } from '../db/redis.js';
import { markAllDelivered } from '../modules/chat/chat.service.js';
import { markAllGroupsDelivered } from '../modules/groups/groupMessage.service.js';
import { markOffline, markOnline, refreshTTL } from '../services/presence.service.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { registerChatHandlers } from './chat.handlers.js';
import { setIO, userRoom } from './emitter.js';
import { joinUserGroupRooms, registerGroupHandlers } from './group.handlers.js';

const PRESENCE_REFRESH_MS = 60_000;

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    // WebSocket only: no long-polling -> no sticky sessions needed behind a load balancer.
    transports: ['websocket'],
    cors: { origin: env.corsOrigins, credentials: env.corsOrigins !== '*' },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e6, // files go through /media/upload, not the socket
    serveClient: false,
  });

  // Redis adapter: rooms / broadcasts work across every node and CPU worker.
  io.adapter(createAdapter(createRedis('io:pub'), createRedis('io:sub')));
  setIO(io);

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token ?? socket.handshake.headers.authorization?.replace(/^Bearer /, '');
      if (!token) throw new Error('missing token');
      socket.data.userId = verifyAccessToken(token).sub;
      next();
    } catch {
      const err = new Error('UNAUTHORIZED');
      err.data = { code: 'UNAUTHORIZED' };
      next(err);
    }
  });

  io.on('connection', async (socket) => {
    const { userId } = socket.data;
    socket.join(userRoom(userId));
    registerChatHandlers(io, socket);
    registerGroupHandlers(io, socket);

    socket.on('disconnect', () => {
      markOffline(userId, socket.id).catch((err) => logger.warn({ err: err.message }, 'markOffline failed'));
    });

    try {
      await joinUserGroupRooms(socket);
      await markOnline(userId, socket.id);
      await markAllDelivered(userId);
      await markAllGroupsDelivered(userId);
    } catch (err) {
      logger.warn({ err: err.message, userId }, 'Connection bootstrap failed');
    }
    socket.emit('ready', { userId, serverTime: new Date().toISOString() });
  });

  // Keep presence keys alive for sockets held by this node.
  const timer = setInterval(() => {
    const ids = new Set();
    for (const s of io.of('/').sockets.values()) ids.add(s.data.userId);
    refreshTTL([...ids]).catch(() => {});
  }, PRESENCE_REFRESH_MS);
  timer.unref();

  return io;
}
