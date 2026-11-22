import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { audit as writeAudit } from '../../lib/audit.js';
import { countActiveSeats } from '../subscription/features.js';
import { planDto } from '../subscription/routes-plans.js';
import { PLAN_CODES, PLAN_FEATURES, SCREENSHOT_INTERVALS } from '../subscription/catalog.js';
import { auditQuery, listAudit } from '../audit/routes.js';
import { intervalSql } from '../subscription/service.js';

/** Super Admin platform control (M21 / F.18). Every mutation is audited with actor_type 'super_admin'. */
const r = createRouter('/platform', 'Platform');
const S = { auth: 'super' };
const idParam = z.object({ id: z.uuid() });
const audit = (ctx, action, opts) => writeAudit({ ...ctx, actorType: 'super_admin', orgId: opts.orgId ?? null }, action, opts);
const like = (s) => `%${s.replace(/[%_\\]/g, '\\$&')}%`;
const n = (v) => (v === null || v === undefined ? null : Number(v));

r.get('/stats', { ...S, summary: 'Platform statistics', ids: 'ADM (platform)' }, async (_req, res) => {
  const orgs = await db.one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
            count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new_30d
     FROM organizations WHERE deleted_at IS NULL`,
  );
  const users = await db.one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE last_login_at > now() - interval '30 days')::int AS active_30d FROM users`,
  );
  const byPlan = await db.many(
    `SELECT p.code, s.status, count(*)::int AS n FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     JOIN organizations o ON o.id = s.organization_id AND o.deleted_at IS NULL GROUP BY p.code, s.status ORDER BY p.code`,
  );
  const mrr = await db.one(
    `SELECT coalesce(sum(CASE WHEN s.billing_interval = 'year' THEN p.price_year / 12 ELSE p.price_month END
              * CASE WHEN p.per_seat THEN s.seats ELSE 1 END), 0) AS mrr
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status IN ('active','past_due')`,
  );
  const subscriptionsByPlan = {};
  for (const row of byPlan) {
    subscriptionsByPlan[row.code] ??= { total: 0 };
    subscriptionsByPlan[row.code][row.status] = row.n;
    subscriptionsByPlan[row.code].total += row.n;
  }
  ok(res, {
    organizations: { total: orgs.total, active: orgs.active, suspended: orgs.suspended, newLast30Days: orgs.new_30d },
    users: { total: users.total, active: users.active, activeLast30Days: users.active_30d },
    subscriptionsByPlan,
    mrrEstimate: Math.round(Number(mrr.mrr) * 100) / 100,
    currency: 'USD',
  });
});

const ORG_SELECT = `SELECT o.id, o.name, o.slug, o.status, o.timezone, o.default_currency, o.country, o.created_at, o.owner_user_id,
    u.email AS owner_email, trim(u.first_name || ' ' || u.last_name) AS owner_name,
    s.status AS sub_status, s.billing_interval, s.trial_ends_at, s.current_period_end, s.cancel_at_period_end, s.seats, p.code AS plan_code,
    (SELECT count(*)::int FROM organization_members m WHERE m.organization_id = o.id AND m.deleted_at IS NULL AND m.status = 'active') AS member_count
  FROM organizations o LEFT JOIN users u ON u.id = o.owner_user_id
  LEFT JOIN subscriptions s ON s.organization_id = o.id LEFT JOIN plans p ON p.id = s.plan_id`;

const orgDto = (o) => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  status: o.status,
  timezone: o.timezone,
  currency: o.default_currency,
  country: o.country,
  owner: o.owner_user_id ? { id: o.owner_user_id, email: o.owner_email, name: o.owner_name } : null,
  memberCount: o.member_count,
  subscription: o.plan_code
    ? { plan: o.plan_code, status: o.sub_status, interval: o.billing_interval, seats: o.seats, trialEndsAt: o.trial_ends_at, currentPeriodEnd: o.current_period_end, cancelAtPeriodEnd: o.cancel_at_period_end }
    : null,
  createdAt: o.created_at,
});

