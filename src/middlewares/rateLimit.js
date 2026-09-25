import { RateLimiterRedis } from 'rate-limiter-flexible';

import { redis } from '../db/redis.js';
import { ApiError } from '../utils/ApiError.js';

/** Redis backed limiter: counters are shared by every API instance. */
export function createLimiter(keyPrefix, points, durationSec, blockDurationSec = 0) {
  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `rl:${keyPrefix}`,
    points,
    duration: durationSec,
    blockDuration: blockDurationSec,
    inMemoryBlockOnConsumed: points * 2,
  });
}

export const limiters = {
  api: createLimiter('api', 600, 60),
  auth: createLimiter('auth', 20, 60, 60),
  otp: createLimiter('otp', 5, 600, 600),
  upload: createLimiter('upload', 60, 60),
  // Socket events (keyed by user id)
  message: createLimiter('ws:msg', 40, 10),
  typing: createLimiter('ws:typing', 40, 10),
  action: createLimiter('ws:action', 60, 10),
};

export const rateLimit =
  (limiter, keyFn = (req) => req.user?.id ?? req.ip) =>
  async (req, res, next) => {
    try {
      const r = await limiter.consume(keyFn(req));
      res.setHeader('X-RateLimit-Remaining', r.remainingPoints);
      next();
    } catch (err) {
      if (err instanceof Error) return next(err); // Redis down etc.
      res.setHeader('Retry-After', Math.ceil(err.msBeforeNext / 1000));
      next(ApiError.tooMany());
    }
  };
