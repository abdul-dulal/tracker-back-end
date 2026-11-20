import { z } from 'zod';
import { verify as verifyTotp } from 'otplib';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent } from '../../lib/http.js';
import { verifyPassword } from '../../lib/password.js';
import { randomToken, sha256, decrypt } from '../../lib/crypto.js';
import { signToken, verifyToken } from '../../lib/jwt.js';
import { unauthenticated, forbidden, notFound, AppError } from '../../lib/errors.js';
import { emitToLive } from '../../lib/realtime.js';
import { createUpload } from '../../lib/storage.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { recordLogin, registerFailedLogin, assertNotLocked, listUserOrganizations } from '../auth/service.js';
import { startTimer, pauseTimer, resumeTimer, stopTimer, switchTimer, currentTimer, getRunningEntry } from '../time/timer-service.js';
import { recomputeDailySummary, memberTimezone } from '../time/summary-service.js';
import { memberProjectIds } from '../../rbac/scope.js';
import { assertStorageAvailable } from '../subscription/features.js';
import { processSyncBatch, syncBody } from '../sync/service.js';
import {
  zTs,
  activitySample,
  appUsageItem,
  webUsageItem,
  idleItem,
  screenshotItem,
  ingestCtx,
  ingestActivity,
  ingestAppUsage,
  ingestWebUsage,
  ingestIdle,
  ingestScreenshots,
  assertScreenshotAllowed,
  assertVersionSupported,
  buildAgentConfig,
  memberSettings,
  latestRelease,
  minSupportedRelease,
  cmpVersion,
  summarize,
} from './service.js';

/**
 * Desktop agent API (guide §F.17, DESK-01…26, SYNC-*). Authenticated with device tokens ("dt_…")
 * except login/select-organization/releases. Tracking only happens with consent while a timer runs;
 * there is no stealth mode and the monitoring indicator is always on (SS-P2/P4).
 */
const r = createRouter('/agent', 'Desktop agent');

const TOKEN_TTL_DAYS = 90;
const email = z.email().max(254).transform((v) => v.trim().toLowerCase());
const deviceSchema = z.strictObject({
  os: z.enum(['windows', 'macos', 'linux']),
  osVersion: z.string().trim().max(60).optional(),
  appVersion: z.string().trim().regex(/^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/, 'Expected a semantic version').max(30),
  hostname: z.string().trim().max(120).optional(),
  machineId: z.string().trim().min(6).max(256),
});

function deviceDto(d) {
  return {
    id: d.id,
    os: d.os,
    osVersion: d.os_version,
    appVersion: d.app_version,
    hostname: d.hostname,
    status: d.status,
    online: d.online,
    lastSeenAt: d.last_seen_at,
    lastSyncAt: d.last_sync_at,
    pendingCount: d.pending_count,
    createdAt: d.created_at,
  };
}

const activeOrgs = (orgs) => orgs.filter((o) => o.memberStatus === 'active' && o.status === 'active');

/** Register/refresh the device for the member and issue a device token (DESK-01, DESK-24). */
async function issueDeviceSession(req, user, orgId, device) {
  const member = await db.one(
    `SELECT m.id, m.status, m.employee_code, r.slug AS role_slug, r.base_role, r.name AS role_name, o.name AS org_name, o.slug AS org_slug, o.timezone AS org_timezone
     FROM organization_members m JOIN roles r ON r.id = m.role_id JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 AND m.organization_id = $2 AND m.deleted_at IS NULL AND o.deleted_at IS NULL AND o.status = 'active'`,
    [user.id, orgId],
  );
  if (!member || member.status !== 'active') throw forbidden('You are not an active member of this organization', 'NOT_A_MEMBER');
  if (member.base_role === 'client') throw forbidden('Client accounts cannot use the desktop app', 'AGENT_NOT_ALLOWED');
  const token = `dt_${randomToken(32)}`;
  const result = await db.tx(async () => {
    const dev = await db.one(
      `INSERT INTO devices (organization_id, member_id, kind, os, os_version, app_version, hostname, machine_id_hash, last_seen_at, online, status)
       VALUES ($1,$2,'desktop_agent',$3,$4,$5,$6,$7, now(), true, 'active')
       ON CONFLICT (member_id, machine_id_hash) DO UPDATE SET os = EXCLUDED.os, os_version = EXCLUDED.os_version, app_version = EXCLUDED.app_version,
         hostname = EXCLUDED.hostname, last_seen_at = now(), online = true, status = 'active'
       RETURNING *`,
      [orgId, member.id, device.os, device.osVersion ?? null, device.appVersion, device.hostname ?? null, sha256(device.machineId)],
    );
    await db.query('UPDATE device_tokens SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL', [dev.id]);
    const tok = await db.one(
      `INSERT INTO device_tokens (device_id, user_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' days')::interval) RETURNING expires_at`,
      [dev.id, user.id, sha256(token), String(TOKEN_TTL_DAYS)],
    );
    await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    await db.query('UPDATE organization_members SET last_seen_at = now() WHERE id = $1', [member.id]);
    return { dev, expiresAt: tok.expires_at };
  });
  await recordLogin({ userId: user.id, email: user.email, method: 'agent', success: true, ip: req.ctx.ip, userAgent: req.ctx.userAgent });
  return {
    deviceToken: token,
    expiresAt: result.expiresAt,
    device: deviceDto(result.dev),
    member: {
      id: member.id,
      userId: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      employeeCode: member.employee_code,
      role: { slug: member.role_slug, name: member.role_name, baseRole: member.base_role },
    },
    organization: { id: orgId, name: member.org_name, slug: member.org_slug, timezone: member.org_timezone },
    config: await buildAgentConfig(orgId, member.id),
  };
}

