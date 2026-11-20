import pino from 'pino';

const level = process.env.NODE_ENV === 'test' ? 'silent' : process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', '*.password', '*.token'],
    remove: true,
  },
});