r.get(
  '/organizations',
  { ...S, summary: 'Organizations', ids: 'ADM (platform)', query: paginationQuery.extend({ status: z.enum(['active', 'suspended']).optional(), plan: z.string().max(20).optional() }) },
  async (req, res) => {
    const q = req.v.query;
    const w = where();
    w.raw('o.deleted_at IS NULL');
    w.add('o.status = ?', q.status);
    w.add('p.code = ?', q.plan);
    if (q.search) w.add('(o.name ILIKE ? OR o.slug ILIKE ? OR u.email ILIKE ?)', like(q.search), like(q.search), like(q.search));
    const sort = { name: 'o.name', createdAt: 'o.created_at' }[q.sort] ?? 'o.created_at';
    const total = (await db.one(`SELECT count(*)::int AS n FROM (${ORG_SELECT} ${w.sql}) x`, w.params)).n;
    const rows = await db.many(`${ORG_SELECT} ${w.sql} ORDER BY ${sort} ${q.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, w.params);
    ok(res, rows.map(orgDto), pageMeta(q, total));
  },
);

async function loadOrg(id) {
  const o = await db.one(`${ORG_SELECT} WHERE o.id = $1 AND o.deleted_at IS NULL`, [id]);
  if (!o) throw notFound('Organization');
  return o;
}

r.get('/organizations/:id', { ...S, summary: 'Organization detail', ids: 'ADM (platform)', params: idParam }, async (req, res) => {
  const o = await loadOrg(req.v.params.id);
  const usage = await db.many('SELECT metric, value FROM usage_counters WHERE organization_id = $1', [o.id]);
  ok(res, {
    ...orgDto(o),
    seatsUsed: await countActiveSeats(o.id),
    usage: Object.fromEntries(usage.map((u) => [u.metric, Number(u.value)])),
  });
});

r.patch(
  '/organizations/:id',
  {
    ...S,
    summary: 'Suspend/activate, extend trial, change plan',
    ids: 'ADM (platform)',
    params: idParam,
    body: z
      .object({
        status: z.enum(['active', 'suspended']).optional(),
        extendTrialDays: z.number().int().min(1).max(365).optional(),
        planCode: z.enum(PLAN_CODES).optional(),
        interval: z.enum(['month', 'year']).optional(),
        reason: z.string().max(500).optional(),
      })
      .refine((b) => b.status || b.extendTrialDays || b.planCode, 'Nothing to change'),
  },
  async (req, res) => {
    const before = await loadOrg(req.v.params.id);
    const b = req.body;
    await db.tx(async () => {
      if (b.status) {
        await db.query('UPDATE organizations SET status = $2, updated_at = now() WHERE id = $1', [before.id, b.status]);
        if (b.status === 'suspended')
          await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'org_suspended' WHERE organization_id = $1 AND revoked_at IS NULL`, [before.id]);
      }
      if (b.extendTrialDays) {
        await db.query(
          `UPDATE subscriptions SET status = 'trialing', trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => $2::int),
             current_period_end = greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => $2::int), expiry_notice_sent_at = NULL, updated_at = now()
           WHERE organization_id = $1`,
          [before.id, b.extendTrialDays],
        );
      }
      if (b.planCode) {
        const plan = await db.one('SELECT id FROM plans WHERE code = $1', [b.planCode]);
        const interval = b.interval ?? before.billing_interval ?? 'month';
        await db.query(
          `UPDATE subscriptions SET plan_id = $2, billing_interval = $3, pending_plan_id = NULL, pending_interval = NULL,
             status = CASE WHEN status IN ('expired','canceled') THEN 'active' ELSE status END,
             current_period_start = CASE WHEN status IN ('expired','canceled') THEN now() ELSE current_period_start END,
             current_period_end = CASE WHEN status IN ('expired','canceled') THEN now() + ${intervalSql(interval)} ELSE current_period_end END,
             updated_at = now()
           WHERE organization_id = $1`,
          [before.id, plan.id, interval],
        );
      }
    });
    const after = await loadOrg(before.id);
    await audit(req.ctx, 'platform.organization.update', { orgId: before.id, entityType: 'organization', entityId: before.id, before: orgDto(before), after: { ...b, result: orgDto(after) } });
    ok(res, orgDto(after));
  },
);