// ─── DESK-01/02 Login & organization selection ──────────────────────────────
r.post(
  '/auth/login',
  {
    auth: 'public',
    summary: 'Desktop login: credentials + device registration → device token',
    ids: 'DESK-01, DESK-02, DESK-22, DESK-24',
    middleware: authLimiter,
    body: z.strictObject({
      email,
      password: z.string().min(1).max(200),
      mfaCode: z.string().regex(/^\d{6}$/).optional(),
      organizationId: z.uuid().optional(),
      device: deviceSchema,
    }),
  },
  async (req, res) => {
    const b = req.body;
    const user = await db.one('SELECT * FROM users WHERE email = $1', [b.email]);
    const fail = async (u, reason) => {
      if (u) await registerFailedLogin(u, req.ctx);
      await recordLogin({ userId: u?.id, email: b.email, method: 'agent', success: false, reason, ip: req.ctx.ip, userAgent: req.ctx.userAgent });
    };
    if (!user) {
      await fail(null, 'unknown_email');
      throw unauthenticated('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    assertNotLocked(user);
    if (!(await verifyPassword(user.password_hash, b.password))) {
      await fail(user, 'bad_password');
      throw unauthenticated('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (user.status !== 'active') throw forbidden('This account has been disabled', 'ACCOUNT_DISABLED');
    if (user.mfa_enabled) {
      if (!b.mfaCode) throw new AppError(401, 'MFA_REQUIRED', 'Enter the code from your authenticator app', { methods: ['totp'] });
      const mfa = await db.one('SELECT * FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL', [user.id]);
      const valid = mfa ? (await verifyTotp({ secret: decrypt(mfa.totp_secret_enc), token: b.mfaCode, epochTolerance: 30 })).valid : false;
      if (!valid) {
        await fail(user, 'bad_mfa_code');
        throw unauthenticated('Invalid verification code', 'INVALID_MFA_CODE');
      }
    }
    await assertVersionSupported(b.device.os, b.device.appVersion);
    const orgs = activeOrgs(await listUserOrganizations(user.id));
    if (!orgs.length) throw forbidden('You are not an active member of any organization', 'NO_ACTIVE_ORGANIZATION');
    let orgId = b.organizationId;
    if (orgId && !orgs.some((o) => o.id === orgId)) throw forbidden('You are not an active member of this organization', 'NOT_A_MEMBER');
    if (!orgId && orgs.length === 1) orgId = orgs[0].id;
    if (!orgId) {
      const loginTicket = await signToken({ sub: user.id, purpose: 'agent_login' }, 5 * 60, 'agent-login');
      return ok(res, {
        requiresOrganizationSelection: true,
        organizations: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, roleName: o.roleName })),
        loginTicket,
      });
    }
    ok(res, await issueDeviceSession(req, user, orgId, b.device));
  },
);

r.post(
  '/auth/select-organization',
  {
    auth: 'public',
    summary: 'Complete desktop login for one organization using a login ticket',
    ids: 'DESK-02',
    middleware: authLimiter,
    body: z.strictObject({ loginTicket: z.string().min(10), organizationId: z.uuid(), device: deviceSchema }),
  },
  async (req, res) => {
    const p = await verifyToken(req.body.loginTicket, 'agent-login');
    if (p.purpose !== 'agent_login') throw unauthenticated('Invalid login ticket', 'INVALID_TOKEN');
    const user = await db.one('SELECT * FROM users WHERE id = $1', [p.sub]);
    if (!user || user.status !== 'active') throw unauthenticated('Invalid login ticket', 'INVALID_TOKEN');
    await assertVersionSupported(req.body.device.os, req.body.device.appVersion);
    ok(res, await issueDeviceSession(req, user, req.body.organizationId, req.body.device));
  },
);

r.post(
  '/auth/logout',
  { auth: 'agent', summary: 'Revoke the current device token (optionally stopping the timer)', ids: 'DESK-25, DESK-26', body: z.strictObject({ stopTimer: z.boolean().default(false) }) },
  async (req, res) => {
    const ctx = req.ctx;
    if (req.body.stopTimer && (await getRunningEntry(ctx.memberId))) await stopTimer(ctx, {});
    await db.query('UPDATE device_tokens SET revoked_at = now() WHERE id = $1', [ctx.deviceTokenId]);
    await db.query('UPDATE devices SET online = false, last_seen_at = now() WHERE id = $1', [ctx.deviceId]);
    emitToLive(ctx.orgId, 'presence.updated', { memberId: ctx.memberId, deviceId: ctx.deviceId, online: false, status: 'offline' });
    noContent(res);
  },
);

r.get('/organizations', { auth: 'agent', summary: 'Organizations of the signed-in user', ids: 'DESK-02' }, async (req, res) => {
  const orgs = activeOrgs(await listUserOrganizations(req.ctx.userId));
  ok(res, orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, roleName: o.roleName, current: o.id === req.ctx.orgId })));
});

