import multer from 'multer';
import { ZodError } from 'zod';

import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';

/** Maps any thrown error to `{ ok:false, error:{ code, message, details } }`. */
export function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) {
    return ApiError.badRequest(
      'Validation failed',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  if (err instanceof multer.MulterError) {
    return err.code === 'LIMIT_FILE_SIZE'
      ? new ApiError(413, 'FILE_TOO_LARGE', 'File is too large')
      : ApiError.badRequest(err.message);
  }
  if (err?.name === 'CastError') return ApiError.badRequest('Invalid id');
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'field';
    return ApiError.conflict(`${field} already in use`, 'DUPLICATE');
  }
  if (err?.type === 'entity.parse.failed') return ApiError.badRequest('Malformed JSON');
  if (err?.type === 'entity.too.large') return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Payload too large');
  return null;
}

export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.path} not found`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const apiErr = toApiError(err);
  if (!apiErr) {
    logger.error({ err, path: req.path }, 'Unhandled error');
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } });
  }
  res.status(apiErr.status).json({
    ok: false,
    error: { code: apiErr.code, message: apiErr.message, details: apiErr.details },
  });
}