const userDto = (u) => ({
  id: u.id,
  email: u.email,
  firstName: u.first_name,
  lastName: u.last_name,
  status: u.status,
  isSuperAdmin: u.is_super_admin,
  mfaEnabled: u.mfa_enabled,
  emailVerified: !!u.email_verified_at,
  lastLoginAt: u.last_login_at,
  organizationCount: u.org_count ?? undefined,
  createdAt: u.created_at,
});

r.get(
  '/users',
  { ...S, summary: 'Users', ids: 'ADM (platform)', query: paginationQuery.extend({ status: z.enum(['active', 'disabled']).optional() }) },
  async (req, res) => {
    const q = req.v.query;
    const w = where();
    w.add('u.status = ?', q.status);
    if (q.search) w.add(`(u.email ILIKE ? OR (u.first_name || ' ' || u.last_name) ILIKE ?)`, like(q.search), like(q.search));
    const total = (await db.one(`SELECT count(*)::int AS n FROM users u ${w.sql}`, w.params)).n;
    const rows = await db.many(
      `SELECT u.*, (SELECT count(*)::int FROM organization_members m WHERE m.user_id = u.id AND m.deleted_at IS NULL) AS org_count
       FROM users u ${w.sql} ORDER BY u.created_at ${q.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      w.params,
    );
    ok(res, rows.map(userDto), pageMeta(q, total));
  },
);

r.patch(
  '/users/:id',
  {
    ...S,
    summary: 'Disable/enable a user, revoke sessions',
    ids: 'ADM (platform)',
    params: idParam,
    body: z
      .object({ status: z.enum(['active', 'disabled']).optional(), revokeSessions: z.boolean().optional(), isSuperAdmin: z.boolean().optional() })
      .refine((b) => b.status || b.revokeSessions || b.isSuperAdmin !== undefined, 'Nothing to change'),
  },
  async (req, res) => {
    const before = await db.one('SELECT * FROM users WHERE id = $1', [req.v.params.id]);
    if (!before) throw notFound('User');
    const b = req.body;
    if (before.id === req.ctx.userId && (b.status === 'disabled' || b.isSuperAdmin === false))
      throw badRequest('You cannot disable or demote yourself', undefined, 'SELF_ACTION');
    let revoked = 0;
    await db.tx(async () => {
      if (b.status) await db.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [before.id, b.status]);
      if (b.isSuperAdmin !== undefined) await db.query('UPDATE users SET is_super_admin = $2, updated_at = now() WHERE id = $1', [before.id, b.isSuperAdmin]);
      if (b.revokeSessions || b.status === 'disabled') {
        revoked = (await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'platform_admin' WHERE user_id = $1 AND revoked_at IS NULL`, [before.id])).rowCount;
        await db.query(`UPDATE device_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [before.id]);
      }
    });
    const after = await db.one('SELECT * FROM users WHERE id = $1', [before.id]);
    await audit(req.ctx, 'platform.user.update', { entityType: 'user', entityId: before.id, before: userDto(before), after: { ...b, sessionsRevoked: revoked } });
    ok(res, { ...userDto(after), sessionsRevoked: revoked });
  },
);

// ─── Plans ───────────────────────────────────────────────────────────────────
const planFields = {
  name: z.string().trim().min(1).max(60),
  priceMonth: z.number().min(0).max(100000),
  priceYear: z.number().min(0).max(1000000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  perSeat: z.boolean(),
  stripePriceMonthId: z.string().max(100).nullable(),
  stripePriceYearId: z.string().max(100).nullable(),
  limits: z.object({
    maxSeats: z.number().int().min(1).nullable(),
    storageGb: z.number().min(0).nullable(),
    screenshotRetentionDays: z.number().int().min(1).nullable(),
    minScreenshotInterval: z.number().int().min(1).optional(),
  }).passthrough(),
  features: z.record(z.string(), z.boolean()),
  isPublic: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
};
const PLAN_COLS = {
  name: 'name',
  priceMonth: 'price_month',
  priceYear: 'price_year',
  currency: 'currency',
  perSeat: 'per_seat',
  stripePriceMonthId: 'stripe_price_month_id',
  stripePriceYearId: 'stripe_price_year_id',
  limits: 'limits',
  features: 'features',
  isPublic: 'is_public',
  sortOrder: 'sort_order',
};
const fullPlanDto = (p) => ({ ...planDto(p), stripePriceMonthId: p.stripe_price_month_id, stripePriceYearId: p.stripe_price_year_id });

r.get('/plans/catalog', { ...S, summary: 'Plan codes and feature flags the plan editor can use', ids: 'SUB-01…SUB-04' }, async (_req, res) => {
  ok(res, { codes: PLAN_CODES, features: PLAN_FEATURES, screenshotIntervals: SCREENSHOT_INTERVALS });
});

r.get('/plans', { ...S, summary: 'All plans (incl. hidden)', ids: 'SUB-01…SUB-04' }, async (_req, res) => {
  const rows = await db.many('SELECT * FROM plans ORDER BY sort_order');
  ok(res, rows.map(fullPlanDto));
});

r.post(
  '/plans',
  {
    ...S,
    summary: 'Create a plan',
    ids: 'SUB-01…SUB-04',
    body: z.object({
      code: z.enum(PLAN_CODES),
      ...planFields,
      currency: planFields.currency.default('USD'),
      perSeat: planFields.perSeat.default(true),
      stripePriceMonthId: planFields.stripePriceMonthId.optional(),
      stripePriceYearId: planFields.stripePriceYearId.optional(),
      isPublic: planFields.isPublic.default(true),
      sortOrder: planFields.sortOrder.default(0),
    }),
  },
  async (req, res) => {
    const b = req.body;
    const row = await db.one(
      `INSERT INTO plans (code, name, price_month, price_year, currency, per_seat, stripe_price_month_id, stripe_price_year_id, limits, features, is_public, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [b.code, b.name, b.priceMonth, b.priceYear, b.currency, b.perSeat, b.stripePriceMonthId ?? null, b.stripePriceYearId ?? null, db.json(b.limits), db.json(b.features), b.isPublic, b.sortOrder],
    );
    await audit(req.ctx, 'platform.plan.create', { entityType: 'plan', entityId: row.id, after: fullPlanDto(row) });
    created(res, fullPlanDto(row));
  },
);