r.post(
  '/organizations/select',
  {
    auth: 'agent',
    summary: 'Switch the device to another organization (issues a new device token)',
    ids: 'DESK-02',
    body: z.strictObject({ organizationId: z.uuid(), device: deviceSchema }),
  },
  async (req, res) => {
    const user = await db.one('SELECT * FROM users WHERE id = $1', [req.ctx.userId]);
    await assertVersionSupported(req.body.device.os, req.body.device.appVersion);
    const out = await issueDeviceSession(req, user, req.body.organizationId, req.body.device);
    if (req.body.organizationId !== req.ctx.orgId) await db.query('UPDATE device_tokens SET revoked_at = now() WHERE id = $1', [req.ctx.deviceTokenId]);
    ok(res, out);
  },
);

// ─── Config, selection lists, timer ─────────────────────────────────────────
r.get('/config', { auth: 'agent', summary: 'Effective tracking configuration, consent and indicator rules', ids: 'DESK-09, SS-02, SS-03, SS-P1, SS-P2, SS-P4' }, async (req, res) => {
  ok(res, await buildAgentConfig(req.ctx.orgId, req.ctx.memberId));
});

r.get('/projects', { auth: 'agent', summary: 'Projects the member is assigned to', ids: 'DESK-03' }, async (req, res) => {
  const ids = await memberProjectIds(req.ctx);
  const rows = ids.length
    ? await db.many(
        `SELECT p.id, p.name, p.color, p.code, p.status, c.name AS client_name FROM projects p LEFT JOIN clients c ON c.id = p.client_id
         WHERE p.id = ANY($1::uuid[]) AND p.organization_id = $2 AND p.deleted_at IS NULL AND p.archived_at IS NULL
           AND p.status NOT IN ('completed','cancelled') ORDER BY lower(p.name)`,
        [ids, req.ctx.orgId],
      )
    : [];
  ok(res, rows.map((p) => ({ id: p.id, name: p.name, code: p.code, color: p.color, status: p.status, clientName: p.client_name })));
});

r.get(
  '/tasks',
  { auth: 'agent', summary: 'Open tasks assigned to the member', ids: 'DESK-04', query: z.object({ projectId: z.uuid().optional() }) },
  async (req, res) => {
    const ids = await memberProjectIds(req.ctx);
    const rows = await db.many(
      `SELECT t.id, t.title, t.project_id, t.priority, t.due_date, p.name AS project_name
       FROM tasks t JOIN task_assignees a ON a.task_id = t.id AND a.member_id = $1 JOIN projects p ON p.id = t.project_id
       WHERE t.organization_id = $2 AND t.deleted_at IS NULL AND t.completed_at IS NULL AND p.deleted_at IS NULL AND p.archived_at IS NULL
         AND t.project_id = ANY($3::uuid[]) AND ($4::uuid IS NULL OR t.project_id = $4)
       ORDER BY t.due_date NULLS LAST, lower(t.title) LIMIT 500`,
      [req.ctx.memberId, req.ctx.orgId, ids, req.v.query.projectId ?? null],
    );
    ok(res, rows.map((t) => ({ id: t.id, title: t.title, projectId: t.project_id, projectName: t.project_name, priority: t.priority, dueDate: t.due_date })));
  },
);

