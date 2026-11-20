/** Application error carrying an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = 'Bad request', details, code = 'BAD_REQUEST') =>
  new AppError(400, code, message, details);
export const validationError = (details, message = 'Validation failed') =>
  new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthenticated = (message = 'Authentication required', code = 'UNAUTHENTICATED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to perform this action', code = 'FORBIDDEN') =>
  new AppError(403, code, message);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code, message, details) => new AppError(409, code, message, details);
export const unprocessable = (code, message, details) => new AppError(422, code, message, details);
export const tooManyRequests = (message = 'Too many requests') => new AppError(429, 'RATE_LIMITED', message);

/** Map Postgres errors to AppErrors where meaningful. */
export function fromPgError(err) {
  switch (err?.code) {
    case '23505':
      return conflict('CONFLICT', 'A record with the same unique value already exists', {
        constraint: err.constraint,
      });
    case '23P01':
      return conflict('ENTRY_OVERLAP', 'This time range overlaps an existing entry');
    case '23503':
      return badRequest('Referenced record does not exist', { constraint: err.constraint }, 'INVALID_REFERENCE');
    case '23514':
      return badRequest('Value violates a constraint', { constraint: err.constraint }, 'CONSTRAINT_VIOLATION');
    case '22008': // datetime field overflow
    case '22007': // invalid datetime format
      return badRequest('Invalid date or time value', undefined, 'INVALID_DATE');
    case '22P02':
      return badRequest('Invalid identifier or value format', undefined, 'INVALID_FORMAT');
    default:
      return null;
  }
}