r.patch(
  '/plans/:id',
  { ...S, summary: 'Update a plan', ids: 'SUB-01…SUB-04, SUB-16', params: idParam, body: z.object(Object.fromEntries(Object.entries(planFields).map(([k, v]) => [k, v.optional()]))) },
  async (req, res) => {
    const before = await db.one('SELECT * FROM plans WHERE id = $1', [req.v.params.id]);
    if (!before) throw notFound('Plan');
    const sets = [];
    const params = [before.id];
    for (const [field, col] of Object.entries(PLAN_COLS)) {
      const v = req.body[field];
      if (v === undefined) continue;
      params.push(['limits', 'features'].includes(field) ? db.json(v) : v);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) throw badRequest('Nothing to update', undefined, 'NO_CHANGE');
    const row = await db.one(`UPDATE plans SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    await audit(req.ctx, 'platform.plan.update', { entityType: 'plan', entityId: row.id, before: fullPlanDto(before), after: fullPlanDto(row) });
    ok(res, fullPlanDto(row));
  },
);

r.get(
  '/subscriptions',
  {
    ...S,
    summary: 'Subscriptions overview',
    ids: 'SUB-21',
    query: paginationQuery.extend({ status: z.enum(['trialing', 'active', 'past_due', 'canceled', 'expired']).optional(), plan: z.string().max(20).optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    const w = where();
    w.add('s.status = ?', q.status);
    w.add('p.code = ?', q.plan);
    if (q.search) w.add('o.name ILIKE ?', like(q.search));
    const from = `FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN organizations o ON o.id = s.organization_id ${w.sql}`;
    const total = (await db.one(`SELECT count(*)::int AS n ${from}`, w.params)).n;
    const rows = await db.many(
      `SELECT s.*, p.code AS plan_code, p.price_month, p.price_year, p.per_seat, o.name AS org_name ${from}
       ORDER BY s.updated_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      w.params,
    );
    ok(
      res,
      rows.map((s) => ({
        id: s.id,
        organization: { id: s.organization_id, name: s.org_name },
        plan: s.plan_code,
        status: s.status,
        interval: s.billing_interval,
        seats: s.seats,
        trialEndsAt: s.trial_ends_at,
        currentPeriodEnd: s.current_period_end,
        cancelAtPeriodEnd: s.cancel_at_period_end,
        stripeSubscriptionId: s.stripe_subscription_id,
        mrr: ['active', 'past_due'].includes(s.status)
          ? Math.round((s.billing_interval === 'year' ? n(s.price_year) / 12 : n(s.price_month)) * (s.per_seat ? s.seats : 1) * 100) / 100
          : 0,
        updatedAt: s.updated_at,
      })),
      pageMeta(q, total),
    );
  },
);

