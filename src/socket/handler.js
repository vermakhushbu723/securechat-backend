import { logger } from '../config/logger.js';
import { toApiError } from '../middlewares/error.js';

/** Wraps a handler: validates payload, applies rate limit, answers the ack. */
export function handler(socket, { schema, limiter, fn }) {
  return async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      if (limiter) {
        try {
          await limiter.consume(socket.data.userId);
        } catch (rej) {
          if (rej instanceof Error) throw rej;
          return reply({ ok: false, error: { code: 'RATE_LIMITED', message: 'Slow down' } });
        }
      }
      const input = schema ? schema.parse(payload ?? {}) : payload;
      reply({ ok: true, data: (await fn(input)) ?? null });
    } catch (err) {
      const apiErr = toApiError(err);
      if (!apiErr) logger.error({ err }, 'Socket handler error');
      reply({
        ok: false,
        error: apiErr
          ? { code: apiErr.code, message: apiErr.message, details: apiErr.details }
          : { code: 'INTERNAL', message: 'Something went wrong' },
      });
    }
  };
}
