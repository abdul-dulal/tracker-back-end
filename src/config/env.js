import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().default('http://localhost:4000'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  // Database: DATABASE_URL → PostgreSQL. Empty → embedded PGlite (dev/test only).
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('./.pglite'),

  JWT_SECRET: z.string().min(32).default('dev-only-insecure-jwt-secret-change-me-please-0123456789'),
  ENCRYPTION_KEY: z.string().min(32).default('dev-only-insecure-encryption-key-change-me-0123456789'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(15 * 60),
  REFRESH_TTL_REMEMBER_SECONDS: z.coerce.number().default(30 * 24 * 3600),
  REFRESH_TTL_DEFAULT_SECONDS: z.coerce.number().default(12 * 3600),
  COOKIE_SECURE: bool.default(false),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  WEBAUTHN_RP_ID: z.string().default('localhost'),
  WEBAUTHN_RP_NAME: z.string().default('Tracker'),
  WEBAUTHN_ORIGIN: z.string().default('http://localhost:3000'),

  STORAGE_DIR: z.string().default('./storage'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Tracker <no-reply@tracker.local>'),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  WORKER_INLINE: bool.default(true),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

if (isProd && (env.JWT_SECRET.startsWith('dev-only') || env.ENCRYPTION_KEY.startsWith('dev-only'))) {
  console.error('JWT_SECRET and ENCRYPTION_KEY must be set in production');
  process.exit(1);
}
if (isProd && !env.DATABASE_URL) {
  console.error('DATABASE_URL is required in production');
  process.exit(1);
}
