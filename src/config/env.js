import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const bool = (def) =>
  z
    .string()
    .default(def)
    .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_URL: z.string().url().default('http://localhost:4000'),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  MONGO_POOL_SIZE: z.coerce.number().int().positive().default(50),
  // Optional resolvers for mongodb+srv lookups when the local DNS cannot answer SRV queries.
  DNS_SERVERS: z.string().default(''),

  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  CORS_ORIGINS: z.string().default('*'),
  UPLOAD_DIR: z.string().default('uploads'),
  SECURE_UPLOAD_DIR: z.string().default('secure_uploads'),
  FILE_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'FILE_ENCRYPTION_KEY must be 64 hex chars'),
  FILE_TOKEN_SECRET: z.string().min(32),
  APP_URL: z.string().url().default('http://localhost:8080'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(50),

  MESSAGE_EDIT_WINDOW_MIN: z.coerce.number().positive().default(15),
  DELETE_FOR_EVERYONE_WINDOW_MIN: z.coerce.number().positive().default(60),

  OTP_DEV_MODE: bool('false'),
  RUN_WORKERS: bool('true'),
  CLUSTER_WORKERS: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n', z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS === '*' ? '*' : parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()),
});
