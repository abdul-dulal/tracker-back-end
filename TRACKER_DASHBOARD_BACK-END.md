# TRACKER — Web Dashboard Back-End Implementation Guide

> **Stack:** Node.js (LTS) · Express · PostgreSQL
> **Source of truth:** `Tracker Features List.pdf` (21 pages, sections 1–26)
> **Companion doc:** `tracker-front-end/TRACKER_DASHBOARD_FRONT-END.md` (same feature IDs, same phases)
> **Last updated:** 2026-11-19

Every feature in this document has an ID (e.g. `AUTH-01`). The front-end guide uses the same IDs, so one feature can be tracked across both repos. A feature is only **Completed** when the front end, back end, database, permissions and tests are all done (see [§I Definition of Done](#i-development-checklist)).

---

## Table of Contents

- [A. Project Overview](#a-project-overview)
- [Existing Codebase & Gap Analysis](#existing-codebase--gap-analysis)
- [B. Feature Breakdown by Module (Back-End)](#b-feature-breakdown-by-module-back-end)
- [C. Back-End Development Roadmap](#c-back-end-development-roadmap)
- [D. Architecture, Conventions & Cross-Cutting Concerns](#d-architecture-conventions--cross-cutting-concerns)
- [E. Database Design](#e-database-design)
- [F. API Documentation Plan](#f-api-documentation-plan)
- [G. Module Dependencies](#g-module-dependencies)
- [H. Development Phases](#h-development-phases)
- [I. Development Checklist](#i-development-checklist)
- [J. Progress Tracking](#j-progress-tracking)
- [Appendix: PDF Coverage Cross-Check](#appendix-pdf-coverage-cross-check)

---

## A. Project Overview

### A.1 Introduction
Tracker is a multi-tenant SaaS **Time Tracking & Productivity Management Platform** (inspired by Scrin.io, TimoDesk, DeskTime, TimeDoctor). Organizations register, invite employees, organize them into departments/teams, track time against projects/tasks/clients, monitor activity (screenshots, input activity, app/website usage) transparently, manage attendance, breaks and timesheets, report on performance, bill clients, run payroll, and pay for a SaaS subscription.

### A.2 Development Objectives
1. Deliver a **complete, production-grade REST API + real-time layer** that powers 100% of the web dashboard.
2. Provide **ingestion/sync APIs** for the future desktop tracker app (desktop UI itself is out of scope).
3. Enforce **organization data isolation**, **RBAC with scoped permissions**, and the **privacy rules** in the PDF.
4. Produce **OpenAPI/Swagger docs** for every endpoint.

### A.3 Back-End Responsibilities
- Architecture, database schema, migrations, seeds.
- Authentication (password, Google OAuth, 2FA, passkeys, sessions) and authorization (RBAC + scopes).
- REST API, validation, error handling, business logic and calculations.
- File/screenshot storage with signed URLs, blur, retention.
- Background jobs (alerts, scheduled reports, retention, attendance detection, timesheet generation).
- Real-time (live monitoring, timers, notifications) via WebSockets.
- Notifications (in-app, email, desktop push payloads).
- Reports, analytics, exports (PDF / CSV / Excel).
- Billing/payroll, SaaS subscriptions & payment gateway.
- Third-party integrations, API keys, webhooks.
- Security & data protection (GDPR-compatible controls, audit logs).

### A.4 Scope Boundaries
| In scope | Out of scope |
|---|---|
| All web-dashboard APIs (sections 1–19, 21–26) | Native desktop app UI (Windows/macOS/Linux) |
| Back-end support for desktop app features: login, org/project/task selection, timer, screenshot upload, activity/app/website ingestion, offline sync, device info, version info, notifications | Desktop OS-level capture (keyboard/mouse hooks, screen capture, tray, auto-start, auto-update binaries) |
| Settings the desktop app consumes (tracking config, idle thresholds, screenshot frequency) | Browser extensions for Chrome/Firefox/Edge (we only accept their data via API) |
| Super Admin platform management | — |

> PDF note: the "Desktop App Features" block between sections 19 and 21 is unnumbered (section 20 does not exist in the PDF). We treat it as **DESK-xx** features: back-end support only.

### A.5 Technical Requirements & Chosen Stack
| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node.js 22 LTS, **ES Modules**, JavaScript (JSDoc types) | Matches front-end (JS). TypeScript may be adopted later without changing the design. |
| HTTP | Express 5 | Requested; native async error propagation. |
| Database | PostgreSQL 16 | Requested; JSONB, partial indexes, range types, partitioning. |
| Data access / migrations | **`pg` driver + plain SQL migrations** (`src/db/migrations/*.sql`, runner `src/db/migrate.js`); thin helper `src/lib/db.js` with AsyncLocalStorage transactions. **Embedded PGlite** (real Postgres in WASM) is used automatically when `DATABASE_URL` is empty — for local dev and the test suite. | *Changed from Prisma (2026-11-19):* full control of Postgres-only features (exclusion constraints, partial indexes, generated columns) and no TS build step. |
| Validation | **Zod** (+ `@asteasolutions/zod-to-openapi`) | One schema → validation + OpenAPI. |
| Auth | JWT access token (15 min) + rotating refresh token (httpOnly cookie, DB-backed); `argon2` hashing | Session list/revocation required by AUTH features. |
| 2FA | `otplib` (TOTP) + hashed recovery codes | AUTH-06 |
| Passkeys | `@simplewebauthn/server` | AUTH-07 |
| Google OAuth | `google-auth-library` (OIDC ID-token / code flow) | AUTH-02, INT-08 |
| Real-time | **Socket.IO** (single instance; add the Redis adapter when scaling horizontally) | Live monitoring, timers, notifications. |
| Jobs / scheduling | **Postgres-backed queue** (`jobs` + `cron_runs` tables, `src/lib/jobs.js`, `FOR UPDATE SKIP LOCKED`); runs inline (`WORKER_INLINE=true`) or as `npm run worker` | *Changed from BullMQ (2026-11-19):* the available Redis (3.0) is too old for BullMQ; a DB queue removes the Redis dependency. |
| Rate limiting | In-memory fixed window (`src/middleware/rateLimit.js`) | Swap store for Postgres/Redis when running multiple instances. |
| File storage | Storage interface in `src/lib/storage.js`; **local driver** (disk + HMAC-signed, expiring URLs served by `/api/v1/files`). An S3 driver can implement the same interface. | Signed URLs (SEC-09), per-org keys, storage accounting. |
| Images | `sharp` | Thumbnails, blur variants. |
| Email | `nodemailer` (SMTP / provider) + MJML/Handlebars templates | Invitations, reports, alerts. |
| Exports | `pdfkit` (PDF), `exceljs` (XLSX), `csv-stringify` (CSV) | Timesheets, reports, invoices. |
| Import | `exceljs` + `csv-parse` | Bulk employee import. |
| Payments | **Stripe** (Billing + Checkout + webhooks) | Section 26. Gateway behind an adapter interface. |
| Logging | `pino` + `pino-http` | Structured logs, request IDs. |
| Security middleware | `helmet`, `cors`, `hpp`, `express-rate-limit`/`rate-limiter-flexible` | Section 25. |
| Testing | `vitest` + `supertest`; every test file gets a fresh in-memory PGlite database | No Docker needed. |
| API docs | Swagger UI at `/api/docs`, JSON at `/api/openapi.json`, generated from the Zod schemas declared on each route (`src/lib/router.js` → `src/docs/registry.js`) | INT-06/07. |
| Dev infra | Nothing required beyond Node 22 (PGlite + local storage + logged emails). Production: PostgreSQL 16, SMTP, optional Stripe/Google. | Local parity without Docker. |
| Payments | Stripe REST API via `fetch` (no SDK) | Section 26. |

---

## Existing Codebase & Gap Analysis

**Analyzed on 2026-11-19.**

| Repo | Current state |
|---|---|
| `tracker-back-end` | Only a default `npm init` `package.json` (no dependencies, no scripts besides placeholder `test`) and an **empty `src/` folder**. No server, no DB, no APIs. |
| `tracker-front-end` | Fresh Create Next App (Next 16.4.6, React 19.3, Tailwind 4, React Compiler, `cacheComponents: true`). Only the default `page.js`/`layout.js`. No API integration. |

**Gap analysis result:**
- Already implemented features: **none**.
- Partially implemented: **none**.
- Missing back-end features / APIs / database structures: **all** (every item in §B, §E, §F).

Consequence: there is no existing architecture to preserve on the back end; the architecture in §D is the baseline. Phase 0 (§H) bootstraps it.

**Status update (2026-11-20):** the complete back end has been implemented (all modules M01–M25) and is covered by 238 integration tests. Known partial items:
- INT-09 Slack: incoming-webhook mode only (no OAuth app install / slash commands).
- INT-18 Accounting (QuickBooks/Xero) and INT-19 Calendar: CSV export and iCalendar feed only; OAuth push returns 501 until provider credentials are configured.
- SS-15 optional "also delete the time" on screenshot delete is not implemented.
- Member import (EMP-22) runs synchronously (≤1000 rows) instead of as a background job.
- Reports: activity/productivity figures cannot be filtered by project (daily_summaries is per member/day); week buckets in reports start on Monday.
- Leaderboard ranks all org members (or a team), not only the caller's scope, by design.

---

## B. Feature Breakdown by Module (Back-End)

Format for each module: **Purpose · Features (ID + PDF wording) · Back-end requirements · Endpoints (summary — full list in §F) · Entities · Permissions · Dependencies · Business logic.**

Role abbreviations: **SA** Super Admin · **OW** Organization Owner · **AD** Admin · **MG** Manager · **TL** Team Leader · **EM** Employee · **CL** Client.
Scope words: **own** (self), **team** (members of teams the user manages/leads), **project** (projects the user manages/is assigned), **org** (whole organization).

---

### M01 — Authentication & User Management (PDF §1)
**Purpose:** Identity, sessions, organizations (tenants), membership & invitations.

| ID | Feature | Back-end requirement |
|---|---|---|
| AUTH-01 | Email and Password Login | `POST /auth/login`; argon2 verify; brute-force lockout; issue access + refresh; record login history. |
| AUTH-02 | Google Login / OAuth | `GET /auth/google` → callback; link by verified email or create user; `oauth_accounts`. |
| AUTH-03 | Forgot Password | `POST /auth/forgot-password`; always 200 (no user enumeration); token (hashed) 30 min; email. |
| AUTH-04 | Reset Password | `POST /auth/reset-password`; single-use token; revoke all sessions. |
| AUTH-05 | Email Verification | Token on signup; `POST /auth/verify-email`, `POST /auth/resend-verification`; unverified users limited. |
| AUTH-06 | Two-Factor Authentication (2FA) | TOTP setup/enable/disable, recovery codes, login step `POST /auth/2fa/verify` using short-lived `mfa_token`. Org may enforce 2FA. |
| AUTH-07 | Passkeys / Biometric Authentication | WebAuthn registration & authentication options/verify; `webauthn_credentials`. |
| AUTH-08 | Session Management | `sessions` table (refresh token hash, device, IP, UA, expiry); list/revoke one/revoke all others. |
| AUTH-09 | Remember Me | Refresh token lifetime 30 days if `rememberMe`, else session-length (12 h). |
| AUTH-10 | Multi-Organization Support | User ↔ many orgs via `organization_members`; `POST /auth/switch-organization` issues token with `orgId`. |
| AUTH-11 | Organization Registration | `POST /auth/register` creates user + org + owner membership + default roles + default settings + free/trial subscription (transaction). |
| AUTH-12 | Organization Profile Setup | `GET/PATCH /organization` (name, industry, size, timezone, currency, address). |
| AUTH-13 | Company Logo and Branding | Logo upload (presigned) + brand color; served via signed/public CDN URL. |
| AUTH-14 | Invite Members via Email | `POST /invitations` (email, role, team, project); token; email sent; seat-limit check. |
| AUTH-15 | Invite Link Generation | `POST /invitations/links` → reusable link with role, max uses, expiry; revocable. |
| AUTH-16 | Accept / Reject Invitations | `GET /invitations/:token` (public preview), `POST .../accept` (existing or new user), `POST .../reject`. |
| AUTH-17 | Account Activation / Deactivation | Member status `active/inactive/suspended`; deactivation revokes sessions & blocks tracking; user-level deactivation by SA. |
| AUTH-18 | User Profile Management | `GET/PATCH /me` (name, avatar, phone, timezone, time format, locale). |
| AUTH-19 | Change Password | `POST /me/change-password` (current password required; revoke other sessions). |
| AUTH-20 | Login History | `login_history` (success/failure, IP, UA, geo, method); `GET /me/login-history`, admin view per member. |
| AUTH-21 | Device and Session History | `devices` (desktop agents + browsers) + `sessions`; `GET /me/devices`, `GET /me/sessions`. |

- **Entities:** users, oauth_accounts, webauthn_credentials, user_mfa, auth_tokens, sessions, login_history, devices, organizations, organization_members, invitations, invitation_links.
- **Permissions:** public (register/login/forgot/reset/verify/invite preview); authenticated (me, sessions); `members.invite` (OW/AD/MG*); `organization.update` (OW/AD).
- **Dependencies:** none (foundation). Subscription (M25) for seat limits.
- **Business logic:** login flow = password ✓ → if 2FA enabled return `{mfaRequired, mfaToken}` → verify → tokens. Refresh-token **rotation with reuse detection** (reused token ⇒ revoke whole family). Email unique case-insensitive (`citext`). Inactive/suspended member cannot obtain org token for that org.

---

### M02 — Role & Permission Management (PDF §2)
**Purpose:** RBAC with module-, team- and project-level scoping.

Built-in roles (seeded per org, non-deletable; Super Admin is a platform flag `users.is_super_admin`):

| Role | Responsibility (PDF) | Default data scope |
|---|---|---|
| Super Admin | Manage entire platform | All orgs (platform routes only) |
| Organization Owner | Manage company | org (all permissions, incl. billing & deletion) |
| Admin | Manage all company operations | org (all except ownership transfer/org deletion) |
| Manager | Manage assigned teams | team (managed teams) + project (managed projects) |
| Team Leader | Manage assigned members | team (led team members) |
| Employee | Track own working hours | own |
| Client | View assigned project reports | client-assigned projects, read-only |

| ID | Feature | Back-end requirement |
|---|---|---|
| RBAC-01 | Role-Based Access Control (RBAC) | `authorize(permission)` middleware + `scope` resolver used by every service query. |
| RBAC-02 | Custom Role Creation | `POST /roles` (clone from template), per-org. |
| RBAC-03 | Permission Management | Static permission catalog (`permissions` seed); `PUT /roles/:id/permissions`. |
| RBAC-04 | Module-Level Permissions | Permission keys `module.action` (e.g. `projects.create`). |
| RBAC-05 | Team-Level Permissions | Scope `team` on permission grants; `member_scopes` for explicit team assignment. |
| RBAC-06 | Project-Level Permissions | Scope `project`; project membership role (`manager`/`member`/`viewer`). |
| RBAC-07 | Screenshot Viewing Permissions | `screenshots.view` with scope own/team/project/org; `screenshots.delete`. |
| RBAC-08 | Report Access Permissions | `reports.view` scopes + per-report-type keys (`reports.billing.view`, etc.). |
| RBAC-09 | Role Assignment | `PATCH /members/:id/role`; cannot demote last owner; cannot grant above own level. |
| RBAC-10 | Multiple Managers | `member_managers` (many-to-many) + `team_managers`. |
| RBAC-11 | Access Restrictions | Per-member restrictions JSON (e.g. IP allowlist, disable manual time, hide rates) + plan feature gates. |

- **Entities:** roles, permissions, role_permissions, member_managers, team_managers, member_scopes.
- **Permission catalog (initial):** `organization.*`, `members.{view,create,update,deactivate,invite,import}`, `roles.manage`, `departments.manage`, `teams.{view,manage}`, `time.{view,create,update,delete,approve,manual}`, `timer.use`, `screenshots.{view,delete,download,export}`, `activity.view`, `apps.{view,categorize}`, `projects.{view,create,update,delete,archive}`, `tasks.{view,create,update,delete,assign,approve}`, `board.manage_columns`, `attendance.{view,manage,approve}`, `schedules.manage`, `holidays.manage`, `breaks.{use,manage}`, `idle.approve`, `timesheets.{view,submit,approve,lock,export}`, `reports.{view,export,schedule,share,custom}`, `performance.view`, `clients.{view,manage}`, `billing.{view,manage}`, `payroll.{view,manage}`, `invoices.{view,manage}`, `notifications.manage`, `settings.{tracking,privacy}`, `integrations.manage`, `api_keys.manage`, `webhooks.manage`, `audit.view`, `subscription.manage`, `privacy.requests.manage`.
- **Business logic:** effective permission = union of role grants; data scope = widest scope among grants for that permission. Scope resolver returns a SQL filter `member_id IN (...)` / `project_id IN (...)`. Cache resolved permissions per (member, role version) in Redis, invalidate on role change.

---

### M03 — Employee Management (PDF §3)
**Purpose:** Manage employees (organization members) and their HR/tracking profile.

| ID | Feature | Back-end requirement |
|---|---|---|
| EMP-01 | Add New Employee | `POST /members` (creates invitation or user directly with temp password if allowed). |
| EMP-02 | Edit Employee Information | `PATCH /members/:id`. |
| EMP-03 | Employee Invitation | Reuses AUTH-14; resend/cancel. |
| EMP-04 | Employee Profile | `GET /members/:id` (profile + assignments + summary stats). |
| EMP-05 | Employee ID | `employee_code` unique per org (auto-generate `EMP-0001` or manual). |
| EMP-06 | Employee Email | From `users.email`; work email optional field. |
| EMP-07 | Employee Designation | `designation` field. |
| EMP-08 | Department Assignment | `department_id` FK. |
| EMP-09 | Team Assignment | `team_members` (multi-team). |
| EMP-10 | Manager Assignment | `member_managers` (multiple). |
| EMP-11 | Employment Type (Full-time, Part-time, Contract) | enum `employment_type`. |
| EMP-12 | Joining Date | `joined_on` date. |
| EMP-13 | Employee Status (Active, Inactive, Suspended) | enum `member_status`; transitions audited. |
| EMP-14 | Working Schedule | `work_schedule_id` / shift assignment (M12). |
| EMP-15 | Weekly Working Hours | `weekly_hours` expected (decimal) + weekly limit (M05). |
| EMP-16 | Hourly Pay Rate | `member_rates` (effective-dated, currency) — history preserved for payroll. |
| EMP-17 | Employee Activity History | `GET /members/:id/activity` (activity samples summary). |
| EMP-18 | Employee Working History | `GET /members/:id/work-history` (time entries/attendance by day). |
| EMP-19 | Employee Device Information | `GET /members/:id/devices` (OS, app version, last seen, sync status). |
| EMP-20 | Employee Performance Overview | `GET /members/:id/performance` (M16 service). |
| EMP-21 | Employee Search and Filters | `GET /members?search&status&department&team&manager&employmentType&role`. |
| EMP-22 | Bulk Import Employees (CSV / Excel) | `POST /members/import` (multipart) → validate rows → preview → `POST /members/import/:jobId/commit`; job via BullMQ; error report. |
| EMP-23 | Bulk Employee Invitation | `POST /invitations/bulk` (array of emails + role/team). |
| EMP-24 | Employee Deactivation | `POST /members/:id/deactivate` (stops timer, revokes sessions, frees seat); `.../reactivate`. |

- **Entities:** organization_members (employee profile lives here), member_rates, team_members, member_managers, devices, import_jobs.
- **Permissions:** `members.view` (scoped), `members.create/update/deactivate/import` (OW/AD; MG for own teams if granted). Hourly rate visible only with `payroll.view` or `billing.view`.
- **Dependencies:** M01, M02, M04, M12 (schedule), M25 (seat limits).
- **Business logic:** seat limit enforced on create/invite/reactivate. Deactivated members keep historical data. Employee code unique per org (`UNIQUE(organization_id, employee_code)`).

---

### M04 — Team & Department Management (PDF §4)
| ID | Feature | Back-end requirement |
|---|---|---|
| TEAM-01 | Create Department | `POST /departments` (name, head, parent optional). |
| TEAM-02 | Create Team | `POST /teams` (name, department, description). |
| TEAM-03 | Edit Team Information | `PATCH /teams/:id`, `DELETE` (soft). |
| TEAM-04 | Assign Team Leader | `team_members.is_leader` (≥0 leaders); sets TL scope. |
| TEAM-05 | Assign Team Members | `POST /teams/:id/members` (bulk). |
| TEAM-06 | Remove Team Members | `DELETE /teams/:id/members/:memberId`. |
| TEAM-07 | Team Working Hours | `GET /teams/:id/stats/hours?from&to`. |
| TEAM-08 | Team Productivity Overview | `GET /teams/:id/stats/productivity`. |
| TEAM-09 | Team Activity Reports | `GET /reports/activity?teamId=`. |
| TEAM-10 | Team Performance Comparison | `GET /reports/teams/compare?teamIds=`. |
| TEAM-11 | Team Working Schedule | `teams.work_schedule_id` default for members. |
| TEAM-12 | Team-wise Employee Filtering | `teamId` filter on all member/report endpoints. |
| TEAM-13 | Team-wise Project Assignment | `project_teams` (assigning team grants members project access). |

- **Entities:** departments, teams, team_members, team_managers, project_teams.
- **Permissions:** `departments.manage`, `teams.manage` (OW/AD; MG for managed teams), `teams.view`.
- **Dependencies:** M01, M03. Stats depend on M05/M07/M08.

---

### M05 — Time Tracking System (PDF §5 — **Most important**)
**Purpose:** Capture all worked time (timer, desktop automatic, manual, offline) with pause/resume, idle, breaks, meetings, approval and overtime.

| ID | Feature | Back-end requirement |
|---|---|---|
| TIME-01 | Start Timer | `POST /timer/start` {projectId?, taskId?, note, type}; one running timer per member (partial unique index); emits `timer.started`. |
| TIME-02 | Stop Timer | `POST /timer/stop` → closes entry, computes durations. |
| TIME-03 | Pause Timer | `POST /timer/pause` → opens `time_entry_pauses` row. |
| TIME-04 | Resume Timer | `POST /timer/resume` → closes pause row. |
| TIME-05 | Automatic Time Tracking | Desktop agent posts entries/heartbeats via `/agent/*`; `source = 'desktop'`. |
| TIME-06 | Manual Time Entry | `POST /time-entries` with `source='manual'`; status `pending` if org requires approval for manual time. |
| TIME-07 | Task-Based Time Tracking | `task_id` FK; task actual hours aggregate. |
| TIME-08 | Project-Based Time Tracking | `project_id` FK; validation: member assigned to project. |
| TIME-09 | Client-Based Time Tracking | `client_id` derived from project (stored for fast reporting), or direct client entry. |
| TIME-10 | Real-Time Timer | `GET /timer/current`; socket events `timer.*` to user + managers. |
| TIME-11 | Daily Working Hours | `GET /time/summary?period=day`. |
| TIME-12 | Weekly Working Hours | `period=week` (org week start setting). |
| TIME-13 | Monthly Working Hours | `period=month`. |
| TIME-14 | Total Tracked Hours | `GET /time/summary?from&to` totals. |
| TIME-15 | Active Working Time | Σ activity samples `active_seconds` in entry. |
| TIME-16 | Idle Time Calculation | Σ `idle_periods` (kept/discarded) per entry. |
| TIME-17 | Break Time Tracking | Breaks (M13) excluded from worked time; reported separately. |
| TIME-18 | Meeting Time Tracking | `entry_type = 'meeting'` (+ optional calendar link). |
| TIME-19 | Offline Time Entry | Entries with `is_offline=true` synced later (M20) or manual offline entry. |
| TIME-20 | Automatic Idle Detection | Agent reports idle periods; server validates against `idle_threshold_minutes` setting. |
| TIME-21 | Auto Pause | After `auto_pause_minutes` of idle, server/agent pauses the timer; `pause_reason='idle'`. |
| TIME-22 | Auto Resume (with employee confirmation) | `POST /timer/idle/:idlePeriodId/resolve` {action: keep|discard|reassign}; never auto-resumes silently. |
| TIME-23 | Automatic Time Sync | `/agent/sync` batch + heartbeat; web timer and desktop timer share one server state. |
| TIME-24 | Multiple Time Entries | Many entries per day; overlap check per member. |
| TIME-25 | Timer History | `GET /time-entries?memberId&from&to` + `time_entry_history`. |
| TIME-26 | Time Entry Editing | `PATCH /time-entries/:id` (blocked if timesheet locked/approved; edit reason; history row). |
| TIME-27 | Time Entry Deletion | `DELETE /time-entries/:id` (soft delete + audit). |
| TIME-28 | Time Entry Approval | `POST /time-entries/:id/approve` (+ bulk). |
| TIME-29 | Time Entry Rejection | `POST /time-entries/:id/reject` {reason}. |
| TIME-30 | Time Entry Notes | `note` text field. |
| TIME-31 | Weekly Working Hour Limits | `weekly_limit_hours` (member > team > org); start/manual blocked or warned when exceeded (setting `limit_mode = block|warn`). |
| TIME-32 | Overtime Calculation | Daily/weekly overtime vs expected hours (schedule); stored on daily summaries. |
| TIME-33 | Time Zone Support | All timestamps `timestamptz` UTC; day boundaries computed in member timezone (fallback org timezone). |
| TIME-34 | 12-Hour / 24-Hour Format | Preference stored on user/org (`time_format`); API always returns ISO. |

- **Entities:** time_entries, time_entry_pauses, time_entry_history, idle_periods, daily_summaries (materialized per member/day).
- **Permissions:** `timer.use` (own); `time.view` (scoped); `time.create` own manual; `time.manual` for others; `time.update/delete` own (if setting allows) or scoped; `time.approve` (MG/TL/AD/OW scoped).
- **Dependencies:** M03, M09, M10, M22 (settings), M13 (breaks), M07 (activity).
- **Business logic:**
  - `duration_seconds = (ended_at - started_at) - Σ pauses`; `worked = duration - discarded idle`; breaks are separate entries/rows and not counted as work unless break type `is_paid` (paid breaks count for payroll, not for productivity).
  - No overlapping entries per member (exclusion constraint on `tstzrange` for non-deleted rows).
  - Entries crossing midnight are split at member-local midnight for daily summaries (stored once, split in aggregation).
  - Overtime: `daily_overtime = max(0, worked_day - expected_day)`; `weekly_overtime = max(0, worked_week - weekly_hours)`; org chooses daily, weekly or both (no double counting: weekly applied on remaining after daily).
  - Approval: entries `pending → approved|rejected`; approved entries locked; rejection notifies employee (M19).

---

### M06 — Screenshot Monitoring (PDF §6)
| ID | Feature | Back-end requirement |
|---|---|---|
| SS-01 | Automatic Screenshot Capture | Agent: `POST /agent/screenshots/upload-url` → PUT to S3 → `POST /agent/screenshots` (metadata). |
| SS-02 | Random Screenshot Intervals | Setting `screenshot_random=true`; agent receives config; server stores `capture_mode`. |
| SS-03 | Configurable Screenshot Frequency | `screenshot_interval_minutes`. |
| SS-04 | Screenshot Every 3 / 5 / 10 / 15 Minutes | Allowed values enum `[3,5,10,15]` (+ plan restriction). |
| SS-05 | Individual Employee Screenshot Settings | Settings at member scope. |
| SS-06 | Team-Wise Screenshot Settings | Settings at team scope. |
| SS-07 | Project-Wise Screenshot Settings | Settings at project scope. |
| SS-08 | Multiple Monitor Screenshot Capture | `screenshots.monitor_index`, `capture_group_id` grouping all monitors of one capture. |
| SS-09 | Screenshot Gallery | `GET /screenshots?memberId&date&projectId&taskId&page`. |
| SS-10 | Screenshot Timeline | `GET /screenshots/timeline?memberId&date` grouped by hour/10-min slot with activity %. |
| SS-11 | Full-Screen Screenshot | Signed URL for original. |
| SS-12 | Screenshot Preview | Thumbnail signed URL (`sharp` 400px). |
| SS-13 | Screenshot Zoom | Original resolution served (FE handles zoom). |
| SS-14 | Screenshot Download | `GET /screenshots/:id/download` → signed URL with `Content-Disposition`. |
| SS-15 | Screenshot Delete | `DELETE /screenshots/:id` (employee own if setting allows; deletes object; optional "delete time too" per org rule). |
| SS-16 | Screenshot Blur Option | Setting `screenshot_blur`; blurred variant generated by worker; non-privileged viewers get blurred key only. |
| SS-17 | Screenshot Storage Management | `GET /screenshots/storage` usage per org vs plan limit. |
| SS-18 | Screenshot Timestamp | `captured_at` (agent) + `received_at`. |
| SS-19 | Screenshot Linked to Project | `project_id`. |
| SS-20 | Screenshot Linked to Task | `task_id`. |
| SS-21 | Screenshot Linked to Employee | `member_id`. |
| SS-22 | Screenshot Activity Information | `activity_percent`, `app_name`, `window_title` (title capture optional setting). |
| SS-23 | Screenshot Filters | Query filters: member, team, project, task, date range, activity level. |
| SS-24 | Screenshot Retention Settings | `screenshot_retention_days`; nightly job deletes expired (bounded by plan SUB-20). |
| SS-25 | Screenshot Export | `POST /screenshots/export` → ZIP job → signed download link + email. |
| SS-26 | Screenshot Access Permissions | RBAC-07 enforced in service. |
| SS-27 | Screenshot Capture Notifications | Setting `notify_on_capture`; agent payload + optional in-app event. |
| SS-P1 | Employee must know when monitoring is active | `GET /me/monitoring-status` returns active tracking features; included in agent config. |
| SS-P2 | Visible monitoring indicator | Config flag `show_indicator` **forced true** (cannot be disabled). |
| SS-P3 | Employee can view their own screenshots | `screenshots.view` own always granted to every tracked member. |
| SS-P4 | No hidden monitoring or stealth mode | No API to enable stealth; agent config rejects; capture only while timer running & consent given. |
| SS-P5 | Configurable screenshot privacy settings | blur, allow employee delete, retention, title capture on/off. |

- **Entities:** screenshots, tracking_settings, export_jobs.
- **Dependencies:** M05, M07, M22, M24 (signed URLs), M25 (storage limits).
- **Business logic:** captures accepted only when a time entry is running for that member/device and consent exists (PRIV-01). Objects stored under `org/{orgId}/screenshots/{yyyy}/{mm}/{dd}/{uuid}.webp`; never public. Signed URL TTL 5 min.

---

### M07 — Employee Activity Monitoring (PDF §7)
| ID | Feature | Back-end requirement |
|---|---|---|
| ACT-01 | Keyboard Activity Detection | Agent sends **counts/flags only** per interval (`keyboard_active_seconds`). |
| ACT-02 | Mouse Activity Detection | `mouse_active_seconds`. |
| ACT-03 | Active Time Calculation | `active_seconds` = seconds with any input per interval. |
| ACT-04 | Idle Time Calculation | `interval_seconds - active_seconds`; idle periods from M13. |
| ACT-05 | Activity Percentage | `active_seconds / tracked_seconds × 100`. |
| ACT-06 | Activity Timeline | `GET /activity/timeline?memberId&date` (10-min buckets). |
| ACT-07 | Hourly Activity Report | `GET /reports/activity?granularity=hour`. |
| ACT-08 | Daily Activity Report | `granularity=day`. |
| ACT-09 | Weekly Activity Report | `granularity=week`. |
| ACT-10 | Monthly Activity Report | `granularity=month`. |
| ACT-11 | Employee Activity Comparison | `GET /reports/activity/compare?memberIds=`. |
| ACT-12 | Team Activity Comparison | `?teamIds=`. |
| ACT-13 | Project Activity Comparison | `?projectIds=`. |
| ACT-14 | Activity Trend Analysis | Moving average / period-over-period delta. |
| ACT-15 | Low Activity Alerts | Job: activity < `low_threshold` for N consecutive intervals → notify (M19). |
| ACT-16 | Idle Time Alerts | Idle period > configured minutes → notify. |
| ACT-17 | Active vs Idle Time Chart | Endpoint returns `{active, idle}` series. |

- **Activity levels (configurable):** Low 0–30%, Moderate 31–60%, High 61–100% → `activity_thresholds` in org settings (`low_max=30`, `moderate_max=60`). API returns level labels; docs/UI must state it is **not the sole measure of performance**.
- **Privacy (hard rule):** schema has **no column** for keystroke content, key codes or mouse coordinates. Ingestion validator rejects unknown fields (`.strict()`).
- **Entities:** activity_samples (partitioned by month), daily_summaries.
- **Dependencies:** M05, M22.

---

### M08 — Application & Website Tracking (PDF §8)
| ID | Feature | Back-end requirement |
|---|---|---|
| APP-01 | Application Usage Tracking | `POST /agent/app-usage` batch of `{appName, startedAt, endedAt}`. |
| APP-02 | Website Usage Tracking | `POST /agent/web-usage` `{domain, url?, browser, startedAt, endedAt}`. |
| APP-03 | Application Name Detection | Normalize `app_name` (exe/bundle id → display name) via `applications` dictionary. |
| APP-04 | Website URL Detection | Store domain always; full URL only if `track_full_url` setting; strip query strings by default. |
| APP-05 | Browser Tracking | `browser` enum. |
| APP-06 | Chrome Support | Accept `browser='chrome'`. |
| APP-07 | Firefox Support | `'firefox'`. |
| APP-08 | Edge Support | `'edge'`. |
| APP-09 | Application Usage Duration | Aggregates by app. |
| APP-10 | Website Visit Duration | Aggregates by domain. |
| APP-11 | Application Usage Timeline | `GET /apps/timeline?memberId&date`. |
| APP-12 | Website Usage Timeline | `GET /websites/timeline`. |
| APP-13 | Productive Application List | `productivity_rules` category `productive`. |
| APP-14 | Unproductive Application List | `unproductive`. |
| APP-15 | Neutral Application List | `neutral` (default for unknown). |
| APP-16 | Custom Application Categorization | `POST/PATCH /productivity-rules` scoped org/team/member (most specific wins). |
| APP-17 | Productive Time Calculation | Σ duration where category productive. |
| APP-18 | Unproductive Time Calculation | Σ unproductive. |
| APP-19 | Website Category Management | Same rules table with `target_type='website'`, domain patterns. |
| APP-20 | App Usage Reports | `GET /reports/apps`. |
| APP-21 | Website Usage Reports | `GET /reports/websites`. |
| APP-22 | Individual Employee App Reports | `memberId` filter. |
| APP-23 | Team App Usage Reports | `teamId` filter. |
| APP-24 | App Tracking On/Off | Setting `app_tracking_enabled`. |
| APP-25 | Website Tracking On/Off | `website_tracking_enabled`. |

- **Seed examples (PDF):** VS Code → Productive; Figma → Productive; Slack → Neutral; YouTube → configurable (default neutral); Facebook → configurable (default neutral).
- **Sensitive website exclusions (PRIV-05):** domains in exclusion list are stored as `"(excluded)"` with no URL and no screenshots linked.
- **Entities:** app_usage, web_usage (partitioned), applications, productivity_rules.
- **Dependencies:** M05, M22.

---

### M09 — Project Management (PDF §9)
| ID | Feature | Back-end requirement |
|---|---|---|
| PROJ-01 | Create Project | `POST /projects`. |
| PROJ-02 | Edit Project | `PATCH /projects/:id`. |
| PROJ-03 | Delete Project | `DELETE` (soft; blocked if has approved/invoiced time unless forced by OW). |
| PROJ-04 | Archive Project | `POST /projects/:id/archive|unarchive` (archived: no new time). |
| PROJ-05 | Project Name | `name` unique per org (active). |
| PROJ-06 | Project Description | `description`. |
| PROJ-07 | Project Start Date | `start_date`. |
| PROJ-08 | Project Deadline | `deadline`. |
| PROJ-09 | Project Status | enum `planning, active, on_hold, completed, cancelled`. |
| PROJ-10 | Project Budget | `budget_type (hours|amount)`, `budget_value`, currency. |
| PROJ-11 | Project Hourly Rate | `hourly_rate` (billing). |
| PROJ-12 | Project Manager Assignment | `project_members.role='manager'` (multiple). |
| PROJ-13 | Team Assignment | `project_teams`. |
| PROJ-14 | Employee Assignment | `project_members`. |
| PROJ-15 | Project Priority | enum `low, medium, high, urgent`. |
| PROJ-16 | Project Progress | Computed: completed tasks / total (or manual override). |
| PROJ-17 | Project Time Tracking | Time entries by project. |
| PROJ-18 | Total Project Hours | Aggregate. |
| PROJ-19 | Project Activity History | `activity_log` entries `entity_type='project'`. |
| PROJ-20 | Project Attachments | `attachments` (presigned upload). |
| PROJ-21 | Project Comments | `comments`. |
| PROJ-22 | Project Notes | `project_notes` (pinned, private/internal flag). |
| PROJ-23 | Project-wise Reports | `GET /reports/projects/:id`. |
| PROJ-24 | Project-wise Employee Performance | `GET /projects/:id/members/performance`. |
| PROJ-25 | Project Completion Percentage | Same as progress, exposed as `completionPercent`. |
| PROJ-26 | Project Deadline Notifications | Job: N days before deadline + overdue. |
| PROJ-27 | Project Status Updates | Status change → activity log + notification. |
| PROJ-28 | Project Access Permissions | Only members/teams/managers/clients of a project (or org-scope roles) can see it. |

- **Entities:** clients, projects, project_members, project_teams, project_notes, comments, attachments, activity_log.
- **Dependencies:** M01–M04; Clients (M17); Billing (M18).

---

### M10 — Task Management (PDF §10)
| ID | Feature | Back-end requirement |
|---|---|---|
| TASK-01 | Create Task | `POST /tasks` (projectId required). |
| TASK-02 | Edit Task | `PATCH /tasks/:id`. |
| TASK-03 | Delete Task | Soft delete. |
| TASK-04 | Assign Task to Employee | `task_assignees`. |
| TASK-05 | Assign Multiple Employees | Multiple rows. |
| TASK-06 | Task Description | Rich text (sanitized HTML/Markdown). |
| TASK-07 | Task Priority (Low, Medium, High, Urgent) | enum. |
| TASK-08 | Task Status | `board_column_id` + status category (`todo,in_progress,in_review,done`). |
| TASK-09 | Task Start Date | `start_date`. |
| TASK-10 | Task Due Date | `due_date`. |
| TASK-11 | Task Estimated Hours | `estimated_hours`. |
| TASK-12 | Task Actual Hours | Σ approved+pending time entries. |
| TASK-13 | Task Time Tracking | Entries with `task_id`. |
| TASK-14 | Task Progress | `progress_percent` (manual) or subtask completion ratio. |
| TASK-15 | Task Labels | `labels`, `task_labels`. |
| TASK-16 | Task Categories | `task_categories`. |
| TASK-17 | Task Subtasks | `parent_task_id` (1 level) or `subtasks` checklist table. |
| TASK-18 | Task Dependencies | `task_dependencies` (blocks/blocked_by); cycle detection. |
| TASK-19 | Task Comments | `comments` (+ mentions). |
| TASK-20 | Task Attachments | `attachments`. |
| TASK-21 | Task Activity History | `activity_log`. |
| TASK-22 | Task Completion | Move to done column → `completed_at`; blocked if unfinished dependencies (configurable). |
| TASK-23 | Task Review | `in_review` status + reviewer. |
| TASK-24 | Task Approval | `POST /tasks/:id/approve|request-changes` → `approved_by/at`. |
| TASK-25 | Task Notifications | On assign/comment/status change. |
| TASK-26 | Overdue Task Alerts | Job hourly. |
| TASK-27 | Task-wise Time Reports | `GET /reports/tasks`. |

- **Entities:** tasks, task_assignees, labels, task_labels, task_categories, task_dependencies, subtasks (via parent_task_id), comments, attachments, activity_log.
- **Permissions:** `tasks.view` (project members), `tasks.create/update/delete/assign` (project managers + scoped roles), employee can update status/progress of own tasks.

---

### M11 — Kanban Board (PDF §11)
| ID | Feature | Back-end requirement |
|---|---|---|
| KAN-01 | To Do Column | Default column seeded per project (`category=todo`). |
| KAN-02 | In Progress Column | Seeded. |
| KAN-03 | In Review Column | Seeded. |
| KAN-04 | Completed Column | Seeded (`category=done`). |
| KAN-05 | Drag and Drop Tasks | `PATCH /tasks/:id/move` {columnId, position} — fractional/lexorank `position` (no full reorder). |
| KAN-06 | Custom Columns | `POST/PATCH/DELETE /projects/:id/columns` (must keep ≥1 column per category todo & done). |
| KAN-07 | Task Card View | `GET /projects/:id/board` returns columns + card DTOs. |
| KAN-08 | Task Detail Modal | `GET /tasks/:id` full. |
| KAN-09 | Task Priority Indicators | In card DTO. |
| KAN-10 | Task Assignee Avatars | Assignee avatar URLs in DTO. |
| KAN-11 | Due Date Display | In DTO + `isOverdue`. |
| KAN-12 | Task Labels | In DTO. |
| KAN-13 | Subtask Progress | `subtasksDone/subtasksTotal`. |
| KAN-14 | Task Comments | Comment count in DTO; comments API. |
| KAN-15 | Quick Task Creation | `POST /tasks` minimal {title, columnId}. |
| KAN-16 | Filter by Employee | `?assigneeId`. |
| KAN-17 | Filter by Project | Board per project + cross-project board `GET /board?projectIds`. |
| KAN-18 | Filter by Priority | `?priority`. |
| KAN-19 | Search Tasks | `?search` (trigram index on title). |
| KAN-20 | Board View | Board endpoint. |
| KAN-21 | List View | `GET /tasks` paginated. |
| KAN-22 | Calendar View | `GET /tasks/calendar?from&to` (by due/start date). |

- **Entities:** board_columns, tasks.position. **Real-time:** `board.task_moved` socket events to project room.

---

### M12 — Attendance & Work Schedule (PDF §12)
| ID | Feature | Back-end requirement |
|---|---|---|
| ATT-01 | Employee Check-In | `POST /attendance/check-in` (or auto on first timer start, setting). |
| ATT-02 | Employee Check-Out | `POST /attendance/check-out` (or auto on last stop / end of day job). |
| ATT-03 | Daily Attendance | `GET /attendance?date`. |
| ATT-04 | Weekly Attendance | `?from&to` grouped by week. |
| ATT-05 | Monthly Attendance | grouped by month. |
| ATT-06 | Late Arrival Detection | `check_in > shift_start + grace` → `is_late`, `late_minutes`. |
| ATT-07 | Early Leave Detection | `check_out < shift_end - grace`. |
| ATT-08 | Absent Employee Detection | Job after shift end + buffer: working day, not holiday, no check-in → `status='absent'`. |
| ATT-09 | Working Day Configuration | `work_schedules.working_days` (ISO weekday array). |
| ATT-10 | Office Working Hours | Schedule `start_time`, `end_time`. |
| ATT-11 | Remote Working Schedule | `work_mode = office|remote|hybrid` per schedule/member/day. |
| ATT-12 | Flexible Working Hours | `schedule_type='flexible'` (required hours/day, no fixed start → no late detection). |
| ATT-13 | Shift Management | `shifts` CRUD. |
| ATT-14 | Multiple Shifts | `shift_assignments` (member, shift, date range, weekdays). |
| ATT-15 | Holiday Management | `holidays` (org-wide or per team/location, recurring yearly). |
| ATT-16 | Weekend Configuration | Non-working days from schedule. |
| ATT-17 | Attendance Correction Request | `POST /attendance/corrections`. |
| ATT-18 | Attendance Approval | `POST /attendance/corrections/:id/approve|reject`. |
| ATT-19 | Attendance History | `GET /members/:id/attendance`. |
| ATT-20 | Attendance Reports | `GET /reports/attendance`. |
| ATT-21 | Overtime Attendance | Overtime minutes on attendance record. |
| ATT-22 | Attendance Notifications | Late/absent/correction events → M19. |

- **Entities:** work_schedules, shifts, shift_assignments, holidays, attendance_records, attendance_corrections.
- **Business logic:** schedule resolution order: shift assignment for date → member schedule → team schedule → org default. All comparisons in member timezone.

---

### M13 — Break & Idle Time Management (PDF §13)
| ID | Feature | Back-end requirement |
|---|---|---|
| BRK-01 | Start Break | `POST /breaks/start` {breakTypeId} → pauses running timer. |
| BRK-02 | End Break | `POST /breaks/end` → optionally resumes timer. |
| BRK-03 | Paid Break | `break_types.is_paid=true`. |
| BRK-04 | Unpaid Break | `is_paid=false`. |
| BRK-05 | Lunch Break | Seeded type. |
| BRK-06 | Tea Break | Seeded type. |
| BRK-07 | Custom Break Types | CRUD `/break-types` (name, paid, max minutes, color). |
| BRK-08 | Break Duration | Computed; over-limit flag. |
| BRK-09 | Break Time Reports | `GET /reports/breaks`. |
| BRK-10 | Automatic Idle Detection | Shared with TIME-20 (`idle_periods`). |
| BRK-11 | Idle Time Notifications | Socket + desktop payload when idle detected. |
| BRK-12 | Idle Time Confirmation | TIME-22 resolve endpoint. |
| BRK-13 | Auto-Pause Timer | TIME-21. |
| BRK-14 | Idle Time Adjustment Request | `POST /idle-adjustments` {idlePeriodId, reason, requestedAction}. |
| BRK-15 | Manager Approval for Adjustments | `POST /idle-adjustments/:id/approve|reject` → updates time entry worked time. |

- **Entities:** break_types, breaks, idle_periods, idle_adjustment_requests.

---

### M14 — Timesheet Management (PDF §14)
| ID | Feature | Back-end requirement |
|---|---|---|
| TS-01 | Automatic Timesheet Generation | Job at period start creates `timesheets` (draft) per member; entries linked by date range. |
| TS-02 | Daily Timesheet | `GET /timesheets/view?period=day`. |
| TS-03 | Weekly Timesheet | `period=week` (default approval period). |
| TS-04 | Monthly Timesheet | `period=month`. |
| TS-05 | Employee Timesheet | `?memberId`. |
| TS-06 | Team Timesheet | `?teamId` grid (members × days). |
| TS-07 | Project Timesheet | `?projectId`. |
| TS-08 | Task Timesheet | `?taskId`. |
| TS-09 | Manual Time Entry | Same as TIME-06 from timesheet grid (cell edit creates/updates manual entry). |
| TS-10 | Edit Timesheet | Allowed in `draft`/`rejected`. |
| TS-11 | Submit Timesheet | `POST /timesheets/:id/submit`. |
| TS-12 | Approve Timesheet | `POST /timesheets/:id/approve` (marks all entries approved). |
| TS-13 | Reject Timesheet | `POST /timesheets/:id/reject` {reason}. |
| TS-14 | Timesheet Revision | Rejected → edit → resubmit (`revision` counter++). |
| TS-15 | Timesheet Approval Workflow | Configurable levels (`approval_levels`: TL → MG); `timesheet_approvals` per level. |
| TS-16 | Timesheet Locking | Approved = locked; org `lock_after_days` auto-lock job; `POST /timesheets/:id/unlock` (AD/OW). |
| TS-17 | Timesheet Comments | `comments` entity_type `timesheet`. |
| TS-18 | Timesheet PDF Export | `GET /timesheets/:id/export?format=pdf`. |
| TS-19 | Timesheet Excel Export | `format=xlsx`. |
| TS-20 | Timesheet CSV Export | `format=csv`. |
| TS-21 | Timesheet History | `timesheet_events` (status transitions, actor, comment). |

- **Entities:** timesheets, timesheet_approvals, timesheet_events, comments.
- **State machine:** `draft → submitted → (level n approved)… → approved(locked)`; `submitted → rejected → draft(revision+1)`. Edits to time entries in a locked period return `409 TIMESHEET_LOCKED`.

---

### M15 — Reports & Analytics (PDF §15)
**Dashboard Analytics:** RPT-D01 Total Employees · RPT-D02 Active Employees · RPT-D03 Online Employees · RPT-D04 Currently Tracking Employees · RPT-D05 Total Working Hours · RPT-D06 Total Productive Hours · RPT-D07 Total Idle Hours · RPT-D08 Total Break Hours · RPT-D09 Average Activity Percentage · RPT-D10 Total Projects · RPT-D11 Total Tasks · RPT-D12 Completed Tasks · RPT-D13 Pending Tasks · RPT-D14 Overtime Hours
→ `GET /dashboard/stats?from&to&teamId&projectId&memberId` (scoped). Online = socket presence/heartbeat < 2 min; Tracking = running timer.

**Employee Reports:** RPT-E01 Individual Employee Reports · RPT-E02 Employee Working Hours · RPT-E03 Employee Activity Reports · RPT-E04 Employee Screenshot Reports · RPT-E05 Employee App Usage Reports · RPT-E06 Employee Website Usage Reports · RPT-E07 Employee Attendance Reports · RPT-E08 Employee Performance Reports

**Project Reports:** RPT-P01 Total Project Hours · RPT-P02 Project-wise Time Reports · RPT-P03 Project Cost Reports · RPT-P04 Project Progress Reports · RPT-P05 Project Completion Reports · RPT-P06 Employee Contribution Reports

**Analytics & Visualization:** RPT-A01 Daily Activity Charts · RPT-A02 Weekly Activity Charts · RPT-A03 Monthly Activity Charts · RPT-A04 Productivity Trend Charts · RPT-A05 Employee Comparison Charts · RPT-A06 Project Comparison Charts · RPT-A07 Working Hours Distribution · RPT-A08 Active vs Idle Time Charts · RPT-A09 App Usage Pie Charts · RPT-A10 Attendance Charts · RPT-A11 Date Range Filtering · RPT-A12 Custom Report Builder · RPT-A13 Report Export (PDF, CSV, Excel) · RPT-A14 Scheduled Reports · RPT-A15 Email Reports · RPT-A16 Shareable Read-Only Reports

- **Back-end requirement:** a **report engine** (`services/reports/`) with typed report definitions (`time`, `activity`, `apps`, `websites`, `screenshots`, `attendance`, `breaks`, `projects`, `tasks`, `performance`, `billing`, `payroll`) accepting `{from, to, groupBy[], filters{}, metrics[]}`; all chart endpoints return `{series, totals}` JSON.
- **Custom Report Builder:** `saved_reports` stores definition JSON; `POST /reports/run`.
- **Scheduled / Email Reports:** `report_schedules` (cron, timezone, recipients, format) → BullMQ repeatable job → generate file → email.
- **Shareable Read-Only Reports:** `report_shares` (random token, expiry, optional password, revocable) → `GET /public/reports/:token` (no auth, read-only, rate-limited).
- **Performance:** reads from `daily_summaries` (per member/day/project) maintained incrementally on entry/activity writes + nightly reconciliation; raw tables only for drill-down.

---

### M16 — Employee Performance & Productivity (PDF §16)
| ID | Feature | Back-end requirement |
|---|---|---|
| PERF-01 | Employee Productivity Score | Default formula (configurable weights): `0.4·activity% + 0.4·productive_app_ratio + 0.2·task_completion_rate`. Label as indicator, not sole measure. |
| PERF-02 | Individual Performance Overview | `GET /performance/members/:id`. |
| PERF-03 | Team Performance Overview | `GET /performance/teams/:id`. |
| PERF-04 | Daily Performance | `granularity=day`. |
| PERF-05 | Weekly Performance | `week`. |
| PERF-06 | Monthly Performance | `month`. |
| PERF-07 | Productivity Trends | Time series. |
| PERF-08 | Task Completion Rate | completed on time / due in period. |
| PERF-09 | Project Contribution | member hours / project hours. |
| PERF-10 | Estimated vs Actual Time | tasks estimated vs actual. |
| PERF-11 | Working Hour Consistency | Std-dev of daily hours vs expected (score 0–100). |
| PERF-12 | Activity Trends | From M07. |
| PERF-13 | Performance Comparison | Multi-member compare. |
| PERF-14 | Top Contributors | Ranked by hours/tasks per project/team. |
| PERF-15 | Workload Distribution | Open task estimates + scheduled hours per member. |
| PERF-16 | Performance History | `performance_snapshots` monthly. |
| PERF-17 | Performance Goals | `performance_goals` CRUD (metric, target, period, member/team). |
| PERF-18 | Productivity Alerts | Job: score/goal under threshold → M19. |
| PERF-19 | Custom Performance Metrics | `custom_metrics` (formula from whitelisted metric names + weights; no arbitrary code). |

**Leaderboard:** LB-01 Top Productive Employees · LB-02 Most Active Employees · LB-03 Most Tasks Completed · LB-04 Most Working Hours · LB-05 Highest Task Completion Rate · LB-06 Monthly Performance Ranking → `GET /leaderboard?metric&period&teamId` (org setting can hide leaderboard from employees).

---

### M17 — Client Portal (PDF §17)
| ID | Feature | Back-end requirement |
|---|---|---|
| CLI-01 | Client Registration | Org creates `clients`; invites client users (`role=client`) → accept creates user. Self-registration only via invite token. |
| CLI-02 | Client Login | Same auth; client member gets `client` role & `client_id`. |
| CLI-03 | Client Profile | `GET/PATCH /client-portal/profile`. |
| CLI-04 | Client Dashboard | `GET /client-portal/dashboard`. |
| CLI-05 | Client Project Access | Only `projects.client_id = member.client_id` AND `client_visible=true`. |
| CLI-06 | Project Progress Overview | Progress, milestones. |
| CLI-07 | Assigned Team Overview | Names/avatars/roles of project members (no rates). |
| CLI-08 | Project Time Reports | Hours by day/member/task. |
| CLI-09 | Task Progress | Tasks list (client-visible fields). |
| CLI-10 | Billable Hours | Billable approved hours. |
| CLI-11 | Project Budget Overview | Budget vs used. |
| CLI-12 | Timesheet Viewing | Approved timesheets for their projects. |
| CLI-13 | Shared Reports | Reports shared with client (`report_shares.client_id`). |
| CLI-14 | Read-Only Access | Client role has no write permissions except comments/profile. |
| CLI-15 | Client Comments | `comments` on project/task with `visibility='client'`. |
| CLI-16 | Client Notifications | M19 with client-specific event types. |
| CLI-17 | Invoice Summary | Client's invoices (status, totals, PDF). |
| CLI-18 | Client-Specific Permissions | `client_permissions` JSON: show screenshots? show activity? show member names? show rates? |

- **Entities:** clients, organization_members.client_id, client permission flags.
- **Routes:** `/api/v1/client-portal/*` — separate router with `requireRole('client')`.

---

### M18 — Billing & Payroll Management (PDF §18)
| ID | Feature | Back-end requirement |
|---|---|---|
| BILL-01 | Employee Hourly Rate | `member_rates` (cost/pay rate, effective dated). |
| BILL-02 | Project Hourly Rate | `projects.hourly_rate` (+ `project_members.billable_rate` override). |
| BILL-03 | Client Hourly Rate | `clients.hourly_rate`. |
| BILL-04 | Billable Hours | `time_entries.is_billable` (default from project). |
| BILL-05 | Non-Billable Hours | `is_billable=false`. |
| BILL-06 | Total Project Cost | Σ worked hours × member cost rate (at entry date). |
| BILL-07 | Employee Salary Calculation | Payroll run: regular hours × rate (+ paid breaks) or fixed salary. |
| BILL-08 | Overtime Payment Calculation | overtime hours × rate × `overtime_multiplier` (org, default 1.5). |
| BILL-09 | Monthly Payroll Summary | `payroll_runs` per period with `payroll_items`. |
| BILL-10 | Project Billing Summary | Billable hours × billing rate per project. |
| BILL-11 | Client Invoice Generation | `POST /invoices/generate` {clientId, from, to, projectIds} → draft with line items from approved billable entries (entries marked `invoice_id` to prevent double billing). |
| BILL-12 | Invoice PDF Export | `GET /invoices/:id/pdf`. |
| BILL-13 | Invoice Status | `draft, sent, partially_paid, paid, overdue, void`. |
| BILL-14 | Paid / Unpaid Tracking | `invoice_payments`; overdue job. |
| BILL-15 | Payroll Reports | `GET /reports/payroll`. |
| BILL-16 | Currency Settings | Org default currency; per client/project/member currency. |
| BILL-17 | Multi-Currency Support | `exchange_rates` table (daily, provider job); amounts stored in original currency + converted reporting currency at document date. |

- **Billing rate resolution:** `project_member.billable_rate → project.hourly_rate → client.hourly_rate → org.default_billable_rate`.
- **Money:** `numeric(14,2)`, never float. Currency ISO-4217 `char(3)`.

---

### M19 — Notifications & Alerts (PDF §19)
| ID | Event / Feature |
|---|---|
| NOTIF-01 | Employee Invitation Notification |
| NOTIF-02 | New Project Notification |
| NOTIF-03 | New Task Assignment Notification |
| NOTIF-04 | Task Deadline Reminder |
| NOTIF-05 | Overdue Task Alert |
| NOTIF-06 | Timer Started Notification |
| NOTIF-07 | Timer Stopped Notification |
| NOTIF-08 | Idle Time Alert |
| NOTIF-09 | Screenshot Capture Notification |
| NOTIF-10 | Low Activity Alert |
| NOTIF-11 | Attendance Alert |
| NOTIF-12 | Late Arrival Alert |
| NOTIF-13 | Timesheet Submission Reminder |
| NOTIF-14 | Timesheet Approval Notification |
| NOTIF-15 | Timesheet Rejection Notification |
| NOTIF-16 | Weekly Summary Notification |
| NOTIF-17 | Monthly Summary Notification |
| NOTIF-18 | Project Budget Alert (at 80% / 100% configurable) |
| NOTIF-19 | Overtime Alert |
| NOTIF-20 | System Notifications |
| NOTIF-21 | Email Notifications (channel) |
| NOTIF-22 | In-App Notifications (channel) |
| NOTIF-23 | Desktop Notifications (channel: payload delivered to desktop agent via socket/poll; browser Web Push optional) |
| NOTIF-24 | Notification Preferences (per user × event × channel; org defaults; mandatory events cannot be muted) |

- **Design:** `notificationService.emit(eventType, {orgId, recipients, data})` → resolve recipients & preferences → insert `notifications` rows (in-app) → socket `notification.new` → enqueue email/desktop jobs. Templates per event in `src/notifications/templates/`.
- **Endpoints:** `GET /notifications`, `PATCH /notifications/:id/read`, `POST /notifications/read-all`, `GET/PUT /me/notification-preferences`, `GET/PUT /organization/notification-defaults`.
- **Entities:** notifications, notification_preferences.

---

### M20 — Desktop App Support & Offline Tracking & Synchronization (PDF unnumbered "Desktop App Features" + §21)
**Desktop features with back-end support (DESK):** DESK-01 Employee Login (`POST /agent/auth/login`, device registration) · DESK-02 Organization Selection (`GET /agent/organizations`) · DESK-03 Project Selection · DESK-04 Task Selection (`GET /agent/projects`, `/agent/tasks`) · DESK-05 Start / Stop Timer · DESK-06 Pause / Resume Timer (same timer service) · DESK-07 Current Timer Display (`GET /agent/timer`) · DESK-08 Daily Working Hours Display (`GET /agent/today`) · DESK-09 Current Activity Status · DESK-10 Screenshot Capture (upload API) · DESK-11 Activity Detection · DESK-12 Idle Detection · DESK-13 Application Tracking · DESK-14 Website Tracking (ingestion) · DESK-15 Offline Time Tracking · DESK-16 Automatic Data Synchronization · DESK-17 Background Tracking While Enabled (heartbeat) · DESK-18 System Tray Integration (n/a back end) · DESK-19 Desktop Notifications (payload) · DESK-20 Auto Start on System Boot (n/a) · DESK-21 Auto Update (`GET /agent/releases/latest?os&channel`) · DESK-22 App Version Information (`devices.app_version`, min supported version check → `426 Upgrade Required`) · DESK-23 Internet Connection Status (heartbeat) · DESK-24 Device Information (`devices`) · DESK-25 Logout (revoke device token) · DESK-26 Quit Application (final heartbeat, timer stop) · Supported OS: Windows 10/11, macOS, Linux (`devices.os` enum).

| ID | Feature (§21) | Back-end requirement |
|---|---|---|
| SYNC-01 | Offline Time Tracking | Accept entries with past timestamps flagged `is_offline`. |
| SYNC-02 | Local Data Storage | Agent-side; server defines payload schema. |
| SYNC-03 | Offline Screenshot Storage | Agent-side; late uploads accepted within retention window. |
| SYNC-04 | Offline Activity Recording | Batch activity ingestion. |
| SYNC-05 | Automatic Sync When Internet Returns | `POST /agent/sync` batch (entries, pauses, idle, activity, apps, web, screenshots meta). |
| SYNC-06 | Failed Sync Retry | Idempotent API; per-item result `{clientId, status: ok|duplicate|conflict|error}`. |
| SYNC-07 | Duplicate Data Prevention | `UNIQUE(device_id, client_uuid)` on every ingested table. |
| SYNC-08 | Conflict Resolution | Overlap with existing entries → server-wins for approved/locked periods; otherwise store as `conflict` & create review item for manager/employee. |
| SYNC-09 | Sync Status Indicator | `devices.last_sync_at`, `pending_count` reported; dashboard shows per device. |
| SYNC-10 | Pending Upload Queue | Agent-side; server exposes `GET /agent/sync/status`. |
| SYNC-11 | Data Integrity Validation | Payload checksum (SHA-256) + server validation (no future timestamps > 5 min skew, end > start, max offline age setting). |
| SYNC-12 | Last Sync Timestamp | `devices.last_sync_at`. |

- **Auth:** device-bound tokens (`device_tokens`), scope `agent:*`, revocable from dashboard.
- **Entities:** devices, device_tokens, sync_batches, sync_conflicts, app_releases.

---

### M21 — Admin Dashboard & Control Center (PDF §22)
| ID | Feature | Back-end requirement |
|---|---|---|
| ADM-01 | Organization Overview | `GET /dashboard/overview`. |
| ADM-02 | Employee Overview | members counts by status/department. |
| ADM-03 | Team Overview | per team hours/activity. |
| ADM-04 | Project Overview | active/at-risk/over-budget projects. |
| ADM-05 | Task Overview | by status, overdue. |
| ADM-06 | Live Employee Monitoring | Socket room `org:{id}:live` — presence, current task, activity %, latest screenshot. |
| ADM-07 | Currently Active Employees | `GET /live/members`. |
| ADM-08 | Employee Activity Status | `online / tracking / idle / on_break / offline`. |
| ADM-09 | Latest Screenshots | `GET /screenshots/latest?limit`. |
| ADM-10 | Working Hours Summary | stats. |
| ADM-11 | Productivity Summary | stats. |
| ADM-12 | Attendance Summary | present/late/absent today. |
| ADM-13 | Pending Approvals | `GET /approvals/pending` (union: manual time, timesheets, attendance corrections, idle adjustments, tasks). |
| ADM-14 | Pending Timesheets | filter type. |
| ADM-15 | Pending Manual Time Requests | filter type. |
| ADM-16 | Action Center | `GET /action-center` (approvals + alerts + sync conflicts) with bulk actions. |
| ADM-17 | Recent Activities | `GET /activity-log?limit` (org feed, scoped). |
| ADM-18 | System Alerts | `system_alerts` (storage near limit, seats, payment failed, sync failures). |
| ADM-19 | Quick Actions | n/a back end (uses existing endpoints). |
| ADM-20 | Date Range Filters | Standard `from/to` on all dashboard endpoints. |
| ADM-21 | Team Filters | `teamId`. |
| ADM-22 | Project Filters | `projectId`. |
| ADM-23 | Employee Filters | `memberId`. |

**Super Admin (platform) control** (from PDF §2 "Manage entire platform"): `/api/v1/platform/*` — orgs list/detail/suspend, users search, plans management, subscriptions overview, system health, platform audit log, impersonation (audited, opt-in by org owner — optional).

---

### M22 — Settings & Configuration (PDF §23)
**Organization Settings:** SET-O01 Organization Name · SET-O02 Company Logo · SET-O03 Company Time Zone · SET-O04 Default Currency · SET-O05 Date Format · SET-O06 Time Format · SET-O07 Working Days · SET-O08 Working Hours → columns on `organizations` + `organization_settings`.

**Tracking Settings:** SET-T01 Screenshot Enable/Disable · SET-T02 Screenshot Frequency · SET-T03 Random Screenshot Intervals · SET-T04 Screenshot Blur · SET-T05 Activity Tracking Enable/Disable · SET-T06 App Tracking Enable/Disable · SET-T07 Website Tracking Enable/Disable · SET-T08 Idle Detection Duration · SET-T09 Auto Pause Duration · SET-T10 Weekly Tracking Limits · SET-T11 Employee-Specific Settings · SET-T12 Team-Specific Settings
→ `tracking_settings` rows with `scope_type (org|team|project|member)` + nullable columns; **effective settings** = merge member > project > team > org (`GET /tracking-settings/effective?memberId&projectId`). Agent fetches effective config on login/timer start and on `settings.updated` socket event.

**Privacy Settings:** PRIV-01 Employee Consent · PRIV-02 Visible Tracking Indicator · PRIV-03 Employee Data Access · PRIV-04 Data Retention Period · PRIV-05 Screenshot Privacy · PRIV-06 Sensitive Website Exclusions · PRIV-07 Data Deletion Requests · PRIV-08 Data Export Requests · PRIV-09 Audit History
- Consent: `consents` (member, policy_version, accepted_at, IP); tracking APIs return `403 CONSENT_REQUIRED` without current consent.
- Employee data access: `GET /me/data` (own time, activity, screenshots, apps).
- Data export/deletion requests: `data_requests` (type, status, due date 30 days) → export job (ZIP JSON/CSV + screenshots) / deletion job (anonymize + delete objects), approved by OW/AD.
- Audit history: `audit_logs` (who, what, before/after diff, IP) for settings, roles, rates, deletions, approvals.

---

### M23 — API & Third-Party Integrations (PDF §24)
| ID | Feature | Back-end requirement |
|---|---|---|
| INT-01 | REST API | Versioned `/api/v1`. |
| INT-02 | API Key Management | `api_keys` (hashed, prefix shown, scopes, expiry, last used); `POST/GET/DELETE /api-keys`. |
| INT-03 | Webhooks | `webhooks` (url, events, secret) + `webhook_deliveries`; HMAC-SHA256 signature header; retries with backoff (BullMQ). |
| INT-04 | API Authentication | Bearer JWT (users), `X-API-Key` (integrations), device tokens (agent). |
| INT-05 | API Rate Limiting | Per IP, per user, per API key (Redis). Headers `RateLimit-*`. |
| INT-06 | API Documentation | Generated from Zod registry. |
| INT-07 | Swagger / OpenAPI | `/api/docs`, `/api/openapi.json`. |
| INT-08 | Google Authentication | AUTH-02. |
| INT-09 | Slack Integration | OAuth install; post notifications/summaries to channel; slash command `/tracker status` (optional). |
| INT-10 | Microsoft Teams Integration | Incoming webhook / Graph app for notifications. |
| INT-11 | Jira Integration | OAuth 3LO; import projects/issues → tasks; push worklogs. |
| INT-12 | Trello Integration | Import boards/cards → tasks. |
| INT-13 | Asana Integration | Import projects/tasks. |
| INT-14 | ClickUp Integration | Import spaces/lists/tasks. |
| INT-15 | GitHub Integration | Link issues/PRs to tasks; import issues. |
| INT-16 | GitLab Integration | Same as GitHub. |
| INT-17 | Payroll Integration | Export payroll run via CSV + provider adapter interface. |
| INT-18 | Accounting Integration | Push invoices (adapter: QuickBooks/Xero). |
| INT-19 | Calendar Integration | Google/Outlook calendar → meeting time suggestions (TIME-18), holidays. |
| INT-20 | Zapier Integration | Uses API keys + webhooks (REST hooks subscribe/unsubscribe endpoints). |
| INT-21 | n8n Integration | Same as Zapier (API key + webhooks). |

- **Design:** `integrations` (org, provider, status, encrypted tokens, settings) + `integration_links` (external id ↔ internal entity) + provider adapters in `src/integrations/providers/*` implementing `connect / sync / disconnect`. OAuth tokens encrypted with AES-256-GCM (`ENCRYPTION_KEY`).

---

### M24 — Security & Data Protection (PDF §25)
| ID | Feature | Implementation |
|---|---|---|
| SEC-01 | Secure Authentication | Short-lived JWT (RS256/EdDSA), rotating refresh tokens, httpOnly+Secure+SameSite cookies. |
| SEC-02 | Password Hashing | argon2id (memory 64MB, t=3); password policy (min 8, breached-password check optional). |
| SEC-03 | Two-Factor Authentication | AUTH-06; TOTP secret encrypted at rest. |
| SEC-04 | Role-Based Permissions | M02. |
| SEC-05 | Secure API Endpoints | `authenticate` + `authorize` on every non-public route; tests asserting 401/403. |
| SEC-06 | Data Encryption at Rest | Managed Postgres disk encryption + S3 SSE; app-level AES-GCM for secrets (TOTP, OAuth tokens, webhook secrets). |
| SEC-07 | HTTPS / TLS | TLS at load balancer; `helmet` HSTS; reject HTTP in prod. |
| SEC-08 | Secure Screenshot Storage | Private bucket, per-org prefix, SSE. |
| SEC-09 | Signed File URLs | Presigned GET 5 min, PUT 10 min. |
| SEC-10 | Audit Logs | `audit_logs`. |
| SEC-11 | Login Activity Logs | `login_history`. |
| SEC-12 | Device Management | Revoke devices/sessions. |
| SEC-13 | Session Expiration | Idle timeout + absolute max; org setting. |
| SEC-14 | Rate Limiting | INT-05. |
| SEC-15 | Brute Force Protection | Per account + IP progressive delay; lock 15 min after 5 failures; CAPTCHA hook. |
| SEC-16 | Database Backup | Daily automated backups + PITR (WAL); documented runbook. |
| SEC-17 | Data Recovery | Restore runbook; soft delete with 30-day restore for key entities. |
| SEC-18 | Data Retention Policies | Retention jobs per data type (screenshots, activity, app usage, logs). |
| SEC-19 | Employee Data Export | PRIV-08. |
| SEC-20 | Employee Data Deletion | PRIV-07. |
| SEC-21 | Organization Data Isolation | `organization_id` on every tenant row; repository layer always filters by `req.ctx.orgId`; optional Postgres RLS (`app.current_org` setting) as defense-in-depth; cross-tenant tests. |
| SEC-22 | GDPR-Compatible Privacy Controls | Consent, access, export, erasure, retention, DPA fields. |
| SEC-23 | Security Monitoring | Security events (failed logins spikes, token reuse, permission denials) → `security_events` + alert to SA/OW; error tracking (Sentry). |

---

### M25 — Subscription & SaaS Billing (PDF §26)
| ID | Feature | Back-end requirement |
|---|---|---|
| SUB-01 | Free Plan | `plans` seed. |
| SUB-02 | Starter Plan | seed. |
| SUB-03 | Professional Plan | seed. |
| SUB-04 | Enterprise Plan | seed (custom pricing, contact sales). |
| SUB-05 | Monthly Subscription | `billing_interval='month'`. |
| SUB-06 | Yearly Subscription | `'year'`. |
| SUB-07 | Per Employee Pricing | Stripe quantity = active seats. |
| SUB-08 | Free Trial | `trial_ends_at` (14 days default). |
| SUB-09 | Subscription Upgrade | Proration via Stripe. |
| SUB-10 | Subscription Downgrade | At period end; validate usage fits new limits. |
| SUB-11 | Subscription Cancellation | `cancel_at_period_end`. |
| SUB-12 | Payment History | `subscription_payments`. |
| SUB-13 | Invoice History | `subscription_invoices` (Stripe hosted URLs/PDF). |
| SUB-14 | Payment Gateway Integration | Stripe Checkout + Customer Portal + webhook `/webhooks/stripe` (signature verified, idempotent). |
| SUB-15 | Subscription Expiry Notifications | Job: trial ending (3 days), payment failed, expired. |
| SUB-16 | Usage Limits | `plan_limits` JSON; `usage_counters`. |
| SUB-17 | Employee Seat Limits | Enforced in EMP/AUTH invite & activate. |
| SUB-18 | Storage Limits | Screenshot/attachment upload check. |
| SUB-19 | Screenshot Retention Limits | Effective retention = min(org setting, plan max). |
| SUB-20 | Feature-Based Plan Restrictions | `requireFeature('integrations')` middleware; `GET /subscription/features`. |
| SUB-21 | Organization Subscription Management | `GET /subscription`, `POST /subscription/checkout`, `POST /subscription/portal`, `POST /subscription/change`, `POST /subscription/cancel`. |

---

## C. Back-End Development Roadmap

### C.1 Project Architecture (folder structure)
```
tracker-back-end/
├─ .env.example
├─ package.json                  # "type": "module"
├─ docs/MODULE_CONVENTIONS.md     # how to write a module (routes, scopes, jobs, tests)
├─ src/
│  ├─ server.js                  # http server + socket.io bootstrap
│  ├─ app.js                     # express app (middleware, routers, error handler)
│  ├─ worker.js                  # standalone job worker (optional; API runs it inline by default)
│  ├─ db/                        # migrations/*.sql, migrate.js, seed.js (permissions, plans, app catalog)
│  ├─ config/                    # env (zod-validated), constants
│  ├─ lib/                       # db (pg/PGlite), jobs, storage, mailer, logger, crypto, jwt, events, realtime, router, audit
│  ├─ middleware/                # authenticate, authorize, requireFeature, validate, rateLimit, orgContext, error, requestId, audit
│  ├─ modules/
│  │  ├─ auth/                   # *.routes.js, *.controller.js, *.service.js, *.schemas.js, *.repo.js, *.test.js
│  │  ├─ organizations/
│  │  ├─ roles/
│  │  ├─ members/                # employees
│  │  ├─ teams/  departments/
│  │  ├─ time/                   # timer, time-entries, idle
│  │  ├─ screenshots/
│  │  ├─ activity/
│  │  ├─ apps/                   # app & web usage, productivity rules
│  │  ├─ clients/  projects/  tasks/  board/
│  │  ├─ attendance/  schedules/  breaks/
│  │  ├─ timesheets/
│  │  ├─ reports/  dashboard/  performance/
│  │  ├─ client-portal/
│  │  ├─ billing/  payroll/  invoices/
│  │  ├─ notifications/
│  │  ├─ agent/                  # desktop ingestion + sync
│  │  ├─ settings/  privacy/
│  │  ├─ integrations/  api-keys/  webhooks/
│  │  ├─ subscription/
│  │  ├─ audit/
│  │  └─ platform/               # super admin
│  ├─ jobs/                      # queue definitions + processors
│  ├─ realtime/                  # socket auth, rooms, emitters, presence
│  ├─ integrations/providers/    # slack, teams, jira, trello, asana, clickup, github, gitlab, calendar, accounting, payroll
│  ├─ notifications/templates/
│  └─ docs/openapi.js            # zod-to-openapi registry
└─ tests/                        # integration tests, factories, helpers
```
Layering rule: **routes → controller (HTTP only) → service (business logic, transactions) → repo (Prisma queries, always org-scoped)**. Services never read `req`; they receive a `ctx` `{userId, memberId, orgId, permissions, scopes}`.

### C.2 Roadmap by area
1. **Database schema** — Prisma schema for §E, migrations per phase, seed script, partitioning SQL for high-volume tables (raw migration).
2. **Models & relationships** — as §E; soft-delete (`deleted_at`) on business entities; `created_by/updated_by`.
3. **Authentication** — M01 + SEC-01/02/13/15.
4. **Authorization & RBAC** — permission catalog, `authorize()`, scope resolver, caching.
5. **Routes & controllers** — per module (§F).
6. **Services & business logic** — timer state machine, overtime, attendance detection, timesheet workflow, rate resolution, productivity score, report engine.
7. **Validation & error handling** — Zod per route (`body`, `query`, `params`), central error handler, error code catalog.
8. **File & screenshot storage** — S3 adapter, presigned flows, `sharp` worker (thumb + blur), retention jobs, storage usage counter.
9. **Real-time** — Socket.IO with JWT handshake; rooms `user:{id}`, `org:{id}`, `org:{id}:live`, `project:{id}`; presence in Redis.
10. **Notifications** — event bus, preferences, channels, templates.
11. **Reporting & analytics** — `daily_summaries`, report engine, exports, schedules, shares.
12. **Security & optimization** — rate limits, RLS (optional), indexes, partitions, query plans for reports, caching dashboard stats (30–60 s).

---

## D. Architecture, Conventions & Cross-Cutting Concerns

### D.1 API conventions
- Base path `/api/v1`. JSON, camelCase in API, snake_case in DB.
- **Success:** `{ "data": ..., "meta": { "page": 1, "limit": 20, "total": 134 } }`
- **Error:** `{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [{ "path": "email", "message": "Invalid email" }], "requestId": "…" } }`
- Pagination: `?page=1&limit=20` (max 100); sorting `?sort=createdAt&order=desc`; search `?search=`; date ranges `?from=2026-11-01&to=2026-11-30` (inclusive dates interpreted in requester timezone unless `tz` given).
- IDs: UUID v7 (time-sortable). Timestamps ISO-8601 UTC.
- Idempotency: `Idempotency-Key` header supported on POST for timer, invoice generation, payments, agent sync.
- Status codes: 200/201/204, 400 validation, 401 unauthenticated, 403 forbidden/`FEATURE_NOT_IN_PLAN`/`CONSENT_REQUIRED`, 404, 409 conflict (`TIMER_ALREADY_RUNNING`, `TIMESHEET_LOCKED`, `ENTRY_OVERLAP`), 422 business rule, 426 agent upgrade, 429 rate limit.

### D.2 Request context & tenancy
`authenticate` → verifies JWT (`sub`, `orgId`, `memberId`, `roleId`, `sv` session version) → `orgContext` loads member (status must be active) & permissions (Redis cache) → `req.ctx`. Every repo function takes `ctx.orgId`. Platform routes require `is_super_admin`.

### D.3 Error code catalog (initial)
`VALIDATION_ERROR, UNAUTHENTICATED, TOKEN_EXPIRED, MFA_REQUIRED, INVALID_CREDENTIALS, ACCOUNT_LOCKED, EMAIL_NOT_VERIFIED, FORBIDDEN, NOT_FOUND, CONFLICT, TIMER_ALREADY_RUNNING, NO_RUNNING_TIMER, ENTRY_OVERLAP, WEEKLY_LIMIT_EXCEEDED, TIMESHEET_LOCKED, SEAT_LIMIT_REACHED, STORAGE_LIMIT_REACHED, FEATURE_NOT_IN_PLAN, CONSENT_REQUIRED, INVITATION_EXPIRED, LAST_OWNER, DEPENDENCY_CYCLE, RATE_LIMITED, AGENT_UPGRADE_REQUIRED`.

### D.4 Background jobs (Postgres job queue — `src/lib/jobs.js`)
| Queue | Jobs | Schedule |
|---|---|---|
| `email` | send templated email | on demand |
| `notifications` | fan-out, digests (weekly/monthly summary) | on demand / cron |
| `media` | screenshot thumbnail + blur, attachment scan | on upload |
| `alerts` | low activity, idle, overtime, budget, deadlines, overdue tasks | every 5–15 min |
| `attendance` | absent detection, auto check-out | hourly per tz |
| `timesheets` | generate periods, submission reminders, auto-lock | daily |
| `reports` | scheduled reports, exports (PDF/XLSX/CSV/ZIP) | cron / on demand |
| `retention` | delete expired screenshots/activity/logs | nightly |
| `summaries` | rebuild `daily_summaries`, performance snapshots | nightly + incremental |
| `billing` | invoice overdue, exchange rates, Stripe sync, subscription expiry notices | daily |
| `webhooks` | deliver with retries | on event |
| `integrations` | provider sync | cron per integration |
| `privacy` | data export / deletion requests | on approval |

### D.5 Real-time events (Socket.IO)
| Event | Room | Payload |
|---|---|---|
| `timer.started / paused / resumed / stopped` | `user:{id}`, `org:{id}:live` | entry DTO |
| `presence.updated` | `org:{id}:live` | `{memberId, status, currentTask, activityPercent}` |
| `screenshot.captured` | `org:{id}:live`, `user:{id}` | thumbnail meta |
| `idle.detected` | `user:{id}` | idle period |
| `notification.new` | `user:{id}` | notification DTO |
| `board.task_moved / task_updated` | `project:{id}` | task card |
| `approval.created / resolved` | `user:{approverId}` | approval item |
| `settings.updated` | `org:{id}` (agents) | effective settings version |
| `sync.status` | `user:{id}` | device sync state |
Socket rooms join only after permission check (e.g. live room requires `activity.view` with team/org scope; events filtered per scope).

### D.6 Environment variables (`.env.example`)
See `.env.example` (authoritative). Key vars: `DATABASE_URL` (empty → embedded PGlite), `JWT_SECRET`, `ENCRYPTION_KEY`, `FRONTEND_URL`, `CORS_ORIGINS`, `STORAGE_DIR`, `SMTP_*`, `GOOGLE_CLIENT_*`, `WEBAUTHN_*`, `STRIPE_*`, `WORKER_INLINE`.

### D.7 Front-end integration contract
- The Next.js app proxies `/api/v1/*` to this server (Next `rewrites`), so auth cookies are **same-origin** (`SameSite=Lax`). Refresh token cookie `tr_rt` (httpOnly, path `/api/v1/auth`); access token returned in body and kept in memory by the front end, **or** set as httpOnly cookie `tr_at` (decision: **cookie** — simpler with Next server components; CSRF mitigated by SameSite=Lax + `X-Requested-With` header check on mutating requests).
- Socket.IO path `/socket.io` proxied likewise; handshake authenticated by the access cookie.

---

## E. Database Design

Conventions: PK `id uuid` (v7, default generated in app); `organization_id uuid NOT NULL` FK → organizations on every tenant table (omitted below for brevity, marked **[T]**); `created_at timestamptz default now()`, `updated_at timestamptz`; soft delete `deleted_at timestamptz` where marked **[SD]**. Money `numeric(14,2)`, hours `numeric(8,2)`, rates `numeric(12,2)`. Enums as Postgres enums. Extensions: `citext`, `pg_trgm`, `btree_gist`.

### E.1 Identity & tenancy
| Entity | Important fields (type) | Relations / FKs | Indexes & constraints |
|---|---|---|---|
| **users** | email citext, password_hash text null, first_name, last_name varchar(100), avatar_key text, phone, timezone varchar(64), time_format enum(12h,24h), date_format, locale, email_verified_at timestamptz, is_super_admin bool, status enum(active,disabled), mfa_enabled bool, last_login_at | — | `UNIQUE(email)` |
| **oauth_accounts** | provider enum(google), provider_user_id, email | user_id → users | `UNIQUE(provider, provider_user_id)` |
| **user_mfa** | totp_secret_enc bytea, recovery_codes_hash text[], enabled_at | user_id PK/FK | — |
| **webauthn_credentials** | credential_id bytea, public_key bytea, counter bigint, transports text[], name, last_used_at | user_id | `UNIQUE(credential_id)` |
| **auth_tokens** | type enum(email_verify,password_reset,mfa_login), token_hash, expires_at, used_at | user_id | `UNIQUE(token_hash)`, idx(user_id,type) |
| **sessions** | refresh_token_hash, family_id uuid, device_id null, ip inet, user_agent, remember_me bool, expires_at, last_used_at, revoked_at, revoked_reason | user_id, organization_id null | `UNIQUE(refresh_token_hash)`, idx(user_id, revoked_at) |
| **login_history** | method enum(password,google,passkey,agent), success bool, failure_reason, ip, user_agent, geo jsonb | user_id null, email_attempted | idx(user_id, created_at desc) |
| **devices** [T] | kind enum(desktop_agent,browser), os enum(windows,macos,linux,other), os_version, app_version, hostname, machine_id_hash, last_seen_at, last_sync_at, pending_count int, status enum(active,revoked) | member_id → organization_members | `UNIQUE(member_id, machine_id_hash)` |
| **device_tokens** | token_hash, expires_at, revoked_at | device_id | `UNIQUE(token_hash)` |
| **organizations** [SD] | name, slug, logo_key, brand_color, industry, size, timezone, default_currency char(3), date_format, time_format, week_start smallint, country, address jsonb, status enum(active,suspended), owner_user_id | owner → users | `UNIQUE(slug)` |
| **organization_settings** | org_id PK; working_days smallint[], work_start time, work_end time, activity_low_max smallint default 30, activity_moderate_max smallint default 60, require_manual_time_approval bool, allow_employee_edit_time bool, overtime_mode enum(daily,weekly,both,none), overtime_multiplier numeric(4,2) default 1.5, timesheet_period enum(week,biweek,month), timesheet_approval_levels smallint, timesheet_lock_after_days smallint, attendance_auto_checkin bool, late_grace_minutes smallint, early_leave_grace_minutes smallint, enforce_2fa bool, session_idle_timeout_minutes int, leaderboard_visible_to_employees bool, productivity_weights jsonb, default_billable_rate numeric | organization_id | — |
| **organization_members** [T][SD] | user_id, role_id, status enum(invited,active,inactive,suspended), employee_code varchar(32), designation, department_id, employment_type enum(full_time,part_time,contract), joined_on date, work_schedule_id null, weekly_hours numeric(5,2), weekly_limit_hours numeric(5,2) null, work_mode enum(office,remote,hybrid), timezone override, client_id null (for client users), restrictions jsonb, deactivated_at | user → users, role → roles, department → departments, client → clients | `UNIQUE(organization_id, user_id)`, `UNIQUE(organization_id, employee_code)`, idx(organization_id, status), trigram idx on search fields via users |
| **member_rates** [T] | member_id, rate_type enum(pay,cost,billable), amount numeric(12,2), currency char(3), pay_type enum(hourly,monthly_salary), effective_from date, effective_to date null | member_id | idx(member_id, rate_type, effective_from desc); EXCLUDE overlapping ranges per (member, rate_type) |
| **member_managers** [T] | member_id, manager_member_id | both → organization_members | `PK(member_id, manager_member_id)`; CHECK member ≠ manager |
| **invitations** [T] | email citext, role_id, team_id null, project_ids uuid[], token_hash, status enum(pending,accepted,rejected,expired,revoked), invited_by, expires_at, accepted_user_id | role, inviter | `UNIQUE(token_hash)`, partial `UNIQUE(organization_id, email) WHERE status='pending'` |
| **invitation_links** [T] | token_hash, role_id, max_uses int null, uses int, expires_at, revoked_at, created_by | role | `UNIQUE(token_hash)` |
| **consents** [T] | member_id, policy_version int, accepted_at, ip, features jsonb | member | `UNIQUE(member_id, policy_version)` |

### E.2 RBAC
| Entity | Fields | Relations | Indexes |
|---|---|---|---|
| **permissions** (global) | key varchar(80), module, description | — | `UNIQUE(key)` |
| **roles** [T] | name, slug, description, is_system bool, base_role enum(owner,admin,manager,team_leader,employee,client), level smallint, version int | — | `UNIQUE(organization_id, slug)` |
| **role_permissions** | role_id, permission_id, scope enum(own,team,project,org) | role, permission | `PK(role_id, permission_id)` |
| **member_scopes** [T] | member_id, scope_type enum(team,project,department), scope_id | member | `UNIQUE(member_id, scope_type, scope_id)` |

### E.3 Organization structure
| Entity | Fields | Relations | Indexes |
|---|---|---|---|
| **departments** [T][SD] | name, description, head_member_id, parent_id | self, member | `UNIQUE(organization_id, name) WHERE deleted_at IS NULL` |
| **teams** [T][SD] | name, description, department_id, work_schedule_id, color | department, schedule | `UNIQUE(organization_id, name) WHERE deleted_at IS NULL` |
| **team_members** | team_id, member_id, is_leader bool, joined_at | team, member | `PK(team_id, member_id)`, idx(member_id) |
| **team_managers** | team_id, member_id | team, member | `PK(team_id, member_id)` |

### E.4 Clients, projects, tasks
| Entity | Fields | Relations | Indexes |
|---|---|---|---|
| **clients** [T][SD] | name, email, phone, company, address jsonb, currency char(3), hourly_rate numeric, portal_permissions jsonb (show_screenshots, show_activity, show_member_names, show_rates), status | — | `UNIQUE(organization_id, name) WHERE deleted_at IS NULL` |
| **projects** [T][SD] | name, code, description, client_id, status enum, priority enum, start_date, deadline, budget_type enum(none,hours,amount), budget_value numeric, budget_alert_percent smallint[], currency, hourly_rate numeric, is_billable_default bool, progress_mode enum(auto,manual), progress_manual smallint, client_visible bool, archived_at, color | client | `UNIQUE(organization_id, name) WHERE deleted_at IS NULL`, idx(organization_id, status), trigram(name) |
| **project_members** | project_id, member_id, role enum(manager,member,viewer), billable_rate numeric null | project, member | `PK(project_id, member_id)`, idx(member_id) |
| **project_teams** | project_id, team_id | project, team | `PK(project_id, team_id)` |
| **project_notes** [T] | project_id, author_member_id, body text, is_pinned | project | idx(project_id) |
| **board_columns** [T] | project_id, name, category enum(todo,in_progress,in_review,done), position numeric, color, wip_limit int null | project | idx(project_id, position) |
| **task_categories** [T] | name, color | — | `UNIQUE(organization_id, name)` |
| **labels** [T] | name, color, project_id null | — | `UNIQUE(organization_id, project_id, name)` |
| **tasks** [T][SD] | project_id, parent_task_id null, column_id, title, description, priority enum, category_id, start_date, due_date, estimated_hours numeric, progress smallint, position numeric, reviewer_member_id, completed_at, approved_by, approved_at, approval_status enum(none,pending,approved,changes_requested), created_by, external_ref jsonb | project, parent task, column, category | idx(project_id, column_id, position), idx(organization_id, due_date) WHERE completed_at IS NULL, trigram(title) |
| **task_assignees** | task_id, member_id | task, member | `PK(task_id, member_id)`, idx(member_id) |
| **task_labels** | task_id, label_id | — | `PK` |
| **task_dependencies** | task_id, depends_on_task_id, type enum(blocks) | tasks | `PK(task_id, depends_on_task_id)`; CHECK ≠; cycle check in service |
| **comments** [T][SD] | entity_type enum(project,task,timesheet,invoice), entity_id, author_member_id, body, visibility enum(internal,client), mentions uuid[] | author | idx(entity_type, entity_id, created_at) |
| **attachments** [T][SD] | entity_type enum(project,task,comment), entity_id, file_key, file_name, mime, size_bytes bigint, uploaded_by | — | idx(entity_type, entity_id) |
| **activity_log** [T] | entity_type, entity_id, actor_member_id, action varchar(60), changes jsonb | — | idx(organization_id, created_at desc), idx(entity_type, entity_id) |

### E.5 Time, activity, monitoring
| Entity | Fields | Relations | Indexes / constraints |
|---|---|---|---|
| **time_entries** [T][SD] | member_id, project_id null, task_id null, client_id null, device_id null, client_uuid uuid null, started_at, ended_at null, duration_seconds int, paused_seconds int, idle_seconds int, idle_discarded_seconds int, active_seconds int, entry_type enum(work,meeting), source enum(web_timer,desktop,manual,import,integration), is_offline bool, is_billable bool, note text, status enum(running,paused,pending,approved,rejected), approval_reason, approved_by, approved_at, timesheet_id null, invoice_id null, edit_reason | member, project, task, client, device, timesheet, invoice | partial `UNIQUE(member_id) WHERE ended_at IS NULL AND deleted_at IS NULL` (one running timer); `UNIQUE(device_id, client_uuid)`; `EXCLUDE USING gist (member_id WITH =, tstzrange(started_at, coalesce(ended_at,'infinity')) WITH &&) WHERE (deleted_at IS NULL)`; idx(organization_id, started_at), idx(member_id, started_at), idx(project_id, started_at), idx(task_id) |
| **time_entry_pauses** | time_entry_id, started_at, ended_at, reason enum(manual,idle,break) | entry | idx(time_entry_id) |
| **time_entry_history** [T] | time_entry_id, changed_by, action enum(create,update,delete,approve,reject), before jsonb, after jsonb, reason | entry | idx(time_entry_id) |
| **idle_periods** [T] | member_id, time_entry_id, device_id, client_uuid, started_at, ended_at, resolution enum(pending,kept,discarded,reassigned), resolved_at, reassigned_note | member, entry | `UNIQUE(device_id, client_uuid)`, idx(member_id, started_at) |
| **idle_adjustment_requests** [T] | idle_period_id, member_id, requested_action enum(keep,discard), reason, status enum(pending,approved,rejected), reviewed_by, reviewed_at, review_note | idle period | idx(organization_id, status) |
| **break_types** [T] | name, is_paid bool, max_minutes int null, color, is_system bool | — | `UNIQUE(organization_id, name)` |
| **breaks** [T] | member_id, break_type_id, time_entry_id null, started_at, ended_at, duration_seconds, exceeded bool, client_uuid, device_id | member, type | idx(member_id, started_at) |
| **activity_samples** [T] (partitioned monthly by `interval_start`) | member_id, time_entry_id, device_id, client_uuid, interval_start, interval_seconds smallint, keyboard_active_seconds smallint, mouse_active_seconds smallint, active_seconds smallint, activity_percent smallint, project_id, task_id | member, entry | `UNIQUE(device_id, client_uuid, interval_start)`, idx(member_id, interval_start). **No key content columns.** |
| **screenshots** [T] (partitioned monthly) | member_id, time_entry_id, project_id, task_id, device_id, client_uuid, capture_group_id, monitor_index smallint, captured_at, received_at, object_key, thumb_key, blurred_key, is_blurred bool, width, height, size_bytes, activity_percent smallint, app_name, window_title null, deleted_by, deleted_at | member, entry, project, task | `UNIQUE(device_id, client_uuid)`, idx(member_id, captured_at desc), idx(organization_id, captured_at desc) |
| **applications** (global catalog) | identifier (exe/bundle), display_name, icon_key, default_category | — | `UNIQUE(identifier)` |
| **app_usage** [T] (partitioned) | member_id, time_entry_id, device_id, client_uuid, app_identifier, app_name, window_title null, started_at, ended_at, duration_seconds | member | `UNIQUE(device_id, client_uuid)`, idx(member_id, started_at) |
| **web_usage** [T] (partitioned) | member_id, time_entry_id, device_id, client_uuid, browser enum(chrome,firefox,edge,safari,other), domain, url null, title null, started_at, ended_at, duration_seconds, is_excluded bool | member | same as above + idx(organization_id, domain) |
| **productivity_rules** [T] | scope_type enum(org,team,member), scope_id null, target_type enum(app,website), pattern varchar(255), match_type enum(exact,domain,wildcard), category enum(productive,unproductive,neutral) | — | `UNIQUE(organization_id, scope_type, scope_id, target_type, pattern)` |
| **sensitive_exclusions** [T] | domain_pattern, reason | — | `UNIQUE(organization_id, domain_pattern)` |
| **tracking_settings** [T] | scope_type enum(org,team,project,member), scope_id null, screenshots_enabled bool, screenshot_interval_minutes smallint CHECK in (3,5,10,15), screenshot_random bool, screenshot_blur bool, screenshot_retention_days int, allow_employee_screenshot_delete bool, capture_window_titles bool, notify_on_capture bool, activity_tracking_enabled bool, app_tracking_enabled bool, website_tracking_enabled bool, track_full_url bool, idle_threshold_minutes smallint, auto_pause_minutes smallint, weekly_limit_hours numeric, limit_mode enum(warn,block), version int | — | `UNIQUE(organization_id, scope_type, scope_id)`; all fields nullable except at org scope (inheritance) |
| **daily_summaries** [T] | member_id, date (member-local), project_id null (null = all), tracked_seconds, active_seconds, idle_seconds, break_seconds, paid_break_seconds, meeting_seconds, productive_seconds, unproductive_seconds, neutral_seconds, billable_seconds, overtime_seconds, activity_percent, screenshot_count | member, project | `UNIQUE(member_id, date, project_id)` (NULLS NOT DISTINCT), idx(organization_id, date) |

### E.6 Attendance & schedules
| Entity | Fields | Relations | Indexes |
|---|---|---|---|
| **work_schedules** [T] | name, schedule_type enum(fixed,flexible), working_days smallint[], start_time time, end_time time, required_hours_per_day numeric, work_mode enum, timezone null, is_default bool | — | partial `UNIQUE(organization_id) WHERE is_default` |
| **shifts** [T] | name, start_time, end_time, crosses_midnight bool, break_minutes, color | — | `UNIQUE(organization_id, name)` |
| **shift_assignments** [T] | member_id, shift_id, start_date, end_date null, weekdays smallint[] | member, shift | idx(member_id, start_date) |
| **holidays** [T] | name, date, recurring_yearly bool, applies_to enum(org,team,department), scope_id null, is_paid bool | — | idx(organization_id, date) |
| **attendance_records** [T] | member_id, date, status enum(present,late,absent,half_day,holiday,weekend,leave), check_in_at, check_out_at, check_in_source enum(manual,timer,agent,correction), late_minutes, early_leave_minutes, worked_seconds, overtime_seconds, work_mode, shift_id | member, shift | `UNIQUE(member_id, date)`, idx(organization_id, date, status) |
| **attendance_corrections** [T] | attendance_record_id null, member_id, date, requested_check_in, requested_check_out, reason, status enum(pending,approved,rejected), reviewed_by, reviewed_at, review_note | record, member | idx(organization_id, status) |

### E.7 Timesheets
| Entity | Fields | Relations | Indexes |
|---|---|---|---|
| **timesheets** [T] | member_id, period_type enum(day,week,biweek,month), period_start date, period_end date, status enum(draft,submitted,approved,rejected), current_level smallint, revision int, total_seconds, billable_seconds, overtime_seconds, submitted_at, approved_at, locked_at, locked_by | member | `UNIQUE(member_id, period_start, period_type)`, idx(organization_id, status) |
| **timesheet_approvals** | timesheet_id, level smallint, approver_member_id, decision enum(approved,rejected), comment, decided_at | timesheet | idx(timesheet_id) |
| **timesheet_events** [T] | timesheet_id, actor_member_id, from_status, to_status, comment | timesheet | idx(timesheet_id, created_at) |

### E.8 Reports & performance
| Entity | Fields | Relations | Indexes |
|---|---|---|---|
| **saved_reports** [T] | name, report_type, definition jsonb, owner_member_id, is_shared_in_org bool | owner | idx(organization_id) |
| **report_schedules** [T] | saved_report_id, cron, timezone, format enum(pdf,csv,xlsx), recipients text[], last_run_at, next_run_at, active bool | saved report | idx(next_run_at) WHERE active |
| **report_shares** [T] | saved_report_id null, definition_snapshot jsonb, token_hash, password_hash null, client_id null, expires_at, revoked_at, view_count | saved report, client | `UNIQUE(token_hash)` |
| **export_jobs** [T] | type, params jsonb, status enum(queued,running,done,failed), file_key, error, requested_by, expires_at | — | idx(requested_by) |
| **performance_goals** [T] | scope_type enum(member,team), scope_id, metric varchar(50), target numeric, comparator enum(gte,lte), period enum(day,week,month), active bool | — | idx(scope_type, scope_id) |
| **custom_metrics** [T] | name, formula jsonb (whitelisted metrics × weights), unit | — | `UNIQUE(organization_id, name)` |
| **performance_snapshots** [T] | member_id, period_start, period_type, metrics jsonb, productivity_score numeric(5,2), rank int | member | `UNIQUE(member_id, period_type, period_start)` |

### E.9 Billing & payroll
| Entity | Fields | Relations | Indexes |
|---|---|---|---|
| **exchange_rates** (global) | base char(3), quote char(3), rate numeric(18,8), date | — | `UNIQUE(base, quote, date)` |
| **invoices** [T][SD] | client_id, number varchar(30), status enum, issue_date, due_date, currency, subtotal, tax_percent numeric(5,2), tax_amount, discount_amount, total, amount_paid, notes, period_from, period_to, sent_at, pdf_key | client | `UNIQUE(organization_id, number)`, idx(client_id, status) |
| **invoice_items** | invoice_id, project_id, task_id null, member_id null, description, hours numeric, rate numeric, amount numeric | invoice, project | idx(invoice_id) |
| **invoice_payments** [T] | invoice_id, amount, paid_at, method, reference | invoice | idx(invoice_id) |
| **payroll_runs** [T] | period_start, period_end, status enum(draft,finalized,paid,exported), currency, total_amount, finalized_by, finalized_at | — | `UNIQUE(organization_id, period_start, period_end)` |
| **payroll_items** | payroll_run_id, member_id, regular_seconds, overtime_seconds, paid_break_seconds, rate, overtime_rate, regular_amount, overtime_amount, adjustments numeric, total, currency | run, member | `UNIQUE(payroll_run_id, member_id)` |

### E.10 Notifications, integrations, security, subscription
| Entity | Fields | Relations | Indexes |
|---|---|---|---|
| **notifications** [T] | recipient_user_id, type varchar(60), title, body, data jsonb, link, read_at, channels_sent text[] | user | idx(recipient_user_id, read_at, created_at desc) |
| **notification_preferences** | user_id, organization_id null (null = org default row when user null), event_type, in_app bool, email bool, desktop bool | user | `UNIQUE(user_id, organization_id, event_type)` |
| **system_alerts** [T] | type, severity enum(info,warning,critical), message, data jsonb, resolved_at | — | idx(organization_id, resolved_at) |
| **api_keys** [T] | name, prefix varchar(12), key_hash, scopes text[], expires_at, last_used_at, revoked_at, created_by | creator | `UNIQUE(key_hash)` |
| **webhooks** [T] | url, events text[], secret_enc, active bool, description, failure_count | — | idx(organization_id) |
| **webhook_deliveries** | webhook_id, event, payload jsonb, status enum(pending,success,failed), attempts, response_code, next_attempt_at | webhook | idx(status, next_attempt_at) |
| **integrations** [T] | provider enum(slack,ms_teams,jira,trello,asana,clickup,github,gitlab,google_calendar,outlook_calendar,quickbooks,xero,payroll_csv), status enum(connected,error,disconnected), access_token_enc, refresh_token_enc, expires_at, settings jsonb, connected_by, last_sync_at | — | `UNIQUE(organization_id, provider)` |
| **integration_links** [T] | integration_id, external_type, external_id, internal_type, internal_id | integration | `UNIQUE(integration_id, external_type, external_id)` |
| **sync_batches** [T] | device_id, member_id, received_at, item_counts jsonb, results jsonb, checksum | device | idx(device_id, received_at) |
| **sync_conflicts** [T] | device_id, member_id, entity_type, payload jsonb, conflicting_entity_id, status enum(open,resolved), resolution | device | idx(organization_id, status) |
| **app_releases** (global) | os, channel, version, url, sha256, min_supported bool, release_notes, published_at | — | `UNIQUE(os, channel, version)` |
| **audit_logs** [T] | actor_user_id, actor_type enum(user,api_key,system,super_admin), action, entity_type, entity_id, before jsonb, after jsonb, ip, user_agent | — | idx(organization_id, created_at desc), idx(entity_type, entity_id) |
| **security_events** | organization_id null, user_id null, type, severity, data jsonb | — | idx(created_at desc) |
| **data_requests** [T] | member_id, type enum(export,deletion), status enum(pending,approved,processing,completed,rejected), requested_at, due_at, processed_by, file_key, notes | member | idx(organization_id, status) |
| **import_jobs** [T] | type enum(members), file_key, status, rows_total, rows_valid, errors jsonb, created_by | — | — |
| **plans** (global) | code enum(free,starter,professional,enterprise), name, price_month numeric, price_year numeric, currency, per_seat bool, stripe_price_month_id, stripe_price_year_id, limits jsonb (max_seats, storage_gb, screenshot_retention_days, min_screenshot_interval), features jsonb (integrations, client_portal, payroll, api, custom_roles, scheduled_reports, sso…), is_public bool | — | `UNIQUE(code)` |
| **subscriptions** [T] | plan_id, status enum(trialing,active,past_due,canceled,expired), billing_interval enum(month,year), seats int, trial_ends_at, current_period_start, current_period_end, cancel_at_period_end bool, stripe_customer_id, stripe_subscription_id, pending_plan_id | plan | `UNIQUE(organization_id)` |
| **subscription_invoices** [T] | stripe_invoice_id, number, amount, currency, status, hosted_url, pdf_url, period_start, period_end | subscription | `UNIQUE(stripe_invoice_id)` |
| **subscription_payments** [T] | stripe_payment_intent_id, amount, currency, status, paid_at, failure_reason | subscription | `UNIQUE(stripe_payment_intent_id)` |
| **usage_counters** [T] | metric enum(seats,storage_bytes,screenshots), value bigint, updated_at | — | `UNIQUE(organization_id, metric)` |
| **processed_webhook_events** | provider, event_id | — | `UNIQUE(provider, event_id)` (idempotency) |

### E.11 Relationship summary (ER overview)
```
users 1─* organization_members *─1 organizations
organization_members *─1 roles *─* permissions (role_permissions)
organizations 1─* departments 1─* teams *─* organization_members (team_members)
organizations 1─* clients 1─* projects 1─* tasks (self parent) ; projects *─* members/teams
projects 1─* board_columns 1─* tasks
organization_members 1─* time_entries *─1 projects/tasks/clients ; time_entries 1─* pauses/idle_periods/activity_samples/screenshots/app_usage/web_usage
organization_members 1─* attendance_records ; work_schedules/shifts → members
organization_members 1─* timesheets 1─* time_entries
clients 1─* invoices 1─* invoice_items ; time_entries *─1 invoices
payroll_runs 1─* payroll_items *─1 organization_members
organizations 1─1 subscriptions *─1 plans
```

---

## F. API Documentation Plan

**Legend:** Auth — `P` public, `U` authenticated user (no org needed), `O` authenticated with active org, `A` agent device token, `K` API key, `S` super admin. Permission column uses keys from §M02 (scope enforced in service). Request/response bodies are the Zod schemas in each module's `*.schemas.js`; below lists the key fields. All list endpoints accept pagination/sort/search.

### F.1 Auth & account (`/auth`, `/me`)
| Method | Endpoint | Purpose | Params / Body | Response | Auth | Permission |
|---|---|---|---|---|---|---|
| POST | /auth/register | Register user + organization | {firstName,lastName,email,password,organizationName,timezone} | {user, organization} + cookies | P | — |
| POST | /auth/login | Email/password login | {email,password,rememberMe} | {user, organizations[]} or {mfaRequired,mfaToken} | P | — |
| POST | /auth/2fa/verify | Complete MFA login | {mfaToken, code \| recoveryCode} | {user} + cookies | P | — |
| POST | /auth/refresh | Rotate tokens | cookie | {ok} | P(cookie) | — |
| POST | /auth/logout | Revoke current session | — | 204 | U | — |
| GET | /auth/google | Start OAuth | ?redirect | 302 | P | — |
| GET | /auth/google/callback | OAuth callback | code,state | 302 to FE | P | — |
| POST | /auth/forgot-password | Send reset email | {email} | 200 always | P | — |
| POST | /auth/reset-password | Reset with token | {token,password} | 204 | P | — |
| POST | /auth/verify-email | Verify email | {token} | 204 | P | — |
| POST | /auth/resend-verification | Resend | — | 204 | U | — |
| POST | /auth/passkeys/register/options · /verify | Register passkey | WebAuthn JSON | credential | U | — |
| POST | /auth/passkeys/login/options · /verify | Passkey login | WebAuthn JSON | {user}+cookies | P | — |
| POST | /auth/switch-organization | Set active org | {organizationId} | {member, permissions} | U | member of org |
| GET | /me | Current user + active member + permissions + effective features | — | {user, member, organization, permissions, features} | U | — |
| PATCH | /me | Update profile | {firstName,…,timezone,timeFormat} | user | U | — |
| POST | /me/avatar/upload-url | Presigned avatar upload | {contentType,size} | {url, key} | U | — |
| POST | /me/change-password | Change password | {currentPassword,newPassword} | 204 | U | — |
| POST | /me/2fa/setup · /enable · /disable · /recovery-codes | Manage 2FA | {code} | {otpauthUrl,qr} / {recoveryCodes} | U | — |
| GET | /me/passkeys · DELETE /me/passkeys/:id | Manage passkeys | — | list | U | — |
| GET | /me/sessions · DELETE /me/sessions/:id · POST /me/sessions/revoke-others | Sessions | — | list | U | — |
| GET | /me/login-history | Login history | page | list | U | — |
| GET | /me/devices · DELETE /me/devices/:id | Devices | — | list | U | — |
| GET | /me/organizations | Orgs for switcher | — | list | U | — |
| GET | /me/monitoring-status | What is tracked for me | — | effective settings + consent status | O | — |
| POST | /me/consent | Accept tracking policy | {policyVersion} | consent | O | — |
| GET | /me/data | Own data access | ?from&to&type | data | O | — |
| GET/PUT | /me/notification-preferences | Preferences | [{eventType,inApp,email,desktop}] | list | O | — |

### F.2 Organization, invitations, members
| Method | Endpoint | Purpose | Body / Params | Auth | Permission |
|---|---|---|---|---|---|
| GET/PATCH | /organization | Org profile & settings | name, timezone, currency, dateFormat, timeFormat, workingDays, workingHours… | O | organization.view / organization.update |
| POST | /organization/logo/upload-url | Logo upload | {contentType,size} | O | organization.update |
| GET/PATCH | /organization/settings | Org policy settings (overtime, approvals, grace…) | — | O | organization.update |
| DELETE | /organization | Delete org (owner, with confirmation) | {confirmName,password} | O | owner only |
| POST | /organization/transfer-ownership | Transfer | {memberId} | O | owner only |
| GET/POST | /invitations | List / create | {email, roleId, teamId?, projectIds?} | O | members.invite |
| POST | /invitations/bulk | Bulk invite | {emails[], roleId, teamId?} | O | members.invite |
| POST | /invitations/:id/resend · DELETE /invitations/:id | Resend / revoke | — | O | members.invite |
| GET/POST | /invitations/links · DELETE /invitations/links/:id | Invite links | {roleId,maxUses,expiresAt} | O | members.invite |
| GET | /invitations/token/:token | Preview invite | — | P | — |
| POST | /invitations/token/:token/accept · /reject | Accept/reject | {firstName,lastName,password}? | P/U | — |
| GET | /members | List/search | ?search&status&departmentId&teamId&managerId&employmentType&roleId | O | members.view |
| POST | /members | Add employee | {email, firstName, lastName, roleId, employeeCode?, designation, departmentId, teamIds, managerIds, employmentType, joinedOn, workScheduleId, weeklyHours, hourlyRate?} | O | members.create |
| GET/PATCH | /members/:id | Profile / edit | as above | O | members.view / members.update |
| PATCH | /members/:id/role | Role assignment | {roleId} | O | roles.manage |
| PUT | /members/:id/managers | Set managers | {managerIds[]} | O | members.update |
| GET/POST | /members/:id/rates | Rate history / add rate | {rateType, amount, currency, payType, effectiveFrom} | O | payroll.manage |
| POST | /members/:id/deactivate · /reactivate · /suspend | Status | {reason} | O | members.deactivate |
| GET | /members/:id/activity · /work-history · /devices · /performance · /attendance | Member tabs | ?from&to | O | scoped view perms |
| POST | /members/import | Upload CSV/XLSX → validation preview | multipart | O | members.import |
| GET | /members/import/:jobId · POST /members/import/:jobId/commit | Preview / commit | — | O | members.import |
| GET | /members/import/template | Download template | ?format=csv\|xlsx | O | members.import |

### F.3 Roles, departments, teams
| Method | Endpoint | Purpose | Auth | Permission |
|---|---|---|---|---|
| GET | /permissions | Permission catalog (grouped by module) | O | roles.manage |
| GET/POST | /roles | List / create custom role {name, description, cloneFromRoleId} | O | roles.manage |
| GET/PATCH/DELETE | /roles/:id | Detail / rename / delete (non-system, no members) | O | roles.manage |
| PUT | /roles/:id/permissions | Set grants [{permissionKey, scope}] | O | roles.manage |
| GET/POST | /departments · PATCH/DELETE /departments/:id | Departments CRUD | O | departments.manage (view: teams.view) |
| GET/POST | /teams · GET/PATCH/DELETE /teams/:id | Teams CRUD | O | teams.manage / teams.view |
| POST | /teams/:id/members · DELETE /teams/:id/members/:memberId | Add/remove members {memberIds[]} | O | teams.manage |
| PATCH | /teams/:id/members/:memberId | {isLeader} | O | teams.manage |
| PUT | /teams/:id/managers | {memberIds[]} | O | teams.manage |
| PUT | /teams/:id/projects | Team-wise project assignment {projectIds[]} | O | projects.update |
| GET | /teams/:id/stats?from&to | Hours, productivity, activity | O | teams.view |

### F.4 Time tracking
| Method | Endpoint | Purpose | Body / Params | Auth | Permission |
|---|---|---|---|---|---|
| GET | /timer/current | Running/paused timer | — | O | timer.use |
| POST | /timer/start | Start | {projectId?, taskId?, note?, entryType} | O/A | timer.use + consent |
| POST | /timer/pause · /resume · /stop | Control | {note?} | O/A | timer.use |
| POST | /timer/switch | Stop current & start new task atomically | {projectId, taskId} | O/A | timer.use |
| GET | /time-entries | List/history | ?memberId&projectId&taskId&clientId&status&source&from&to | O | time.view |
| POST | /time-entries | Manual entry | {memberId?, projectId, taskId?, startedAt, endedAt, note, isBillable, entryType} | O | time.create (own) / time.manual |
| GET/PATCH/DELETE | /time-entries/:id | Detail / edit / delete | {startedAt, endedAt, projectId, taskId, note, isBillable, editReason} | O | time.update / time.delete |
| GET | /time-entries/:id/history | Edit history | — | O | time.view |
| POST | /time-entries/:id/approve · /reject | Approval | {reason?} | O | time.approve |
| POST | /time-entries/bulk-approve · /bulk-reject | Bulk | {ids[], reason?} | O | time.approve |
| GET | /time/summary | Daily/weekly/monthly totals | ?memberId&period=day\|week\|month&date | O | time.view |
| GET | /time/calendar | Entries for calendar UI | ?memberId&from&to | O | time.view |
| GET | /idle-periods | Pending idle periods | ?status=pending | O | timer.use |
| POST | /idle-periods/:id/resolve | Keep / discard / reassign | {action, projectId?, taskId?, note?} | O/A | timer.use |

### F.5 Breaks & idle adjustments
| Method | Endpoint | Purpose | Auth | Permission |
|---|---|---|---|---|
| GET/POST | /break-types · PATCH/DELETE /break-types/:id | Break types CRUD {name,isPaid,maxMinutes,color} | O | breaks.manage (list: breaks.use) |
| POST | /breaks/start {breakTypeId} · /breaks/end {resumeTimer} | Break control | O/A | breaks.use |
| GET | /breaks?memberId&from&to | Break history | O | time.view |
| GET/POST | /idle-adjustments | List / request {idlePeriodId, requestedAction, reason} | O | timer.use / idle.approve |
| POST | /idle-adjustments/:id/approve · /reject | Manager decision {note} | O | idle.approve |

### F.6 Screenshots, activity, apps & websites
| Method | Endpoint | Purpose | Auth | Permission |
|---|---|---|---|---|
| GET | /screenshots?memberId&teamId&projectId&taskId&from&to&activityLevel | Gallery | O | screenshots.view |
| GET | /screenshots/timeline?memberId&date | Timeline slots | O | screenshots.view |
| GET | /screenshots/latest?limit | Latest (dashboard) | O | screenshots.view |
| GET | /screenshots/:id | Detail + signed URLs (blurred if viewer not allowed original) | O | screenshots.view |
| GET | /screenshots/:id/download | Signed download | O | screenshots.download |
| DELETE | /screenshots/:id | Delete {deleteTime?} | O | screenshots.delete / own if allowed |
| POST | /screenshots/export | ZIP export {filters} → job | O | screenshots.export |
| GET | /screenshots/storage | Storage usage | O | settings.tracking |
| GET | /activity/timeline?memberId&date | 10-min buckets | O | activity.view |
| GET | /activity/summary?memberId&teamId&projectId&from&to&granularity | Active vs idle, levels | O | activity.view |
| GET | /apps/usage?memberId&teamId&from&to&groupBy=app\|category | App usage | O | apps.view |
| GET | /apps/timeline?memberId&date · /websites/timeline | Timelines | O | apps.view |
| GET | /websites/usage | Website usage | O | apps.view |
| GET/POST | /productivity-rules · PATCH/DELETE /productivity-rules/:id | Categorization {scopeType,scopeId,targetType,pattern,matchType,category} | O | apps.categorize |
| GET | /applications/discovered | Apps/domains seen in org without rule (to categorize) | O | apps.categorize |
| GET/POST/DELETE | /sensitive-exclusions | Sensitive website exclusions | O | settings.privacy |

### F.7 Projects, tasks, board, clients
| Method | Endpoint | Purpose | Auth | Permission |
|---|---|---|---|---|
| GET/POST | /clients · GET/PATCH/DELETE /clients/:id | Clients CRUD (+ hourlyRate, currency, portalPermissions) | O | clients.view / clients.manage |
| POST | /clients/:id/invite | Invite client user {email} | O | clients.manage |
| GET/POST | /projects | List (?status&clientId&teamId&memberId&archived&priority) / create | O | projects.view / projects.create |
| GET/PATCH/DELETE | /projects/:id | Detail/edit/delete | O | projects.view/update/delete |
| POST | /projects/:id/archive · /unarchive | Archive | O | projects.archive |
| PUT | /projects/:id/members | [{memberId, role, billableRate?}] | O | projects.update |
| PUT | /projects/:id/teams | {teamIds[]} | O | projects.update |
| GET | /projects/:id/stats | Hours, cost, budget used, progress, per-member | O | projects.view |
| GET | /projects/:id/activity | Activity history | O | projects.view |
| GET/POST | /projects/:id/notes · PATCH/DELETE /projects/:id/notes/:noteId | Notes | O | projects.view / projects.update |
| GET/POST | /comments?entityType&entityId · PATCH/DELETE /comments/:id | Comments (projects, tasks, timesheets) | O/client | entity view |
| POST | /attachments/upload-url · POST /attachments · DELETE /attachments/:id · GET /attachments/:id/download | Attachments | O | entity update |
| GET/POST | /projects/:id/columns · PATCH/DELETE /columns/:id · POST /projects/:id/columns/reorder | Kanban columns | O | board.manage_columns |
| GET | /projects/:id/board?assigneeId&priority&labelId&search | Board | O | tasks.view |
| GET | /board?projectIds&assigneeId&priority&search | Cross-project board | O | tasks.view |
| GET/POST | /tasks | List view / create (quick create) | O | tasks.view / tasks.create |
| GET | /tasks/calendar?from&to&projectId&assigneeId | Calendar view | O | tasks.view |
| GET/PATCH/DELETE | /tasks/:id | Detail modal / edit / delete | O | tasks.view/update/delete |
| PATCH | /tasks/:id/move | {columnId, beforeId?, afterId?} | O | tasks.update (or own assignee) |
| PUT | /tasks/:id/assignees · /labels | Assign {memberIds[]} / labels | O | tasks.assign |
| GET/POST/DELETE | /tasks/:id/dependencies | Dependencies | O | tasks.update |
| GET/POST | /tasks/:id/subtasks | Subtasks | O | tasks.create |
| POST | /tasks/:id/submit-review · /approve · /request-changes | Review & approval | O | tasks.update / tasks.approve |
| GET | /tasks/:id/activity · /tasks/:id/time | History, time entries | O | tasks.view |
| GET/POST/PATCH/DELETE | /labels · /task-categories | Taxonomies | O | tasks.update |

### F.8 Attendance & schedules
| Method | Endpoint | Purpose | Auth | Permission |
|---|---|---|---|---|
| POST | /attendance/check-in · /check-out | Self check-in/out {workMode?} | O/A | timer.use |
| GET | /attendance?date \| from&to&memberId&teamId&status | Daily/weekly/monthly | O | attendance.view |
| GET | /attendance/today | Summary present/late/absent | O | attendance.view |
| PATCH | /attendance/:id | Admin edit | O | attendance.manage |
| GET/POST | /attendance/corrections | List / request {date, requestedCheckIn, requestedCheckOut, reason} | O | own / attendance.approve |
| POST | /attendance/corrections/:id/approve · /reject | Decide | O | attendance.approve |
| GET/POST/PATCH/DELETE | /work-schedules | Schedules (working days, hours, flexible, remote) | O | schedules.manage |
| GET/POST/PATCH/DELETE | /shifts | Shifts | O | schedules.manage |
| GET/POST/DELETE | /shift-assignments | Assign {memberIds, shiftId, startDate, endDate, weekdays} | O | schedules.manage |
| GET/POST/PATCH/DELETE | /holidays | Holidays | O | holidays.manage |

### F.9 Timesheets
| Method | Endpoint | Purpose | Auth | Permission |
|---|---|---|---|---|
| GET | /timesheets?memberId&teamId&status&from&to | Timesheet list | O | timesheets.view |
| GET | /timesheets/view?period&date&memberId\|teamId\|projectId\|taskId | Grid view (rows × days) | O | timesheets.view |
| GET | /timesheets/:id | Detail with entries, approvals, events | O | timesheets.view |
| POST | /timesheets/:id/submit | Submit | O | timesheets.submit (own) |
| POST | /timesheets/:id/approve · /reject {comment} | Workflow | O | timesheets.approve |
| POST | /timesheets/bulk-approve | {ids[]} | O | timesheets.approve |
| POST | /timesheets/:id/unlock · /lock | Locking | O | timesheets.lock |
| GET | /timesheets/:id/export?format=pdf\|xlsx\|csv | Export | O | timesheets.export |
| GET | /timesheets/:id/history | Events | O | timesheets.view |

### F.10 Dashboard, live, approvals, reports, performance
| Method | Endpoint | Purpose | Auth | Permission |
|---|---|---|---|---|
| GET | /dashboard/stats?from&to&teamId&projectId&memberId | 14 KPI tiles (RPT-D01…D14) | O | reports.view (employee: own) |
| GET | /dashboard/overview | Org/employee/team/project/task overview | O | reports.view |
| GET | /dashboard/charts/:chart?from&to… | hours-distribution, active-vs-idle, productivity-trend, app-pie, attendance | O | reports.view |
| GET | /live/members | Live status list | O | activity.view |
| GET | /approvals/pending?type=manual_time\|timesheet\|attendance\|idle\|task | Pending approvals | O | any *.approve |
| GET | /action-center | Approvals + alerts + conflicts | O | scoped |
| GET | /activity-log?entityType&limit | Recent activities | O | scoped |
| GET | /system-alerts · POST /system-alerts/:id/resolve | System alerts | O | organization.update |
| GET | /reports/:type?from&to&groupBy&filters | Time, activity, apps, websites, screenshots, attendance, breaks, projects, tasks, payroll, billing | O | reports.view (+ type perms) |
| GET | /reports/activity/compare · /reports/teams/compare · /reports/projects/compare | Comparisons | O | reports.view |
| POST | /reports/run | Custom report {reportType, groupBy, metrics, filters, from, to} | O | reports.custom |
| POST | /reports/export | Export {definition, format} → file or job | O | reports.export |
| GET/POST/PATCH/DELETE | /saved-reports | Custom report builder saves | O | reports.custom |
| GET/POST/PATCH/DELETE | /report-schedules | Scheduled/email reports | O | reports.schedule |
| GET/POST/DELETE | /report-shares | Shareable read-only links {savedReportId \| definition, expiresAt, password?, clientId?} | O | reports.share |
| GET | /public/reports/:token | Shared read-only report (password via header) | P | — |
| GET | /performance/members/:id · /teams/:id ?granularity&from&to | Performance overview | O | performance.view |
| GET | /performance/compare?memberIds | Comparison | O | performance.view |
| GET | /performance/workload?teamId | Workload distribution | O | performance.view |
| GET | /leaderboard?metric&period&teamId | Leaderboard | O | performance.view (or org setting) |
| GET/POST/PATCH/DELETE | /performance-goals · /custom-metrics | Goals & custom metrics | O | performance.view / reports.custom |

### F.11 Client portal (`/client-portal`, role client)
`GET /client-portal/dashboard` · `GET/PATCH /client-portal/profile` · `GET /client-portal/projects` · `GET /client-portal/projects/:id` (progress, budget, team) · `GET /client-portal/projects/:id/time?from&to&groupBy` · `GET /client-portal/projects/:id/tasks` · `GET /client-portal/projects/:id/timesheets` · `GET /client-portal/reports` (shared) · `GET/POST /client-portal/projects/:id/comments` · `GET /client-portal/invoices` · `GET /client-portal/invoices/:id/pdf` · `GET /client-portal/notifications`. All read-only except profile & comments; responses filtered by `clients.portal_permissions`.

### F.12 Billing, invoices, payroll
| Method | Endpoint | Purpose | Auth | Permission |
|---|---|---|---|---|
| GET | /billing/summary?from&to&projectId&clientId | Billable/non-billable hours, cost, revenue | O | billing.view |
| GET | /billing/projects/:id | Project billing summary | O | billing.view |
| GET/POST | /invoices · POST /invoices/generate | List / manual create / generate from time {clientId, from, to, projectIds, groupBy} | O | invoices.view / invoices.manage |
| GET/PATCH/DELETE | /invoices/:id | Edit draft | O | invoices.manage |
| POST | /invoices/:id/send · /void · /payments | Send email, void, record payment {amount, paidAt, method} | O | invoices.manage |
| GET | /invoices/:id/pdf | PDF | O/client | invoices.view |
| GET/POST | /payroll/runs · GET /payroll/runs/:id | Create run {periodStart, periodEnd} → computed items | O | payroll.view / payroll.manage |
| PATCH | /payroll/runs/:id/items/:itemId | Adjustment | O | payroll.manage |
| POST | /payroll/runs/:id/finalize · /mark-paid · /export?format | Finalize / export | O | payroll.manage |
| GET | /currencies · /exchange-rates?base&date | Currency data | O | — |

### F.13 Notifications
`GET /notifications?unread&page` · `GET /notifications/unread-count` · `PATCH /notifications/:id/read` · `POST /notifications/read-all` · `DELETE /notifications/:id` · `GET/PUT /organization/notification-defaults` (notifications.manage) — Auth O.

### F.14 Settings & privacy
| Method | Endpoint | Purpose | Auth | Permission |
|---|---|---|---|---|
| GET | /tracking-settings?scopeType&scopeId | Settings at scope | O | settings.tracking |
| PUT | /tracking-settings | Upsert {scopeType, scopeId, …fields} | O | settings.tracking |
| DELETE | /tracking-settings/:id | Remove override (inherit) | O | settings.tracking |
| GET | /tracking-settings/effective?memberId&projectId | Merged settings | O/A | settings.tracking or self |
| GET/PUT | /privacy-settings | Consent policy text/version, retention days, title capture, URL capture | O | settings.privacy |
| GET | /consents?status | Who has/hasn't consented | O | settings.privacy |
| GET/POST | /data-requests · POST /data-requests/:id/approve · /reject | Export/deletion requests | O | own create / privacy.requests.manage |
| GET | /data-requests/:id/download | Export file | O | owner of request |
| GET | /audit-logs?actor&entityType&action&from&to | Audit history | O | audit.view |

### F.15 Integrations, API keys, webhooks
| Method | Endpoint | Purpose | Auth | Permission |
|---|---|---|---|---|
| GET | /integrations | Available + connected | O | integrations.manage |
| GET | /integrations/:provider/connect | OAuth start | O | integrations.manage + feature |
| GET | /integrations/:provider/callback | OAuth callback | P(state) | — |
| PATCH/DELETE | /integrations/:provider | Settings / disconnect | O | integrations.manage |
| POST | /integrations/:provider/sync | Manual sync/import | O | integrations.manage |
| GET/POST/DELETE | /api-keys | Keys (secret shown once) | O | api_keys.manage |
| GET/POST/PATCH/DELETE | /webhooks · GET /webhooks/:id/deliveries · POST /webhooks/:id/test | Webhooks | O | webhooks.manage |
| POST/DELETE | /hooks/subscriptions | Zapier/n8n REST hook subscribe | K | api scope |
| POST | /webhooks/stripe · /webhooks/slack · /webhooks/github … | Inbound provider webhooks (signature verified) | P(signed) | — |
| GET | /api/docs · /api/openapi.json | Documentation | P (prod: optional auth) | — |

### F.16 Subscription
`GET /plans` (P) · `GET /subscription` · `GET /subscription/usage` · `GET /subscription/features` · `POST /subscription/checkout {planCode, interval}` → Stripe URL · `POST /subscription/change {planCode, interval}` · `POST /subscription/cancel` · `POST /subscription/resume` · `POST /subscription/portal` → Stripe portal URL · `GET /subscription/invoices` · `GET /subscription/payments` — Auth O, permission `subscription.manage` (read: OW/AD).

### F.17 Desktop agent (`/agent`, device token)
| Method | Endpoint | Purpose |
|---|---|---|
| POST | /agent/auth/login | {email,password,deviceInfo{os,osVersion,appVersion,hostname,machineId}} → device token, orgs |
| POST | /agent/auth/logout | Revoke device token |
| GET | /agent/organizations · POST /agent/organizations/select | Org selection |
| GET | /agent/config | Effective tracking settings + monitoring indicator rules + consent status |
| GET | /agent/projects · /agent/tasks?projectId | Selection lists (assigned only) |
| GET | /agent/timer · /agent/today | Current timer, today's totals |
| POST | /agent/timer/start · pause · resume · stop | Timer (shares timer service) |
| POST | /agent/heartbeat | {status, activityPercent, currentApp?, pendingCount, online} → presence |
| POST | /agent/activity | Batch activity samples |
| POST | /agent/app-usage · /agent/web-usage | Batches |
| POST | /agent/idle | Idle periods |
| POST | /agent/screenshots/upload-url · /agent/screenshots | Screenshot upload & metadata |
| POST | /agent/sync | Offline batch (all types) with checksum → per-item results |
| GET | /agent/sync/status | Server-side sync state |
| GET | /agent/notifications?since | Desktop notifications payloads |
| GET | /agent/releases/latest?os&channel | Auto-update info |

### F.18 Platform (Super Admin, `/platform`)
`GET /platform/stats` · `GET /platform/organizations` · `GET/PATCH /platform/organizations/:id` (suspend/activate, extend trial) · `GET /platform/users` · `PATCH /platform/users/:id` (disable) · `GET/POST/PATCH /platform/plans` · `GET /platform/subscriptions` · `GET /platform/audit-logs` · `GET /platform/security-events` · `GET/POST /platform/app-releases` · `GET /platform/health` — Auth S.

---

## G. Module Dependencies

| Module | Depends on | Why (from PDF) |
|---|---|---|
| M01 Auth & Orgs | — | Foundation |
| M02 RBAC | M01 | Roles belong to org members |
| M25 Subscription (limits) | M01 | Seat/storage/feature limits gate invites, uploads, features |
| M22 Settings | M01, M02 | Org/tracking/privacy settings consumed everywhere |
| M24 Security | M01, M02 | Cross-cutting (audit, rate limit, isolation) |
| M03 Employees | M01, M02, M25 | Members, invites, seat limits |
| M04 Teams/Depts | M03 | Team members are employees |
| M12 Schedules (part) | M03, M04, M22 | Working schedule/weekly hours of employees & teams |
| M17 Clients (entity) | M01 | Projects belong to clients |
| M09 Projects | M03, M04, M17 | Manager/team/employee assignment, client |
| M10 Tasks | M09, M03 | Tasks in projects, assignees |
| M11 Kanban | M10 | Board of tasks |
| M05 Time Tracking | M03, M09, M10, M22, M12 | Entries per employee/project/task/client; limits; overtime vs schedule |
| M13 Breaks & Idle | M05, M22 | Breaks pause timer; idle settings |
| M07 Activity | M05, M22 | Samples belong to entries |
| M06 Screenshots | M05, M07, M22, M24, M25 | Linked to entry/project/task; privacy; storage |
| M08 Apps & Websites | M05, M22 | Usage during entries; categorization |
| M20 Agent/Sync | M01, M05–M08, M13, M22 | Desktop ingestion of all tracking data |
| M12 Attendance | M05, M12 schedules, holidays | Check-in from timer, late/absent vs shift |
| M14 Timesheets | M05, M13, M12 | Built from time entries, overtime, approvals |
| M19 Notifications | M01 (+ events from all modules) | Every module emits events |
| M15 Reports | M05–M14 | Aggregates tracking, attendance, projects, tasks, employees |
| M16 Performance | M15, M07, M08, M10 | Score from activity, productive apps, tasks |
| M18 Billing & Payroll | M05, M14 (approved time), M09, M17, M03 rates | Hours × rates |
| M17 Client Portal | M09, M10, M14, M15, M18 | Read-only views of projects, time, timesheets, invoices |
| M21 Admin Dashboard | M05–M16, M19 | Overviews, live monitoring, approvals |
| M23 Integrations | M01, M09, M10, M19, M18 | Import tasks, push notifications, accounting/payroll |

```
M01 ─┬─ M02 ─┬─ M22 ── M24
     │       └─ M03 ─ M04 ─ M12(schedules)
     ├─ M25                │
     └─ M17(clients) ─ M09 ─ M10 ─ M11
                              │
                M05 Time ◄────┘ ─┬─ M13 ─┬─ M14 Timesheets ─┬─ M18 Billing/Payroll ─ M17 Portal
                                 ├─ M07  │                  │
                                 ├─ M06  └─ M12 Attendance  ├─ M15 Reports ─ M16 Performance ─ M21 Dashboard
                                 ├─ M08                     │
                                 └─ M20 Agent/Sync          └─ M19 Notifications (all)  ─ M23 Integrations
```

---

## H. Development Phases

Each phase lists back-end, database, and integration tasks. Front-end tasks for the same phase are in the front-end guide §H. **A phase is done only when its completion criteria pass with the front-end integrated.**

### Phase 0 — Foundation (both repos)
- **Back-end:** init Express 5 ESM project, folder structure, env validation, logger, error handler, request-id, helmet/cors, health check `GET /health`, Prisma setup, docker-compose (postgres/redis/minio/mailpit), Vitest + Supertest, ESLint/Prettier, OpenAPI registry + Swagger UI, BullMQ worker skeleton, Socket.IO skeleton.
- **Database:** extensions (citext, pg_trgm, btree_gist), base migration.
- **Integration:** Next.js rewrite `/api/v1/*` → `http://localhost:4000/api/v1/*`; CORS for direct dev.
- **Completion:** `npm run dev` + `docker compose up` works; `/health` returns DB+Redis OK; `/api/docs` renders; CI runs tests.

### Phase 1 — Authentication, Organizations, RBAC, Subscription skeleton (M01, M02, M24 core, M25 limits)
- **Back-end:** register/login/refresh/logout, email verification, forgot/reset, Google OAuth, 2FA, passkeys, sessions/devices/login history, switch org, profile, change password, invitations (email + link + accept/reject), roles/permissions catalog + custom roles, authorize middleware + scope resolver, audit log service, rate limiting & brute-force, plans seed + trial subscription on registration + seat-limit/feature middleware.
- **Database:** users…invitation_links, roles, permissions, role_permissions, member_scopes, audit_logs, security_events, plans, subscriptions, usage_counters.
- **Completion:** full auth flows pass integration tests (incl. refresh reuse detection, 2FA, cross-org isolation tests); permission matrix tests for 7 roles.

### Phase 2 — Organization structure & settings (M03, M04, M22, M12 schedules, M17 clients entity)
- **Back-end:** members CRUD/search/filters, rates, managers, deactivate, bulk import/invite, departments, teams, leaders/managers, org settings, tracking settings (scoped + effective), privacy settings & consent, work schedules, shifts, holidays, clients CRUD.
- **Completion:** admin can build org chart, configure tracking per org/team/member; effective settings endpoint correct for all inheritance cases (unit tests).

### Phase 3 — Projects, Tasks, Kanban (M09, M10, M11)
- **Back-end:** projects CRUD/archive/members/teams/notes, comments, attachments (S3 presigned), activity log, tasks with subtasks/dependencies/labels/categories, board columns, move with positions, list/calendar endpoints, review/approval, socket board events.
- **Completion:** project/task permission scoping tested; drag-drop ordering stable under concurrency; dependency cycle rejected.

### Phase 4 — Time Tracking core (M05, M13, M20 timer part)
- **Back-end:** timer state machine (start/pause/resume/stop/switch), manual entries, edit/delete/history, approval/rejection, summaries (day/week/month), weekly limits, overtime, time zones, breaks & break types, idle periods resolve, idle adjustments, `daily_summaries` incremental update, real-time timer events, agent auth + timer + heartbeat endpoints.
- **Completion:** one-running-timer & no-overlap constraints proven; overtime/timezone unit tests (DST boundaries); web + agent timer stay in sync.

### Phase 5 — Monitoring: Activity, Screenshots, Apps/Websites, Offline Sync (M06, M07, M08, M20)
- **Back-end:** activity ingestion & timeline/summary, screenshot upload/metadata/thumb+blur worker/gallery/timeline/download/delete/export/storage/retention, app & web usage ingestion, productivity rules & discovered apps, sensitive exclusions, `/agent/sync` with idempotency/conflicts/checksums, presence/live room, privacy enforcement (consent, indicator flag, no keystroke content).
- **Completion:** replaying the same sync batch twice produces zero duplicates; employee can only see own screenshots; blurred-only viewers never receive original URL; retention job verified.

### Phase 6 — Attendance & Timesheets (M12, M14)
- **Back-end:** check-in/out (manual + auto), late/early/absent detection jobs, corrections & approval, attendance reports, timesheet generation job, grid views (employee/team/project/task), submit/approve/reject/revision/multi-level workflow, locking, comments, exports PDF/XLSX/CSV, history.
- **Completion:** editing entries in locked period returns 409; absent detection respects holidays/weekends/flexible schedules.

### Phase 7 — Notifications & Admin Dashboard (M19, M21)
- **Back-end:** notification service, all 20 event types wired, preferences, email templates, digests, alert jobs (low activity, idle, overtime, budget, deadlines, overdue, timesheet reminders), dashboard stats/overview/charts, live members, approvals aggregator, action center, recent activity, system alerts.
- **Completion:** each NOTIF event has a test asserting recipients + channels honor preferences; dashboard KPIs match raw-data recomputation tests.

### Phase 8 — Reports, Analytics & Performance (M15, M16)
- **Back-end:** report engine (all report types, groupings, comparisons, trends), exports, custom report builder, scheduled/email reports, shareable links, performance score, goals, custom metrics, snapshots, leaderboard, workload.
- **Completion:** report totals reconcile with time-entry sums for sample datasets; scheduled report delivered to Mailpit; share link revocation works.

### Phase 9 — Billing, Payroll & Client Portal (M18, M17)
- **Back-end:** rate resolution, billing summaries, invoice generation/PDF/send/payments/overdue, payroll runs/items/finalize/export, exchange rates & multi-currency, client portal router with permission filtering, client invitations & comments & notifications.
- **Completion:** invoiced entries cannot be invoiced twice; payroll overtime matches formulas; client cannot access any non-assigned project (tests).

### Phase 10 — SaaS Billing, Integrations, API platform (M25 full, M23)
- **Back-end:** Stripe checkout/portal/webhooks, upgrade/downgrade/cancel, invoices/payments history, expiry notifications, usage limits enforcement everywhere; API keys, webhooks (outbound with retries + signature), REST hooks for Zapier/n8n, provider adapters (Slack, MS Teams, Jira, Trello, Asana, ClickUp, GitHub, GitLab, Calendar, Accounting, Payroll), complete Swagger docs.
- **Completion:** Stripe test-mode lifecycle e2e; webhook signature verifiable by sample consumer; each integration connect/disconnect/sync tested against sandbox or mocked provider.

### Phase 11 — Privacy/GDPR, Security hardening, Platform admin, Performance
- **Back-end:** data export & deletion requests, retention policies for all data types, RLS defense-in-depth (optional), security monitoring events, backup/restore runbook, Super Admin platform APIs, load tests (k6) on ingestion & reports, index tuning, partitions automation (pg_partman or monthly migration job).
- **Completion:** OWASP ASVS L2 checklist reviewed; load test targets met (e.g. 1 000 agents × 1 heartbeat/min, p95 < 200 ms for dashboard stats); backup restore rehearsed.

### Phase 12 — UAT & Release
- End-to-end regression of every feature ID, documentation finalization, production deployment, monitoring dashboards.

---

## I. Development Checklist

### I.1 Definition of Done (applies to **every** feature ID)
- [ ] Database migration & model completed (constraints + indexes)
- [ ] Back-end API implemented (route → controller → service → repo)
- [ ] Zod validation & error codes implemented
- [ ] Authentication & permission/scope checks verified (incl. 403 tests)
- [ ] Organization isolation verified (cross-tenant test)
- [ ] Audit log / activity log / notifications emitted where applicable
- [ ] OpenAPI documentation updated
- [ ] Unit + integration tests passing
- [ ] Front-end API integration completed (see front-end guide)
- [ ] Functionality verified end-to-end
- [ ] Feature marked **Completed** in §J

### I.2 Per-module back-end checklists
Tick a feature only when its back-end portion of the DoD is done. (Front-end ticks live in the front-end guide.)

**M01 Auth & User Management**
- [x] AUTH-01 Email/password login (argon2, lockout, history)
- [x] AUTH-02 Google OAuth (link/create, state/PKCE)
- [x] AUTH-03 Forgot password (no enumeration)
- [x] AUTH-04 Reset password (single-use, revoke sessions)
- [x] AUTH-05 Email verification + resend
- [x] AUTH-06 2FA TOTP setup/enable/disable/recovery + login step + org enforcement
- [x] AUTH-07 Passkeys register/login/list/delete
- [x] AUTH-08 Sessions list/revoke/revoke-others; refresh rotation + reuse detection
- [x] AUTH-09 Remember me TTLs
- [x] AUTH-10 Multi-org membership + switch organization
- [x] AUTH-11 Organization registration transaction (org, owner, roles, settings, trial)
- [x] AUTH-12 Organization profile
- [x] AUTH-13 Logo & branding upload
- [x] AUTH-14 Email invitations (+ seat check)
- [x] AUTH-15 Invite links (max uses, expiry, revoke)
- [x] AUTH-16 Accept/reject invitation (new + existing user)
- [x] AUTH-17 Account activation/deactivation
- [x] AUTH-18 Profile management (+ avatar)
- [x] AUTH-19 Change password
- [x] AUTH-20 Login history
- [x] AUTH-21 Device & session history

**M02 RBAC**
- [x] RBAC-01 authorize middleware + scope resolver
- [x] RBAC-02 Custom roles
- [x] RBAC-03 Permission catalog & management
- [x] RBAC-04 Module-level permissions
- [x] RBAC-05 Team-level scope
- [x] RBAC-06 Project-level scope
- [x] RBAC-07 Screenshot viewing permissions
- [x] RBAC-08 Report access permissions
- [x] RBAC-09 Role assignment rules (last owner, no escalation)
- [x] RBAC-10 Multiple managers
- [x] RBAC-11 Access restrictions (member restrictions + plan gates)
- [x] Permission matrix tests for all 7 built-in roles

**M03 Employees** — [x] EMP-01 [x] EMP-02 [x] EMP-03 [x] EMP-04 [x] EMP-05 [x] EMP-06 [x] EMP-07 [x] EMP-08 [x] EMP-09 [x] EMP-10 [x] EMP-11 [x] EMP-12 [x] EMP-13 [x] EMP-14 [x] EMP-15 [x] EMP-16 [x] EMP-17 [x] EMP-18 [x] EMP-19 [x] EMP-20 [x] EMP-21 [x] EMP-22 [x] EMP-23 [x] EMP-24
- [x] Add/edit/profile endpoints (EMP-01…16)
- [x] History tabs: activity, work, devices, performance (EMP-17…20)
- [x] Search & filters with indexes (EMP-21)
- [x] Bulk import CSV/XLSX with preview + error report (EMP-22)
- [x] Bulk invitation (EMP-23)
- [x] Deactivation side-effects: stop timer, revoke sessions & device tokens, free seat (EMP-24)

**M04 Teams & Departments**
- [x] TEAM-01 Departments CRUD
- [x] TEAM-02/03 Teams CRUD
- [x] TEAM-04 Team leaders
- [x] TEAM-05/06 Add/remove members
- [x] TEAM-07 Team working hours
- [x] TEAM-08 Team productivity overview
- [x] TEAM-09 Team activity reports
- [x] TEAM-10 Team performance comparison
- [x] TEAM-11 Team working schedule
- [x] TEAM-12 Team-wise filtering on all list/report endpoints
- [x] TEAM-13 Team-wise project assignment

**M05 Time Tracking**
- [x] TIME-01…04 Timer start/stop/pause/resume (+ switch), single running timer constraint
- [x] TIME-05 Desktop automatic tracking via agent
- [x] TIME-06 Manual entry (+ approval when required)
- [x] TIME-07/08/09 Task / project / client linkage & validation
- [x] TIME-10 Real-time timer events
- [x] TIME-11…14 Day/week/month/total summaries (timezone-correct)
- [x] TIME-15 Active working time
- [x] TIME-16 Idle time calculation
- [x] TIME-17 Break time tracking
- [x] TIME-18 Meeting time tracking
- [x] TIME-19 Offline time entry
- [x] TIME-20 Automatic idle detection validation
- [x] TIME-21 Auto pause
- [x] TIME-22 Auto resume with confirmation (resolve endpoint)
- [x] TIME-23 Automatic time sync (web ↔ agent)
- [x] TIME-24 Multiple entries, overlap exclusion constraint
- [x] TIME-25 Timer history
- [x] TIME-26 Editing (+ history, lock check)
- [x] TIME-27 Deletion (soft + audit)
- [x] TIME-28/29 Approval / rejection (+ bulk)
- [x] TIME-30 Notes
- [x] TIME-31 Weekly limits (warn/block)
- [x] TIME-32 Overtime calculation (daily/weekly/both)
- [x] TIME-33 Time zone support (DST tests)
- [x] TIME-34 12/24-hour preference stored

**M06 Screenshots**
- [x] SS-01 Upload flow (presign → PUT → metadata)
- [x] SS-02/03/04 Frequency & random interval config (3/5/10/15)
- [x] SS-05/06/07 Member/team/project settings via scoped tracking settings
- [x] SS-08 Multi-monitor grouping
- [x] SS-09 Gallery · [x] SS-10 Timeline · [x] SS-11/12/13 Full/preview/zoom URLs
- [x] SS-14 Download · [x] SS-15 Delete · [x] SS-16 Blur variants
- [x] SS-17 Storage management · [x] SS-18 Timestamps
- [x] SS-19/20/21 Links to project/task/employee · [x] SS-22 Activity info
- [x] SS-23 Filters · [x] SS-24 Retention job · [x] SS-25 ZIP export
- [x] SS-26 Access permissions · [x] SS-27 Capture notifications
- [x] SS-P1…P5 Privacy rules (status endpoint, forced indicator, own access, no stealth, privacy settings)

**M07 Activity**
- [x] ACT-01/02 Keyboard/mouse activity ingestion (counts only, strict schema)
- [x] ACT-03/04/05 Active, idle, percentage
- [x] ACT-06 Timeline
- [x] ACT-07…10 Hourly/daily/weekly/monthly reports
- [x] ACT-11/12/13 Employee/team/project comparison
- [x] ACT-14 Trend analysis
- [x] ACT-15 Low activity alerts · [x] ACT-16 Idle alerts
- [x] ACT-17 Active vs idle series
- [x] Configurable thresholds (30/60 defaults)

**M08 Apps & Websites**
- [x] APP-01/02 App & web ingestion
- [x] APP-03 App name normalization · [x] APP-04 URL detection (domain default, full URL opt-in)
- [x] APP-05…08 Browser tracking (Chrome/Firefox/Edge)
- [x] APP-09/10 Durations · [x] APP-11/12 Timelines
- [x] APP-13/14/15 Productive/unproductive/neutral lists
- [x] APP-16 Custom categorization (scope precedence)
- [x] APP-17/18 Productive/unproductive time
- [x] APP-19 Website category management
- [x] APP-20…23 App/web reports (individual + team)
- [x] APP-24/25 Tracking on/off
- [x] Seed rules (VS Code, Figma, Slack, YouTube, Facebook)

**M09 Projects**
- [x] PROJ-01…04 CRUD + archive
- [x] PROJ-05…11 Fields (name, description, dates, status, budget, rate)
- [x] PROJ-12/13/14 Manager/team/employee assignment
- [x] PROJ-15 Priority · [x] PROJ-16/25 Progress & completion %
- [x] PROJ-17/18 Time tracking & total hours
- [x] PROJ-19 Activity history · [x] PROJ-20 Attachments · [x] PROJ-21 Comments · [x] PROJ-22 Notes
- [x] PROJ-23 Project reports · [x] PROJ-24 Employee performance per project
- [x] PROJ-26 Deadline notifications · [x] PROJ-27 Status updates · [x] PROJ-28 Access permissions

**M10 Tasks**
- [x] TASK-01/02/03 CRUD
- [x] TASK-04/05 Single/multiple assignees
- [x] TASK-06…11 Fields (description, priority, status, dates, estimate)
- [x] TASK-12/13 Actual hours & time tracking
- [x] TASK-14 Progress · [x] TASK-15 Labels · [x] TASK-16 Categories
- [x] TASK-17 Subtasks · [x] TASK-18 Dependencies (cycle detection)
- [x] TASK-19 Comments (+ mentions) · [x] TASK-20 Attachments · [x] TASK-21 Activity history
- [x] TASK-22 Completion · [x] TASK-23 Review · [x] TASK-24 Approval
- [x] TASK-25 Notifications · [x] TASK-26 Overdue alerts · [x] TASK-27 Task time reports

**M11 Kanban**
- [x] KAN-01…04 Default columns seeded per project
- [x] KAN-05 Move with fractional positions + socket event
- [x] KAN-06 Custom columns (category rules)
- [x] KAN-07…14 Card DTO (priority, avatars, due, labels, subtask progress, comment count) + detail
- [x] KAN-15 Quick create
- [x] KAN-16/17/18/19 Filters & search (trigram)
- [x] KAN-20/21/22 Board / list / calendar endpoints

**M12 Attendance & Schedule**
- [x] ATT-01/02 Check-in/out (manual + auto)
- [x] ATT-03/04/05 Daily/weekly/monthly
- [x] ATT-06 Late · [x] ATT-07 Early leave · [x] ATT-08 Absent job
- [x] ATT-09 Working days · [x] ATT-10 Office hours · [x] ATT-11 Remote schedule · [x] ATT-12 Flexible hours
- [x] ATT-13 Shifts · [x] ATT-14 Multiple shifts · [x] ATT-15 Holidays · [x] ATT-16 Weekends
- [x] ATT-17/18 Corrections & approval
- [x] ATT-19 History · [x] ATT-20 Reports · [x] ATT-21 Overtime attendance · [x] ATT-22 Notifications

**M13 Breaks & Idle**
- [x] BRK-01/02 Start/end break (timer interplay)
- [x] BRK-03…07 Paid/unpaid/lunch/tea/custom types
- [x] BRK-08 Duration & over-limit · [x] BRK-09 Break reports
- [x] BRK-10…13 Idle detection, notifications, confirmation, auto-pause
- [x] BRK-14/15 Idle adjustment request & manager approval

**M14 Timesheets**
- [x] TS-01 Auto generation job
- [x] TS-02/03/04 Day/week/month views
- [x] TS-05/06/07/08 Employee/team/project/task timesheets
- [x] TS-09 Manual entry from grid · [x] TS-10 Edit
- [x] TS-11/12/13 Submit/approve/reject · [x] TS-14 Revision · [x] TS-15 Multi-level workflow
- [x] TS-16 Locking (+ auto-lock, unlock) · [x] TS-17 Comments
- [x] TS-18/19/20 PDF/Excel/CSV export · [x] TS-21 History

**M15 Reports & Analytics**
- [x] RPT-D01…D14 Dashboard KPIs
- [x] RPT-E01…E08 Employee reports
- [x] RPT-P01…P06 Project reports
- [x] RPT-A01…A10 Chart datasets
- [x] RPT-A11 Date range filtering (tz aware)
- [x] RPT-A12 Custom report builder
- [x] RPT-A13 Export PDF/CSV/Excel
- [x] RPT-A14 Scheduled reports · [x] RPT-A15 Email reports · [x] RPT-A16 Shareable read-only links
- [x] `daily_summaries` incremental + nightly reconciliation

**M16 Performance**
- [x] PERF-01 Productivity score (configurable weights)
- [x] PERF-02/03 Individual/team overview
- [x] PERF-04/05/06 Daily/weekly/monthly
- [x] PERF-07 Trends · [x] PERF-08 Task completion rate · [x] PERF-09 Project contribution
- [x] PERF-10 Estimated vs actual · [x] PERF-11 Consistency · [x] PERF-12 Activity trends
- [x] PERF-13 Comparison · [x] PERF-14 Top contributors · [x] PERF-15 Workload
- [x] PERF-16 History snapshots · [x] PERF-17 Goals · [x] PERF-18 Alerts · [x] PERF-19 Custom metrics
- [x] LB-01…06 Leaderboard metrics (+ visibility setting)

**M17 Client Portal**
- [x] CLI-01/02 Client invite/registration & login
- [x] CLI-03 Profile · [x] CLI-04 Dashboard · [x] CLI-05 Project access filter
- [x] CLI-06 Progress · [x] CLI-07 Team overview · [x] CLI-08 Time reports · [x] CLI-09 Task progress
- [x] CLI-10 Billable hours · [x] CLI-11 Budget · [x] CLI-12 Timesheets · [x] CLI-13 Shared reports
- [x] CLI-14 Read-only enforcement · [x] CLI-15 Comments · [x] CLI-16 Notifications
- [x] CLI-17 Invoice summary · [x] CLI-18 Client-specific permissions

**M18 Billing & Payroll**
- [x] BILL-01/02/03 Rates (employee/project/client) + resolution order
- [x] BILL-04/05 Billable / non-billable
- [x] BILL-06 Project cost · [x] BILL-07 Salary calculation · [x] BILL-08 Overtime pay
- [x] BILL-09 Monthly payroll summary · [x] BILL-10 Project billing summary
- [x] BILL-11 Invoice generation (no double billing) · [x] BILL-12 Invoice PDF
- [x] BILL-13 Status · [x] BILL-14 Paid/unpaid + overdue job · [x] BILL-15 Payroll reports
- [x] BILL-16 Currency settings · [x] BILL-17 Multi-currency + exchange rates

**M19 Notifications**
- [x] NOTIF-01 … NOTIF-20 each event wired (one checkbox per event when implemented)
- [x] NOTIF-21 Email channel · [x] NOTIF-22 In-app + socket · [x] NOTIF-23 Desktop payloads
- [x] NOTIF-24 Preferences (user + org defaults, mandatory events)

**M20 Desktop support & Sync**
- [x] DESK-01/25 Agent login/logout + device registration
- [x] DESK-02/03/04 Org/project/task selection
- [x] DESK-05/06/07/08 Timer + today endpoints
- [x] DESK-09/17/23 Heartbeat/presence/connection
- [x] DESK-10…14 Ingestion endpoints
- [x] DESK-19 Desktop notification payloads · [x] DESK-21/22 Releases & min version · [x] DESK-24 Device info · [x] DESK-26 Quit handling
- [x] SYNC-01…12 Offline sync (idempotency, retry-safe, conflicts, checksum, status, last sync)

**M21 Admin Dashboard**
- [x] ADM-01…05 Overviews · [x] ADM-06/07/08 Live monitoring & statuses · [x] ADM-09 Latest screenshots
- [x] ADM-10/11/12 Summaries · [x] ADM-13/14/15 Pending approvals · [x] ADM-16 Action center
- [x] ADM-17 Recent activities · [x] ADM-18 System alerts · [x] ADM-20…23 Filters
- [x] Super Admin platform APIs

**M22 Settings**
- [x] SET-O01…O08 Organization settings
- [x] SET-T01…T12 Tracking settings + effective merge + agent push
- [x] PRIV-01 Consent · [x] PRIV-02 Indicator · [x] PRIV-03 Data access · [x] PRIV-04 Retention
- [x] PRIV-05 Screenshot privacy · [x] PRIV-06 Sensitive exclusions · [x] PRIV-07 Deletion requests · [x] PRIV-08 Export requests · [x] PRIV-09 Audit history

**M23 Integrations**
- [x] INT-01 REST versioning · [x] INT-02 API keys · [x] INT-03 Webhooks · [x] INT-04 API auth · [x] INT-05 Rate limiting
- [x] INT-06/07 Swagger/OpenAPI complete
- [x] INT-08 Google · [x] INT-09 Slack · [x] INT-10 MS Teams · [x] INT-11 Jira · [x] INT-12 Trello · [x] INT-13 Asana · [x] INT-14 ClickUp
- [x] INT-15 GitHub · [x] INT-16 GitLab · [x] INT-17 Payroll · [x] INT-18 Accounting · [x] INT-19 Calendar · [x] INT-20 Zapier · [x] INT-21 n8n

**M24 Security**
- [x] SEC-01 … SEC-23 (one checkbox each as implemented; cross-tenant test suite mandatory for SEC-21)

**M25 Subscription**
- [x] SUB-01…04 Plans seeded · [x] SUB-05/06 Monthly/yearly · [x] SUB-07 Per-seat · [x] SUB-08 Trial
- [x] SUB-09 Upgrade · [x] SUB-10 Downgrade · [x] SUB-11 Cancel
- [x] SUB-12 Payment history · [x] SUB-13 Invoice history · [x] SUB-14 Stripe integration + webhooks
- [x] SUB-15 Expiry notifications · [x] SUB-16 Usage limits · [x] SUB-17 Seats · [x] SUB-18 Storage · [x] SUB-19 Retention limits · [x] SUB-20 Feature restrictions · [x] SUB-21 Subscription management

---

## J. Progress Tracking

**Statuses:** `Not Started` · `In Progress` · `Frontend Completed` · `Backend Completed` · `Integration Completed` · `Testing` · `Completed` · `Blocked`

Update this table at the end of every work session (keep it identical to the table in the front-end guide). Record blockers with a short reason.

| # | Module | Phase | Back-end | Front-end | Overall status | Notes / Blockers |
|---|---|---|---|---|---|---|
| 0 | Foundation / project setup | 0 | Backend Completed | Not Started | Backend Completed | Both repos are empty scaffolds |
| M01 | Authentication & User Management | 1 | Backend Completed | Not Started | Backend Completed | |
| M02 | Role & Permission Management | 1 | Backend Completed | Not Started | Backend Completed | |
| M03 | Employee Management | 2 | Backend Completed | Not Started | Backend Completed | |
| M04 | Team & Department Management | 2 | Backend Completed | Not Started | Backend Completed | |
| M05 | Time Tracking System | 4 | Backend Completed | Not Started | Backend Completed | Most important |
| M06 | Screenshot Monitoring | 5 | Backend Completed | Not Started | Backend Completed | |
| M07 | Employee Activity Monitoring | 5 | Backend Completed | Not Started | Backend Completed | |
| M08 | Application & Website Tracking | 5 | Backend Completed | Not Started | Backend Completed | |
| M09 | Project Management | 3 | Backend Completed | Not Started | Backend Completed | |
| M10 | Task Management | 3 | Backend Completed | Not Started | Backend Completed | |
| M11 | Kanban Board | 3 | Backend Completed | Not Started | Backend Completed | |
| M12 | Attendance & Work Schedule | 2 / 6 | Backend Completed | Not Started | Backend Completed | Schedules in P2, attendance in P6 |
| M13 | Break & Idle Time Management | 4 | Backend Completed | Not Started | Backend Completed | |
| M14 | Timesheet Management | 6 | Backend Completed | Not Started | Backend Completed | |
| M15 | Reports & Analytics | 8 | Backend Completed | Not Started | Backend Completed | |
| M16 | Employee Performance & Productivity | 8 | Backend Completed | Not Started | Backend Completed | |
| M17 | Client Portal | 9 | Backend Completed | Not Started | Backend Completed | Client entity in P2 |
| M18 | Billing & Payroll Management | 9 | Backend Completed | Not Started | Backend Completed | |
| M19 | Notifications & Alerts | 7 | Backend Completed | Not Started | Backend Completed | |
| M20 | Desktop Support & Offline Sync | 4 / 5 | Backend Completed | n/a (status UI only) | Backend Completed | Desktop app out of scope |
| M21 | Admin Dashboard & Control Center | 7 | Backend Completed | Not Started | Backend Completed | |
| M22 | Settings & Configuration | 2 | Backend Completed | Not Started | Backend Completed | |
| M23 | API & Third-Party Integrations | 10 | Backend Completed | Not Started | Backend Completed | |
| M24 | Security & Data Protection | 1 → 11 | Backend Completed | Not Started | Backend Completed | Cross-cutting |
| M25 | Subscription & SaaS Billing | 1 / 10 | Backend Completed | Not Started | Backend Completed | Limits in P1, Stripe in P10 |

### Progress log
| Date | Module / Feature IDs | Change | Status after |
|---|---|---|---|
| 2026-11-19 | — | Requirements analysis, codebase analysis, guide created | Not Started |
| 2026-11-20 | All modules (M01–M25) | Back-end implemented: 474 API operations, 103 tables, 28 test files / 238 integration tests passing on PGlite; server boot + HTTP smoke test OK. Front-end integration pending. | Backend Completed |

---

## Appendix: PDF Coverage Cross-Check

| PDF page(s) | PDF section | Feature count in PDF | IDs in this guide |
|---|---|---|---|
| 1 | §1 Authentication & User Management | 21 | AUTH-01…21 |
| 2–3 | §2 Role & Permission Management (7 roles + 11 features) | 11 | RBAC-01…11 + role table |
| 3 | §3 Employee Management | 24 | EMP-01…24 |
| 3–4 | §4 Team & Department Management | 13 | TEAM-01…13 |
| 4–5 | §5 Time Tracking System | 34 | TIME-01…34 |
| 5–6 | §6 Screenshot Monitoring (+5 privacy rules) | 27 + 5 | SS-01…27, SS-P1…P5 |
| 6 | §7 Employee Activity Monitoring (+ thresholds, privacy) | 17 | ACT-01…17 + thresholds + privacy rule |
| 7–8 | §8 Application & Website Tracking (+ example table) | 25 | APP-01…25 + seed rules |
| 8–9 | §9 Project Management | 28 | PROJ-01…28 |
| 9 | §10 Task Management | 27 | TASK-01…27 |
| 9–10 | §11 Kanban Board | 22 | KAN-01…22 |
| 10–11 | §12 Attendance & Work Schedule | 22 | ATT-01…22 |
| 11 | §13 Break & Idle Time Management | 15 | BRK-01…15 |
| 11–12 | §14 Timesheet Management | 21 | TS-01…21 |
| 12–13 | §15 Reports & Analytics (14 + 8 + 6 + 16) | 44 | RPT-D01…D14, RPT-E01…E08, RPT-P01…P06, RPT-A01…A16 |
| 13–14 | §16 Performance & Productivity (+ Leaderboard 6) | 19 + 6 | PERF-01…19, LB-01…06 |
| 14–15 | §17 Client Portal | 18 | CLI-01…18 |
| 15 | §18 Billing & Payroll | 17 | BILL-01…17 |
| 15–16 | §19 Notifications & Alerts | 24 | NOTIF-01…24 |
| 16–17 | Desktop App Features (unnumbered) + Supported OS | 26 + 3 OS | DESK-01…26 (back-end support only) |
| 17 | §21 Offline Tracking & Synchronization | 12 | SYNC-01…12 |
| 17–18 | §22 Admin Dashboard & Control Center | 23 | ADM-01…23 |
| 18–19 | §23 Settings (8 org + 12 tracking + 9 privacy) | 29 | SET-O01…08, SET-T01…12, PRIV-01…09 |
| 19 | §24 API & Third-Party Integrations | 21 | INT-01…21 |
| 19–20 | §25 Security & Data Protection | 23 | SEC-01…23 |
| 20–21 | §26 Subscription & SaaS Billing | 21 | SUB-01…21 |

All 21 pages are covered. No PDF feature has been dropped; desktop-only features are kept as DESK-xx with their back-end support defined.
