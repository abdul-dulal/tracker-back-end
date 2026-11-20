import { z } from 'zod';
import { createRouter, zBool, zTime, zTimezone } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, uuidParam } from '../../lib/http.js';
import { notFound, forbidden, badRequest } from '../../lib/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { hashPassword } from '../../lib/password.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { runReport } from './engine.js';
import {
  definitionSchema, formatSchema, recipientsSchema, savedReportDto, getAccessibleSavedReport, computeNextRun,
} from './service.js';

// ───────────────────────── Saved reports (RPT-A12) ─────────────────────────
const saved = createRouter('/saved-reports', 'Reports');

saved.get(
  '/',
  {
    summary: 'List saved reports (own + shared in organization)',
    ids: 'RPT-A12',
    permission: 'reports.custom',
    feature: 'customReports',
    query: paginationQuery.extend({ reportType: z.string().max(40).optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const params = [ctx.orgId, ctx.memberId, q.reportType ?? null, q.search ? `%${q.search}%` : null];
    const cond = `organization_id = $1 AND (owner_member_id = $2 OR is_shared_in_org) AND ($3::text IS NULL OR report_type = $3)
                  AND ($4::text IS NULL OR name ILIKE $4)`;
    const total = (await db.one(`SELECT count(*)::int AS n FROM saved_reports WHERE ${cond}`, params)).n;
    const rows = await db.many(
      `SELECT * FROM saved_reports WHERE ${cond} ORDER BY updated_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      params,
    );
    ok(res, rows.map(savedReportDto), pageMeta(q, total));
  },
);

saved.post(
  '/',
  {
    summary: 'Save a custom report definition',
    ids: 'RPT-A12',
    permission: 'reports.custom',
    feature: 'customReports',
    body: z.object({ name: z.string().trim().min(1).max(150), definition: definitionSchema, isSharedInOrg: z.boolean().default(false) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    const row = await db.one(
      `INSERT INTO saved_reports (organization_id, name, report_type, definition, owner_member_id, is_shared_in_org)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ctx.orgId, b.name, b.definition.reportType, db.json(b.definition), ctx.memberId, b.isSharedInOrg],
    );
    created(res, savedReportDto(row));
  },
);

saved.get(
  '/:id',
  { summary: 'Get a saved report', ids: 'RPT-A12', permission: 'reports.custom', feature: 'customReports', params: uuidParam },
  async (req, res) => {
    ok(res, savedReportDto(await getAccessibleSavedReport(req.ctx, req.v.params.id)));
  },
);

saved.get(
  '/:id/run',
  { summary: 'Run a saved report', ids: 'RPT-A12', permission: 'reports.custom', feature: 'customReports', params: uuidParam },
  async (req, res) => {
    const r = await getAccessibleSavedReport(req.ctx, req.v.params.id);
    ok(res, await runReport(req.ctx, definitionSchema.parse(r.definition)));
  },
);

async function ownedSavedReport(ctx, id) {
  const r = await getAccessibleSavedReport(ctx, id);
  if (r.owner_member_id !== ctx.memberId && !ctx.isAdminLike()) throw forbidden('Only the owner can change this report');
  return r;
}

saved.patch(
  '/:id',
  {
    summary: 'Update a saved report (owner or admin)',
    ids: 'RPT-A12',
    permission: 'reports.custom',
    feature: 'customReports',
    params: uuidParam,
    body: z.object({
      name: z.string().trim().min(1).max(150).optional(),
      definition: definitionSchema.optional(),
      isSharedInOrg: z.boolean().optional(),
    }),
  },
  async (req, res) => {
    const cur = await ownedSavedReport(req.ctx, req.v.params.id);
    const b = req.body;
    const row = await db.one(
      `UPDATE saved_reports SET name = coalesce($2, name), definition = coalesce($3::jsonb, definition),
         report_type = coalesce($4, report_type), is_shared_in_org = coalesce($5, is_shared_in_org), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [cur.id, b.name ?? null, b.definition ? db.json(b.definition) : null, b.definition?.reportType ?? null, b.isSharedInOrg ?? null],
    );
    ok(res, savedReportDto(row));
  },
);

saved.delete(
  '/:id',
  { summary: 'Delete a saved report (owner or admin)', ids: 'RPT-A12', permission: 'reports.custom', feature: 'customReports', params: uuidParam },
  async (req, res) => {
    const cur = await ownedSavedReport(req.ctx, req.v.params.id);
    await db.query('DELETE FROM saved_reports WHERE id = $1', [cur.id]);
    noContent(res);
  },
);

// ───────────────────────── Report schedules (RPT-A14) ─────────────────────────
const sched = createRouter('/report-schedules', 'Reports');

const scheduleDto = (s) => ({
  id: s.id,
  savedReportId: s.saved_report_id,
  savedReportName: s.saved_report_name,
  frequency: s.frequency,
  dayOfWeek: s.day_of_week,
  dayOfMonth: s.day_of_month,
  timeOfDay: String(s.time_of_day).slice(0, 5),
  timezone: s.timezone,
  format: s.format,
  recipients: s.recipients,
  active: s.active,
  lastRunAt: s.last_run_at,
  nextRunAt: s.next_run_at,
  createdBy: s.created_by,
  createdAt: s.created_at,
});

const scheduleFields = {
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  dayOfMonth: z.number().int().min(1).max(28).nullable(),
  timeOfDay: zTime,
  timezone: zTimezone,
  format: formatSchema,
  recipients: recipientsSchema,
  active: z.boolean(),
};

function checkScheduleShape(s) {
  if (s.frequency === 'weekly' && (s.dayOfWeek === null || s.dayOfWeek === undefined)) throw badRequest('dayOfWeek is required for weekly schedules');
  if (s.frequency === 'monthly' && (s.dayOfMonth === null || s.dayOfMonth === undefined)) throw badRequest('dayOfMonth is required for monthly schedules');
}

async function getSchedule(ctx, id) {
  const s = await db.one(
    `SELECT s.*, r.name AS saved_report_name FROM report_schedules s JOIN saved_reports r ON r.id = s.saved_report_id
     WHERE s.id = $1 AND s.organization_id = $2`,
    [id, ctx.orgId],
  );
  if (!s || (s.created_by !== ctx.memberId && !ctx.isAdminLike())) throw notFound('Report schedule');
  return s;
}

sched.get(
  '/',
  { summary: 'List report schedules', ids: 'RPT-A14', permission: 'reports.schedule', feature: 'scheduledReports', query: paginationQuery },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const params = [ctx.orgId, ctx.isAdminLike() ? null : ctx.memberId];
    const cond = 's.organization_id = $1 AND ($2::uuid IS NULL OR s.created_by = $2)';
    const total = (await db.one(`SELECT count(*)::int AS n FROM report_schedules s WHERE ${cond}`, params)).n;
    const rows = await db.many(
      `SELECT s.*, r.name AS saved_report_name FROM report_schedules s JOIN saved_reports r ON r.id = s.saved_report_id
       WHERE ${cond} ORDER BY s.next_run_at LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      params,
    );
    ok(res, rows.map(scheduleDto), pageMeta(q, total));
  },
);

sched.post(
  '/',
  {
    summary: 'Schedule a saved report to be emailed daily/weekly/monthly',
    ids: 'RPT-A14,RPT-A15',
    permission: 'reports.schedule',
    feature: 'scheduledReports',
    body: z.object({
      savedReportId: z.uuid(),
      ...scheduleFields,
      dayOfWeek: scheduleFields.dayOfWeek.optional(),
      dayOfMonth: scheduleFields.dayOfMonth.optional(),
      timeOfDay: zTime.default('08:00'),
      timezone: zTimezone.optional(),
      format: formatSchema.default('pdf'),
      active: z.boolean().default(true),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    checkScheduleShape(b);
    await getAccessibleSavedReport(ctx, b.savedReportId);
    const tz = b.timezone ?? ctx.timezone ?? 'UTC';
    const next = await computeNextRun({ ...b, timezone: tz });
    const row = await db.one(
      `INSERT INTO report_schedules (organization_id, saved_report_id, frequency, day_of_week, day_of_month, time_of_day, timezone, format,
         recipients, next_run_at, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [ctx.orgId, b.savedReportId, b.frequency, b.dayOfWeek ?? null, b.dayOfMonth ?? null, b.timeOfDay, tz, b.format, b.recipients, next, b.active, ctx.memberId],
    );
    created(res, scheduleDto(await getSchedule(ctx, row.id)));
  },
);

sched.get(
  '/:id',
  { summary: 'Get a report schedule', ids: 'RPT-A14', permission: 'reports.schedule', feature: 'scheduledReports', params: uuidParam },
  async (req, res) => ok(res, scheduleDto(await getSchedule(req.ctx, req.v.params.id))),
);

sched.patch(
  '/:id',
  {
    summary: 'Update a report schedule (recomputes next run)',
    ids: 'RPT-A14',
    permission: 'reports.schedule',
    feature: 'scheduledReports',
    params: uuidParam,
    body: z.object(Object.fromEntries(Object.entries(scheduleFields).map(([k, v]) => [k, v.optional()]))),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const cur = await getSchedule(ctx, req.v.params.id);
    const b = req.body;
    const merged = {
      frequency: b.frequency ?? cur.frequency,
      dayOfWeek: b.dayOfWeek !== undefined ? b.dayOfWeek : cur.day_of_week,
      dayOfMonth: b.dayOfMonth !== undefined ? b.dayOfMonth : cur.day_of_month,
      timeOfDay: b.timeOfDay ?? String(cur.time_of_day).slice(0, 5),
      timezone: b.timezone ?? cur.timezone,
      format: b.format ?? cur.format,
      recipients: b.recipients ?? cur.recipients,
      active: b.active ?? cur.active,
    };
    checkScheduleShape(merged);
    const next = await computeNextRun(merged);
    await db.query(
      `UPDATE report_schedules SET frequency = $2, day_of_week = $3, day_of_month = $4, time_of_day = $5, timezone = $6, format = $7,
         recipients = $8, active = $9, next_run_at = $10 WHERE id = $1`,
      [cur.id, merged.frequency, merged.dayOfWeek, merged.dayOfMonth, merged.timeOfDay, merged.timezone, merged.format, merged.recipients, merged.active, next],
    );
    ok(res, scheduleDto(await getSchedule(ctx, cur.id)));
  },
);

sched.delete(
  '/:id',
  { summary: 'Delete a report schedule', ids: 'RPT-A14', permission: 'reports.schedule', feature: 'scheduledReports', params: uuidParam },
  async (req, res) => {
    const cur = await getSchedule(req.ctx, req.v.params.id);
    await db.query('DELETE FROM report_schedules WHERE id = $1', [cur.id]);
    noContent(res);
  },
);

// ───────────────────────── Report shares (RPT-A16) ─────────────────────────
const shares = createRouter('/report-shares', 'Reports');

const shareDto = (s) => ({
  id: s.id,
  name: s.name,
  savedReportId: s.saved_report_id,
  definition: s.definition_snapshot,
  hasPassword: !!s.password_hash,
  clientId: s.client_id,
  expiresAt: s.expires_at,
  revokedAt: s.revoked_at,
  active: !s.revoked_at && (!s.expires_at || new Date(s.expires_at) > new Date()),
  viewCount: s.view_count,
  createdBy: s.created_by,
  createdAt: s.created_at,
});

shares.post(
  '/',
  {
    summary: 'Create a shareable read-only report link (token shown once)',
    ids: 'RPT-A16',
    permission: 'reports.share',
    body: z
      .object({
        savedReportId: z.uuid().optional(),
        definition: definitionSchema.optional(),
        name: z.string().trim().min(1).max(150).optional(),
        expiresAt: z.iso.datetime({ offset: true }).optional(),
        password: z.string().min(4).max(128).optional(),
        clientId: z.uuid().optional(),
      })
      .refine((b) => !!b.savedReportId !== !!b.definition, 'Provide exactly one of savedReportId or definition'),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    let definition = b.definition;
    let name = b.name;
    if (b.savedReportId) {
      const sr = await getAccessibleSavedReport(ctx, b.savedReportId);
      definition = definitionSchema.parse(sr.definition);
      name = name ?? sr.name;
    }
    if (b.expiresAt && new Date(b.expiresAt) <= new Date()) throw badRequest('expiresAt must be in the future');
    if (b.clientId) {
      if (!['time', 'projects', 'tasks', 'screenshots'].includes(definition.reportType))
        throw badRequest('Client shares support only time, projects, tasks and screenshots reports');
      definition = { ...definition, filters: { ...(definition.filters ?? {}), clientIds: [b.clientId] } };
      const cl = await db.one('SELECT id FROM clients WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [b.clientId, ctx.orgId]);
      if (!cl) throw notFound('Client');
    }
    // Validate the definition runs for the creator before sharing it.
    await runReport(ctx, definition);
    const token = `rs_${randomToken(24)}`;
    const row = await db.one(
      `INSERT INTO report_shares (organization_id, saved_report_id, definition_snapshot, name, token_hash, password_hash, client_id, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        ctx.orgId, b.savedReportId ?? null, db.json(definition), name ?? `${definition.reportType} report`, sha256(token),
        b.password ? await hashPassword(b.password) : null, b.clientId ?? null, b.expiresAt ?? null, ctx.memberId,
      ],
    );
    await audit(ctx, 'report_share.create', { entityType: 'report_share', entityId: row.id, after: { name: row.name, expiresAt: row.expires_at } });
    created(res, { ...shareDto(row), token, url: `${env.FRONTEND_URL}/shared/reports/${token}` });
  },
);

shares.get(
  '/',
  {
    summary: 'List report share links',
    ids: 'RPT-A16',
    permission: 'reports.share',
    query: paginationQuery.extend({ includeRevoked: zBool.default(false) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const params = [ctx.orgId, ctx.isAdminLike() ? null : ctx.memberId, q.includeRevoked];
    const cond = 'organization_id = $1 AND ($2::uuid IS NULL OR created_by = $2) AND ($3 OR revoked_at IS NULL)';
    const total = (await db.one(`SELECT count(*)::int AS n FROM report_shares WHERE ${cond}`, params)).n;
    const rows = await db.many(
      `SELECT * FROM report_shares WHERE ${cond} ORDER BY created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      params,
    );
    ok(res, rows.map(shareDto), pageMeta(q, total));
  },
);

shares.delete(
  '/:id',
  { summary: 'Revoke a share link', ids: 'RPT-A16', permission: 'reports.share', params: uuidParam },
  async (req, res) => {
    const ctx = req.ctx;
    const s = await db.one('SELECT * FROM report_shares WHERE id = $1 AND organization_id = $2', [req.v.params.id, ctx.orgId]);
    if (!s || (s.created_by !== ctx.memberId && !ctx.isAdminLike())) throw notFound('Report share');
    if (!s.revoked_at) await db.query('UPDATE report_shares SET revoked_at = now() WHERE id = $1', [s.id]);
    await audit(ctx, 'report_share.revoke', { entityType: 'report_share', entityId: s.id });
    noContent(res);
  },
);

export default [saved, sched, shares];
