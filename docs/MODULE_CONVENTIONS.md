# Module conventions (read before writing a module)

Requirements: `TRACKER_DASHBOARD_BACK-END.md` (feature IDs, §B module specs, §E schema, §F endpoints).
Schema: `src/db/migrations/001_init.sql` (all tables already exist — read it, don't guess column names).

## Stack
Node 22 ESM JavaScript, Express 5 (async errors propagate automatically), Zod 4, PostgreSQL via `src/lib/db.js`
(tests and local dev run on embedded PGlite = real Postgres). No ORM.

## Layout
```
src/modules/<name>/routes.js      # default export: createRouter(...) api, or an array of them (auto-mounted)
src/modules/<name>/routes-*.js    # extra routers (also auto-mounted)
src/modules/<name>/service.js     # business logic reused by other modules
src/modules/<name>/jobs.js        # registerJob / registerCron (auto-imported at startup)
tests/<name>.test.js
```
Modules are auto-discovered by `src/modules/index.js` — never edit `app.js` to mount a router.

## Writing routes
```js
import { z } from 'zod';
import { createRouter, zMoney } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, where, camel, camelAll } from '../../lib/http.js';
import { notFound, badRequest, conflict, forbidden, unprocessable } from '../../lib/errors.js';
import { scopeMembers, assertMemberAccess, accessibleProjectIds, assertProjectAccess } from '../../rbac/scope.js';

const r = createRouter('/projects', 'Projects');          // mounted at /api/v1/projects
r.get('/:id', {
  summary: 'Get project', ids: 'PROJ-01',                 // ids → shown in OpenAPI
  permission: 'projects.view',                            // string or array (any-of); scope enforced in handler
  params: z.object({ id: z.uuid() }),
  query: paginationQuery.extend({ status: z.string().optional() }),
  body: z.object({...}),                                  // for POST/PUT/PATCH
  // auth: 'org' (default) | 'user' | 'public' | 'optional' | 'agent' | 'super'
  // feature: 'invoices'  → plan gate (403 FEATURE_NOT_IN_PLAN)
  // roles: ['owner']     → base-role restriction
}, async (req, res) => {
  const { id } = req.v.params;   const q = req.v.query;   const b = req.body;   const ctx = req.ctx;
  ...
  ok(res, dto);                  // { data }      created(res, dto) → 201     noContent(res) → 204
  ok(res, rows, pageMeta(q, total));  // { data, meta: { page, limit, total } }
});
export default r;
```
- Validation errors → 400 `VALIDATION_ERROR` automatically. Throw `AppError`s from `lib/errors.js` for everything else.
  Postgres unique/exclusion/FK violations are mapped automatically (409 `CONFLICT`, 409 `ENTRY_OVERLAP`, 400 `INVALID_REFERENCE`).
- API JSON is camelCase; DB is snake_case. Write explicit DTO functions (preferred) or use `camel()`.
- Use `where()` from `lib/http.js` for dynamic filters (`w.add('m.status = ?', q.status)` skips undefined values).
- Every query on tenant tables MUST filter by `organization_id = ctx.orgId` (organization isolation, SEC-21).
- Soft-deleted rows (`deleted_at IS NOT NULL`) are invisible.
- Pagination: `paginationQuery` (page, limit≤100, sort, order, search). Whitelist sort columns.

## Request context `req.ctx`
`userId, user{…}, sessionId, orgId, memberId, role{id,slug,baseRole,level}, perms(Map key→scope), timezone (member→org),
authType ('user'|'api_key'|'agent'), deviceId (agent), ip, userAgent`.
Helpers: `ctx.can(perm)` → scope|null, `ctx.require(perm, minScope?)`, `ctx.isOwner()`, `ctx.isAdminLike()`, `ctx.isClient()`.

## Permissions & scopes (`src/rbac/scope.js`)
Scopes: `own` < `team`/`project` < `org`. The route `permission` option only checks the permission exists;
the handler MUST apply the scope:
- member data (time, screenshots, activity, attendance, timesheets…): `await scopeMembers(ctx, 'time.view', w, 'e.member_id')`
  or `assertMemberAccess(ctx, perm, memberId)`; `accessibleMemberIds(ctx, perm)` → `null` (all) or `string[]`.
- project data: `accessibleProjectIds(ctx, perm)` / `assertProjectAccess` / `scopeProjects(ctx, perm, w, 'p.id')`.
- `getOrgMember(orgId, memberId)` loads a member or 404.
Permission catalog: `src/rbac/catalog.js`.

## Shared services
- Notifications: `notify({ orgId, userIds?, memberIds?, type, title, body, link, data, email? })` from
  `modules/notifications/service.js`. Types listed in `NOTIFICATION_EVENTS` (catalog.js). `usersWithPermission(orgId, perm, { memberId })`
  returns approvers covering a member.
- Domain events: `publish(event, { orgId, ... })` / `subscribe(event, handler)` from `lib/events.js` (event names listed there).
  Publish after successful writes. Webhooks subscribe to these.
- Realtime: `emitToUser`, `emitToOrg`, `emitToLive`, `emitToProject` from `lib/realtime.js`.
- Jobs: `registerJob(name, fn)`, `enqueue(name, payload, { runAt, dedupeKey })`, `registerCron(name, intervalMs, fn)` from `lib/jobs.js`.
  Tests: `drainJobs()`, `runCron(name)`, `runNow(name, payload)`.
- Audit (security-relevant changes): `audit(ctx, 'entity.action', { entityType, entityId, before, after })`.
  Activity feed (projects/tasks): `logActivity(ctx, entityType, entityId, action, changes)` — `lib/audit.js`.
- Storage: `createUpload({ orgId, purpose, contentType, size, userId, allowedTypes })` → signed PUT URL;
  `assertUploaded(key, { orgId, purpose })`; `signedGetUrl(key, { download, filename, ttl })`; `putObject`, `getObject`, `deleteObject` — `lib/storage.js`.
  Purposes: avatar, logo, attachment, screenshot, import, export.
- Plan gates: `hasFeature(ctx, feature)`, route option `feature`, `assertSeatsAvailable(orgId, n)`, `assertStorageAvailable(orgId, bytes)` — `modules/subscription/features.js`.
- Tracking settings: `getEffectiveSettings(orgId, { memberId, projectId })`, `consentStatus`, `assertConsent` — `modules/settings/effective.js`.
- Timer: `startTimer / pauseTimer / resumeTimer / stopTimer / switchTimer / currentTimer / entryDto / getEntry / ENTRY_SELECT /
  resolveProjectTask / checkWeeklyLimit / finalizeEntry / writeHistory` — `modules/time/timer-service.js`.
- Summaries: `recomputeDailySummary(memberId, date)`, `recomputeRange(memberId, start, end)`, `recomputeForEntry(entry)`,
  `expectedSecondsForDate(memberId, date)`, `memberTimezone(memberId)` — `modules/time/summary-service.js`.
  Call `recomputeRange` after writing time entries, breaks, idle periods, activity, app/web usage, screenshots.
- Categorization: `buildCategorizer(orgId, memberId)` — `modules/apps/categorize.js`.
- Org provisioning / next employee code: `modules/organizations/provision.js`. Invitations: `createInvitation(ctx, {...})`,
  `assertAssignableRole(ctx, roleId)` — `modules/invitations/routes.js`.

## Time zones
Store `timestamptz` (UTC). "Dates" in APIs are member-local (or org-local for org reports). Do day math in SQL:
`($date::date::timestamp AT TIME ZONE $tz)` = local midnight; `(ts AT TIME ZONE $tz)::date` = local date.

## Money
`numeric` columns arrive as strings — convert with `Number()` for math, round to 2 decimals, return numbers.

## Tests (Vitest + supertest, in-memory PGlite per file)
```js
import { setupApp, registerOrg, addMember, request, client, db } from './helpers.js';
let t; beforeAll(async () => { t = await setupApp(); });
const owner = await registerOrg(t);                       // owner client: owner.api.get(...), owner.orgId, owner.memberId, owner.roles
const emp = await addMember(t, owner, { role: 'employee' });   // roles: admin, manager, team_leader, employee, client
await owner.api.post('/api/v1/...').send({...}).expect(201);
```
`t.outbox` = sent emails, `t.emitted` = realtime emits. Run: `npx vitest run tests/<file>.test.js`.
Test: happy paths, validation, permission/scope denials (employee vs manager vs admin), org isolation, key business rules.

## Rules
- Only create/modify files inside the modules and test files you own. Do NOT edit shared files
  (`src/lib/*`, `src/rbac/*`, `src/middleware/*`, `src/app.js`, `src/db/migrations/001_init.sql`, `tests/helpers.js`,
  other modules). If you truly need a schema change, add a new migration `src/db/migrations/0NN_<module>.sql` using your
  assigned number. If a shared file has a bug, report it instead of editing it.
- No new npm dependencies unless unavoidable (installed: express, zod, pg, pglite, argon2, jose, otplib, simplewebauthn,
  google-auth-library, socket.io, nodemailer, pdfkit, exceljs, csv-stringify, csv-parse, multer, archiver, qrcode, sharp).
- Never record keystroke content (privacy rule PDF §7). Never offer stealth monitoring (PDF §6).
