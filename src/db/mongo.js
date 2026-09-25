import dns from 'node:dns';

import mongoose from 'mongoose';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

mongoose.set('strictQuery', true);

export async function connectMongo() {
  if (env.DNS_SERVERS) dns.setServers(env.DNS_SERVERS.split(',').map((s) => s.trim()));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));

  await mongoose.connect(env.MONGO_URI, {
    maxPoolSize: env.MONGO_POOL_SIZE,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 15_000,
    socketTimeoutMS: 45_000,
    // Indexes are built by `npm run db:indexes` in production, never on boot.
    autoIndex: !env.isProd,
  });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectMongo() {
  await mongoose.disconnect();
}
