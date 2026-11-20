# Tracker API

REST + WebSocket back end for the Tracker web dashboard (time tracking & productivity management).
Requirements and roadmap: [TRACKER_DASHBOARD_BACK-END.md](TRACKER_DASHBOARD_BACK-END.md) · Module conventions: [docs/MODULE_CONVENTIONS.md](docs/MODULE_CONVENTIONS.md)

## Stack
Node.js 22 (ESM) · Express 5 · PostgreSQL (SQL migrations, `pg`) · Zod · Socket.IO · Vitest.
Without `DATABASE_URL` the API uses **embedded PGlite** (real Postgres in WASM) — nothing else to install.

## Quick start
```bash
npm install
cp .env.example .env        # optional; defaults work for local development
npm run dev                 # http://localhost:4000  ·  docs: http://localhost:4000/api/docs
```
Migrations and seed data run automatically on start (or `npm run migrate`).

## Production
- Set `DATABASE_URL` (PostgreSQL 14+ with `citext`, `pg_trgm`, `btree_gist` available), `JWT_SECRET`, `ENCRYPTION_KEY`, `APP_URL`, `FRONTEND_URL`, `CORS_ORIGINS`, `COOKIE_SECURE=true`, SMTP, and optionally Stripe/Google.
- Run the API with `WORKER_INLINE=false` and a separate `npm run worker` process for background jobs.

## Scripts
| Command | Purpose |
|---|---|
| `npm run dev` | API with auto-reload (+ inline job worker) |
| `npm start` | API |
| `npm run worker` | Standalone background job worker |
| `npm run migrate` | Apply migrations + seed |
| `npm test` | Full integration test suite (in-memory database) |

## API conventions
- Base path `/api/v1`; success `{ data, meta? }`, errors `{ error: { code, message, details, requestId } }`.
- Auth: httpOnly cookies (`tr_at` access, `tr_rt` refresh) or `Authorization: Bearer <jwt>`; integrations use `X-API-Key`; the desktop agent uses device tokens (`Bearer dt_…`).
- The front end should proxy `/api/v1/*` and `/socket.io/*` to this server (same-origin cookies).
- Full, generated documentation: `/api/docs` (Swagger UI) and `/api/openapi.json`.

## Layout
```
src/
  app.js, server.js, worker.js
  config/      env validation
  db/          migrations/*.sql, migrate.js, seed.js
  lib/         db, jobs, storage, mailer, jwt, crypto, events, realtime, router, audit, errors, http
  middleware/  authenticate, rate limit, errors
  rbac/        permission catalog, context, data scoping
  realtime/    Socket.IO server
  modules/     one folder per feature module (routes*.js auto-mounted, jobs.js auto-loaded)
tests/         one integration test file per module
```