r.get('/timer', { auth: 'agent', summary: 'Current timer', ids: 'DESK-07' }, async (req, res) => {
  ok(res, await currentTimer(req.ctx.memberId));
});

r.get('/today', { auth: 'agent', summary: "Today's worked time", ids: 'DESK-08' }, async (req, res) => {
  const tz = await memberTimezone(req.ctx.memberId);
  const { date } = await db.one(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS date`, [tz]);
  const s = await recomputeDailySummary(req.ctx.memberId, date);
  const timer = await currentTimer(req.ctx.memberId);
  ok(res, {
    date,
    timezone: tz,
    trackedSeconds: s?.tracked_seconds ?? 0,
    activeSeconds: s?.active_seconds ?? 0,
    idleSeconds: s?.idle_seconds ?? 0,
    breakSeconds: s?.break_seconds ?? 0,
    activityPercent: s?.activity_percent ?? 0,
    screenshotCount: s?.screenshot_count ?? 0,
    timer,
  });
});

const startBody = z.strictObject({
  projectId: z.uuid().nullable().optional(),
  taskId: z.uuid().nullable().optional(),
  note: z.string().max(2000).optional(),
  entryType: z.enum(['work', 'meeting']).optional(),
});
const timerOpts = (req) => ({
  projectId: req.body.projectId ?? undefined,
  taskId: req.body.taskId ?? undefined,
  note: req.body.note,
  entryType: req.body.entryType,
  source: 'desktop',
  deviceId: req.ctx.deviceId,
});

r.post('/timer/start', { auth: 'agent', permission: 'timer.use', summary: 'Start timer', ids: 'DESK-05', body: startBody }, async (req, res) => {
  created(res, await startTimer(req.ctx, timerOpts(req)));
});
r.post('/timer/switch', { auth: 'agent', permission: 'timer.use', summary: 'Switch task', ids: 'DESK-05, TIME-07', body: startBody }, async (req, res) => {
  created(res, await switchTimer(req.ctx, timerOpts(req)));
});
r.post('/timer/pause', { auth: 'agent', permission: 'timer.use', summary: 'Pause timer', ids: 'DESK-06', body: z.strictObject({}) }, async (req, res) => {
  ok(res, await pauseTimer(req.ctx, { reason: 'manual' }));
});
r.post('/timer/resume', { auth: 'agent', permission: 'timer.use', summary: 'Resume timer', ids: 'DESK-06', body: z.strictObject({}) }, async (req, res) => {
  ok(res, await resumeTimer(req.ctx, {}));
});
r.post(
  '/timer/stop',
  { auth: 'agent', permission: 'timer.use', summary: 'Stop timer', ids: 'DESK-05, DESK-26', body: z.strictObject({ note: z.string().max(2000).optional() }) },
  async (req, res) => {
    ok(res, await stopTimer(req.ctx, { note: req.body.note }));
  },
);

// ─── Heartbeat / presence (DESK-09, DESK-17, DESK-23, SYNC-09) ──────────────
r.post(
  '/heartbeat',
  {
    auth: 'agent',
    summary: 'Presence heartbeat',
    ids: 'DESK-09, DESK-17, DESK-23, SYNC-09',
    body: z.strictObject({
      status: z.enum(['active', 'idle', 'paused', 'offline']),
      activityPercent: z.number().int().min(0).max(100).optional(),
      currentApp: z.string().max(200).nullable().optional(),
      pendingCount: z.number().int().min(0).max(10_000_000).default(0),
      appVersion: z.string().trim().max(30),
      online: z.boolean().optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    const online = b.status !== 'offline' && b.online !== false;
    const dev = await db.one(
      `UPDATE devices SET last_seen_at = now(), online = $2, pending_count = $3, app_version = $4 WHERE id = $1 RETURNING os`,
      [ctx.deviceId, online, b.pendingCount, b.appVersion],
    );
    await db.query('UPDATE organization_members SET last_seen_at = now() WHERE id = $1', [ctx.memberId]);
    const settings = await memberSettings(ctx.orgId, ctx.memberId);
    const timer = await currentTimer(ctx.memberId);
    emitToLive(ctx.orgId, 'presence.updated', {
      memberId: ctx.memberId,
      deviceId: ctx.deviceId,
      status: b.status,
      online,
      activityPercent: settings.activityTrackingEnabled ? (b.activityPercent ?? null) : null,
      currentApp: settings.appTrackingEnabled ? (b.currentApp ?? null) : null,
      timerRunning: !!timer && !timer.pause,
      at: new Date().toISOString(),
    });
    const min = await minSupportedRelease(dev?.os);
    ok(res, {
      serverTime: new Date().toISOString(),
      timer,
      upgradeRequired: !!(min && cmpVersion(b.appVersion, min.version) < 0),
      configVersion: (await buildAgentConfig(ctx.orgId, ctx.memberId)).configVersion,
    });
  },
);

// ─── Ingestion ──────────────────────────────────────────────────────────────
const ingestResponse = (results) => ({ ...summarize(results), results });

r.post(
  '/activity',
  { auth: 'agent', summary: 'Batch activity samples (counts only, never keystrokes)', ids: 'ACT-01, ACT-02, ACT-03, ACT-04, ACT-05, DESK-11', body: z.strictObject({ samples: z.array(activitySample).min(1).max(500) }) },
  async (req, res) => {
    const ic = ingestCtx(req.ctx);
    const settings = await memberSettings(ic.orgId, ic.memberId);
    if (!settings.activityTrackingEnabled) throw new AppError(422, 'TRACKING_DISABLED', 'Activity tracking is disabled for you');
    ok(res, ingestResponse(await ingestActivity(ic, req.body.samples, { settings })));
  },
);

r.post(
  '/app-usage',
  { auth: 'agent', summary: 'Batch application usage', ids: 'APP-01, APP-03, APP-24, DESK-13', body: z.strictObject({ items: z.array(appUsageItem).min(1).max(500) }) },
  async (req, res) => {
    const ic = ingestCtx(req.ctx);
    const settings = await memberSettings(ic.orgId, ic.memberId);
    if (!settings.appTrackingEnabled) throw new AppError(422, 'TRACKING_DISABLED', 'Application tracking is disabled for you');
    ok(res, ingestResponse(await ingestAppUsage(ic, req.body.items, { settings })));
  },
);

r.post(
  '/web-usage',
  { auth: 'agent', summary: 'Batch website usage', ids: 'APP-02, APP-04, APP-05, APP-06, APP-07, APP-08, APP-25, PRIV-05, DESK-14', body: z.strictObject({ items: z.array(webUsageItem).min(1).max(500) }) },
  async (req, res) => {
    const ic = ingestCtx(req.ctx);
    const settings = await memberSettings(ic.orgId, ic.memberId);
    if (!settings.websiteTrackingEnabled) throw new AppError(422, 'TRACKING_DISABLED', 'Website tracking is disabled for you');
    ok(res, ingestResponse(await ingestWebUsage(ic, req.body.items, { settings })));
  },
);

r.post(
  '/idle',
  { auth: 'agent', summary: 'Idle periods (auto-pause & idle alerts)', ids: 'DESK-12, TIME-21, ACT-16, BRK-*', body: z.strictObject({ periods: z.array(idleItem).min(1).max(100) }) },
  async (req, res) => {
    ok(res, ingestResponse(await ingestIdle(ingestCtx(req.ctx), req.body.periods, { live: true })));
  },
);

r.post(
  '/screenshots/upload-url',
  {
    auth: 'agent',
    summary: 'Signed upload URL for a screenshot (only while tracking with consent)',
    ids: 'SS-01, DESK-10, SS-P4, SYNC-03',
    body: z.strictObject({
      contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      size: z.number().int().min(1).max(15 * 1024 * 1024),
      capturedAt: zTs.optional(),
    }),
  },
  async (req, res) => {
    const ic = ingestCtx(req.ctx);
    await assertScreenshotAllowed(ic, { capturedAt: req.body.capturedAt });
    await assertStorageAvailable(ic.orgId, req.body.size);
    const up = await createUpload({
      orgId: ic.orgId,
      purpose: 'screenshot',
      contentType: req.body.contentType,
      size: req.body.size,
      userId: ic.userId,
      allowedTypes: ['image/png', 'image/jpeg', 'image/webp'],
    });
    created(res, up);
  },
);

r.post(
  '/screenshots',
  { auth: 'agent', summary: 'Register an uploaded screenshot', ids: 'SS-01, SS-08, SS-18, SS-19, SS-20, SS-21, SS-22, SS-27', body: screenshotItem },
  async (req, res) => {
    const [out] = await ingestScreenshots(ingestCtx(req.ctx), [req.body]);
    if (out.status === 'error') {
      const status = out.code === 'FILE_NOT_UPLOADED' ? 400 : out.code === 'CONSENT_REQUIRED' ? 403 : 422;
      throw new AppError(status, out.code ?? 'SCREENSHOT_REJECTED', out.message);
    }
    (out.status === 'ok' ? created : ok)(res, out);
  },
);

// ─── Offline sync (SYNC-01…12) ──────────────────────────────────────────────
r.post(
  '/sync',
  {
    auth: 'agent',
    summary: 'Offline batch sync with checksum → per-item results (idempotent)',
    ids: 'SYNC-01, SYNC-03, SYNC-04, SYNC-05, SYNC-06, SYNC-07, SYNC-08, SYNC-11, SYNC-12, DESK-15, DESK-16',
    middleware: (req, _res, next) => {
      req.rawItemsJson = req.body && typeof req.body === 'object' && 'items' in req.body ? JSON.stringify(req.body.items) : '';
      next();
    },
    body: syncBody,
  },
  async (req, res) => {
    ok(res, await processSyncBatch(ingestCtx(req.ctx), req.body, req.rawItemsJson));
  },
);

r.get('/sync/status', { auth: 'agent', summary: 'Server-side sync state of this device', ids: 'SYNC-09, SYNC-10, SYNC-12' }, async (req, res) => {
  const d = await db.one('SELECT * FROM devices WHERE id = $1', [req.ctx.deviceId]);
  const batches = await db.many(
    `SELECT batch_uuid, received_at, item_counts FROM sync_batches WHERE device_id = $1 ORDER BY received_at DESC LIMIT 10`,
    [req.ctx.deviceId],
  );
  const conflicts = await db.one(`SELECT count(*)::int AS n FROM sync_conflicts WHERE device_id = $1 AND status = 'open'`, [req.ctx.deviceId]);
  ok(res, {
    deviceId: d.id,
    lastSyncAt: d.last_sync_at,
    lastSeenAt: d.last_seen_at,
    pendingCount: d.pending_count,
    openConflicts: conflicts.n,
    recentBatches: batches.map((b) => ({ batchUuid: b.batch_uuid, receivedAt: b.received_at, itemCounts: b.item_counts })),
    serverTime: new Date().toISOString(),
  });
});

// ─── Notifications & updates ────────────────────────────────────────────────
r.get(
  '/notifications',
  { auth: 'agent', summary: 'Desktop notification payloads since a timestamp', ids: 'DESK-19', query: z.object({ since: zTs.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
  async (req, res) => {
    const since = req.v.query.since ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    const rows = await db.many(
      `SELECT id, type, title, body, data, link, read_at, created_at FROM notifications
       WHERE recipient_user_id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND 'desktop' = ANY(channels_sent) AND created_at > $3
       ORDER BY created_at ASC LIMIT $4`,
      [req.ctx.userId, req.ctx.orgId, since, req.v.query.limit],
    );
    ok(res, rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, link: n.link, readAt: n.read_at, createdAt: n.created_at })));
  },
);

r.get(
  '/releases/latest',
  {
    auth: 'public',
    summary: 'Latest desktop release for auto-update',
    ids: 'DESK-21, DESK-22',
    query: z.object({ os: z.enum(['windows', 'macos', 'linux']), channel: z.enum(['stable', 'beta']).default('stable'), currentVersion: z.string().max(30).optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    const latest = await latestRelease(q.os, q.channel);
    if (!latest) throw notFound('Release');
    const min = await minSupportedRelease(q.os);
    ok(res, {
      os: latest.os,
      channel: latest.channel,
      version: latest.version,
      url: latest.url,
      sha256: latest.sha256,
      releaseNotes: latest.release_notes,
      publishedAt: latest.published_at,
      minSupportedVersion: min?.version ?? null,
      updateAvailable: q.currentVersion ? cmpVersion(q.currentVersion, latest.version) < 0 : undefined,
      updateRequired: q.currentVersion && min ? cmpVersion(q.currentVersion, min.version) < 0 : undefined,
    });
  },
);

export default r;
