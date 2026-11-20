import { AppError, fromPgError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isProd } from '../config/env.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let e = err instanceof AppError ? err : fromPgError(err);
  if (!e && err?.type === 'entity.parse.failed') e = new AppError(400, 'INVALID_JSON', 'Malformed JSON body');
  if (!e && err?.type === 'entity.too.large') e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  if (!e && err?.name === 'MulterError') e = new AppError(400, 'UPLOAD_ERROR', err.message);
  if (!e) {
    logger.error({ err, reqId: req.id, path: req.path }, 'unhandled error');
    e = new AppError(500, 'INTERNAL_ERROR', isProd ? 'Something went wrong' : String(err?.message ?? err));
  } else if (e.status >= 500) {
    logger.error({ err, reqId: req.id }, 'server error');
  }
  res.status(e.status).json({
    error: { code: e.code, message: e.message, details: e.details, requestId: req.id },
  });
}