r.get('/audit-logs', { ...S, summary: 'Platform audit log', ids: 'SEC-10', query: auditQuery.extend({ organizationId: z.uuid().optional() }) }, async (req, res) => {
  const q = req.v.query;
  const { rows, total } = await listAudit(q, {});
  ok(res, rows, pageMeta(q, total));
});

r.get(
  '/security-events',
  {
    ...S,
    summary: 'Security events',
    ids: 'SEC-23',
    query: paginationQuery.extend({ type: z.string().max(60).optional(), severity: z.enum(['info', 'warning', 'critical']).optional(), organizationId: z.uuid().optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    const w = where();
    w.add('e.type = ?', q.type);
    w.add('e.severity = ?', q.severity);
    w.add('e.organization_id = ?', q.organizationId);
    const total = (await db.one(`SELECT count(*)::int AS n FROM security_events e ${w.sql}`, w.params)).n;
    const rows = await db.many(
      `SELECT e.*, u.email FROM security_events e LEFT JOIN users u ON u.id = e.user_id ${w.sql} ORDER BY e.created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      w.params,
    );
    ok(
      res,
      rows.map((e) => ({ id: e.id, organizationId: e.organization_id, user: e.user_id ? { id: e.user_id, email: e.email } : null, type: e.type, severity: e.severity, data: e.data, ip: e.ip, createdAt: e.created_at })),
      pageMeta(q, total),
    );
  },
);

// ─── Desktop app releases (DESK-21/22) ───────────────────────────────────────
const releaseDto = (a) => ({
  id: a.id,
  os: a.os,
  channel: a.channel,
  version: a.version,
  url: a.url,
  sha256: a.sha256,
  minSupported: a.min_supported,
  releaseNotes: a.release_notes,
  publishedAt: a.published_at,
});

r.get(
  '/app-releases',
  { ...S, summary: 'Desktop app releases', ids: 'DESK-21, DESK-22', query: z.object({ os: z.enum(['windows', 'macos', 'linux']).optional(), channel: z.enum(['stable', 'beta']).optional() }) },
  async (req, res) => {
    const q = req.v.query;
    const w = where();
    w.add('os = ?', q.os);
    w.add('channel = ?', q.channel);
    ok(res, (await db.many(`SELECT * FROM app_releases ${w.sql} ORDER BY published_at DESC`, w.params)).map(releaseDto));
  },
);

r.post(
  '/app-releases',
  {
    ...S,
    summary: 'Publish a desktop app release',
    ids: 'DESK-21, DESK-22',
    body: z.object({
      os: z.enum(['windows', 'macos', 'linux']),
      channel: z.enum(['stable', 'beta']).default('stable'),
      version: z.string().regex(/^\d+\.\d+\.\d+([-+][\w.]+)?$/, 'Expected semver'),
      url: z.url().refine((u) => u.startsWith('https://'), 'https required'),
      sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      minSupported: z.boolean().default(false),
      releaseNotes: z.string().max(20000).optional(),
    }),
  },
  async (req, res) => {
    const b = req.body;
    const row = await db.one(
      `INSERT INTO app_releases (os, channel, version, url, sha256, min_supported, release_notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.os, b.channel, b.version, b.url, b.sha256?.toLowerCase() ?? null, b.minSupported, b.releaseNotes ?? null],
    );
    await audit(req.ctx, 'platform.app_release.create', { entityType: 'app_release', entityId: row.id, after: releaseDto(row) });
    created(res, releaseDto(row));
  },
);

r.delete('/app-releases/:id', { ...S, summary: 'Delete a release', ids: 'DESK-21', params: idParam }, async (req, res) => {
  const row = await db.one('DELETE FROM app_releases WHERE id = $1 RETURNING *', [req.v.params.id]);
  if (!row) throw notFound('Release');
  await audit(req.ctx, 'platform.app_release.delete', { entityType: 'app_release', entityId: row.id, before: releaseDto(row) });
  noContent(res);
});

r.get('/health', { ...S, summary: 'System health (db, job queue)', ids: 'ADM (platform)' }, async (_req, res) => {
  const t0 = Date.now();
  let database = 'ok';
  try {
    await db.one('SELECT 1 AS ok');
  } catch {
    database = 'error';
  }
  const latencyMs = Date.now() - t0;
  const jobs = await db.one(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'queued' AND run_at <= now())::int AS ready,
            count(*) FILTER (WHERE status = 'running')::int AS running,
            count(*) FILTER (WHERE status = 'failed' AND coalesce(finished_at, created_at) > now() - interval '24 hours')::int AS failed_24h,
            count(*) FILTER (WHERE status = 'failed')::int AS failed_total,
            extract(epoch FROM now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now()))::int AS oldest_ready_age
     FROM jobs`,
  );
  const failed = await db.many(`SELECT id, name, attempts, last_error, finished_at FROM jobs WHERE status = 'failed' ORDER BY finished_at DESC NULLS LAST LIMIT 10`);
  const crons = await db.many('SELECT name, last_run_at FROM cron_runs ORDER BY name');
  const pendingWebhooks = (await db.one(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'pending'`)).n;
  const status = database !== 'ok' ? 'down' : jobs.failed_24h > 0 || (jobs.oldest_ready_age ?? 0) > 600 ? 'degraded' : 'ok';
  ok(res, {
    status,
    database: { status: database, latencyMs, driver: db.kind },
    jobs: {
      queued: jobs.queued,
      ready: jobs.ready,
      running: jobs.running,
      failedLast24h: jobs.failed_24h,
      failedTotal: jobs.failed_total,
      oldestReadyAgeSeconds: jobs.oldest_ready_age ?? 0,
      recentFailures: failed.map((j) => ({ id: j.id, name: j.name, attempts: j.attempts, error: String(j.last_error ?? '').split('\n')[0].slice(0, 300), finishedAt: j.finished_at })),
    },
    crons: crons.map((c) => ({ name: c.name, lastRunAt: c.last_run_at })),
    webhooks: { pendingDeliveries: pendingWebhooks },
    process: { uptimeSeconds: Math.round(process.uptime()), memoryRssMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version },
    time: new Date().toISOString(),
  });
});

export default r;
