import { z } from 'zod';
import { createRouter, zTimezone, zCurrency, zColor, zTime, zMoney } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, noContent, camel } from '../../lib/http.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { createUpload, assertUploaded, signedGetUrl, deleteObject } from '../../lib/storage.js';
import { audit, diff } from '../../lib/audit.js';
import { verifyPassword } from '../../lib/password.js';

const r = createRouter('/organization', 'Organization');

const orgDto = (o) => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  logoKey: o.logo_key,
  logoUrl: signedGetUrl(o.logo_key, { ttl: 3600 }),
  brandColor: o.brand_color,
  industry: o.industry,
  size: o.size,
  timezone: o.timezone,
  currency: o.default_currency,
  dateFormat: o.date_format,
  timeFormat: o.time_format,
  weekStart: o.week_start,
  country: o.country,
  address: o.address,
  status: o.status,
  ownerUserId: o.owner_user_id,
  createdAt: o.created_at,
});

r.get('/', { summary: 'Organization profile', ids: 'AUTH-12, SET-O01…O06', permission: 'organization.view' }, async (req, res) => {
  const o = await db.one('SELECT * FROM organizations WHERE id = $1', [req.ctx.orgId]);
  const s = await db.one('SELECT working_days, work_start, work_end FROM organization_settings WHERE organization_id = $1', [req.ctx.orgId]);
  ok(res, { ...orgDto(o), workingDays: s.working_days, workStart: s.work_start, workEnd: s.work_end });
});

r.patch(
  '/',
  {
    summary: 'Update organization profile & regional settings',
    ids: 'AUTH-12, AUTH-13, SET-O01…O08',
    permission: 'organization.update',
    body: z.object({
      name: z.string().trim().min(2).max(150).optional(),
      industry: z.string().max(80).nullable().optional(),
      size: z.string().max(20).nullable().optional(),
      timezone: zTimezone.optional(),
      currency: zCurrency.optional(),
      dateFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY', 'DD-MM-YYYY']).optional(),
      timeFormat: z.enum(['12h', '24h']).optional(),
      weekStart: z.number().int().min(0).max(6).optional(),
      country: z.string().length(2).nullable().optional(),
      address: z.record(z.string(), z.any()).nullable().optional(),
      brandColor: zColor.nullable().optional(),
      logoKey: z.string().max(300).nullable().optional(),
      workingDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      workStart: zTime.optional(),
      workEnd: zTime.optional(),
    }),
  },
  async (req, res) => {
    const b = req.body;
    const before = await db.one('SELECT * FROM organizations WHERE id = $1', [req.ctx.orgId]);
    if (b.logoKey) await assertUploaded(b.logoKey, { orgId: req.ctx.orgId, purpose: 'logo' });
    const map = { name: 'name', industry: 'industry', size: 'size', timezone: 'timezone', currency: 'default_currency', dateFormat: 'date_format', timeFormat: 'time_format', weekStart: 'week_start', country: 'country', address: 'address', brandColor: 'brand_color', logoKey: 'logo_key' };
    const sets = [];
    const params = [req.ctx.orgId];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      params.push(k === 'address' ? db.json(b[k]) : b[k]);
      sets.push(`${col} = $${params.length}`);
    }
    const o = sets.length
      ? await db.one(`UPDATE organizations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params)
      : before;
    if (b.workingDays || b.workStart || b.workEnd) {
      if (b.workStart && b.workEnd && b.workEnd <= b.workStart) throw badRequest('Work end must be after work start');
      await db.query(
        `UPDATE organization_settings SET working_days = coalesce($2, working_days), work_start = coalesce($3::time, work_start),
           work_end = coalesce($4::time, work_end), updated_at = now() WHERE organization_id = $1`,
        [req.ctx.orgId, b.workingDays ?? null, b.workStart ?? null, b.workEnd ?? null],
      );
    }
    if (b.logoKey !== undefined && before.logo_key && before.logo_key !== b.logoKey) await deleteObject(before.logo_key);
    const d = diff(orgDto(before), orgDto(o));
    if (d.changed) await audit(req.ctx, 'organization.updated', { entityType: 'organization', entityId: o.id, before: d.before, after: d.after });
    const s = await db.one('SELECT working_days, work_start, work_end FROM organization_settings WHERE organization_id = $1', [req.ctx.orgId]);
    ok(res, { ...orgDto(o), workingDays: s.working_days, workStart: s.work_start, workEnd: s.work_end });
  },
);

r.post(
  '/logo/upload-url',
  { summary: 'Signed upload URL for company logo', ids: 'AUTH-13, SET-O02', permission: 'organization.update', body: z.object({ contentType: z.string().max(100), size: z.number().int().positive() }) },
  async (req, res) => {
    ok(res, await createUpload({ orgId: req.ctx.orgId, purpose: 'logo', contentType: req.body.contentType, size: req.body.size, userId: req.ctx.userId, allowedTypes: ['image/'] }));
  },
);

// ─── Organization policy settings ────────────────────────────────────────────
const settingsMap = {
  workingDays: 'working_days',
  workStart: 'work_start',
  workEnd: 'work_end',
  activityLowMax: 'activity_low_max',
  activityModerateMax: 'activity_moderate_max',
  requireManualTimeApproval: 'require_manual_time_approval',
  allowEmployeeEditTime: 'allow_employee_edit_time',
  allowEmployeeDeleteTime: 'allow_employee_delete_time',
  overtimeMode: 'overtime_mode',
  overtimeMultiplier: 'overtime_multiplier',
  timesheetPeriod: 'timesheet_period',
  timesheetApprovalLevels: 'timesheet_approval_levels',
  timesheetLockAfterDays: 'timesheet_lock_after_days',
  attendanceAutoCheckin: 'attendance_auto_checkin',
  lateGraceMinutes: 'late_grace_minutes',
  earlyLeaveGraceMinutes: 'early_leave_grace_minutes',
  enforce2fa: 'enforce_2fa',
  sessionIdleTimeoutMinutes: 'session_idle_timeout_minutes',
  leaderboardVisibleToEmployees: 'leaderboard_visible_to_employees',
  productivityWeights: 'productivity_weights',
  defaultBillableRate: 'default_billable_rate',
  budgetAlertPercents: 'budget_alert_percents',
  dataRetentionDays: 'data_retention_days',
  activityRetentionDays: 'activity_retention_days',
  invoicePrefix: 'invoice_prefix',
};

export const settingsDto = (s) => Object.fromEntries(Object.entries(settingsMap).map(([k, col]) => [k, s[col]]));

r.get('/settings', { summary: 'Organization policy settings', ids: 'SET-O07, SET-O08, TIME-31, TIME-32, ACT thresholds', permission: 'organization.view' }, async (req, res) => {
  ok(res, settingsDto(await db.one('SELECT * FROM organization_settings WHERE organization_id = $1', [req.ctx.orgId])));
});

r.patch(
  '/settings',
  {
    summary: 'Update organization policy settings',
    ids: 'SET-O07, SET-O08, TIME-32, TS-15, TS-16, ATT-06, ATT-07, SEC-13, PERF-01',
    permission: 'organization.update',
    body: z
      .object({
        workingDays: z.array(z.number().int().min(0).max(6)).max(7),
        workStart: zTime,
        workEnd: zTime,
        activityLowMax: z.number().int().min(1).max(98),
        activityModerateMax: z.number().int().min(2).max(99),
        requireManualTimeApproval: z.boolean(),
        allowEmployeeEditTime: z.boolean(),
        allowEmployeeDeleteTime: z.boolean(),
        overtimeMode: z.enum(['daily', 'weekly', 'both', 'none']),
        overtimeMultiplier: z.number().min(1).max(5),
        timesheetPeriod: z.enum(['week', 'biweek', 'month']),
        timesheetApprovalLevels: z.number().int().min(1).max(3),
        timesheetLockAfterDays: z.number().int().min(1).max(365).nullable(),
        attendanceAutoCheckin: z.boolean(),
        lateGraceMinutes: z.number().int().min(0).max(240),
        earlyLeaveGraceMinutes: z.number().int().min(0).max(240),
        enforce2fa: z.boolean(),
        sessionIdleTimeoutMinutes: z.number().int().min(5).max(43200).nullable(),
        leaderboardVisibleToEmployees: z.boolean(),
        productivityWeights: z.object({ activity: z.number().min(0).max(1), productive: z.number().min(0).max(1), tasks: z.number().min(0).max(1) }),
        defaultBillableRate: zMoney.nullable(),
        budgetAlertPercents: z.array(z.number().int().min(1).max(200)).max(5),
        dataRetentionDays: z.number().int().min(30).max(3650).nullable(),
        activityRetentionDays: z.number().int().min(30).max(3650).nullable(),
        invoicePrefix: z.string().max(10),
      })
      .partial(),
  },
  async (req, res) => {
    const b = req.body;
    const before = await db.one('SELECT * FROM organization_settings WHERE organization_id = $1', [req.ctx.orgId]);
    const low = b.activityLowMax ?? before.activity_low_max;
    const mod = b.activityModerateMax ?? before.activity_moderate_max;
    if (low >= mod) throw badRequest('activityLowMax must be lower than activityModerateMax');
    if (b.productivityWeights) {
      const sum = b.productivityWeights.activity + b.productivityWeights.productive + b.productivityWeights.tasks;
      if (Math.abs(sum - 1) > 0.001) throw badRequest('Productivity weights must sum to 1');
    }
    const sets = [];
    const params = [req.ctx.orgId];
    for (const [k, col] of Object.entries(settingsMap)) {
      if (b[k] === undefined) continue;
      params.push(k === 'productivityWeights' ? db.json(b[k]) : b[k]);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) return ok(res, settingsDto(before));
    const s = await db.one(`UPDATE organization_settings SET ${sets.join(', ')}, updated_at = now() WHERE organization_id = $1 RETURNING *`, params);
    const d = diff(settingsDto(before), settingsDto(s));
    if (d.changed) await audit(req.ctx, 'organization.settings_updated', { entityType: 'organization', entityId: req.ctx.orgId, before: d.before, after: d.after });
    ok(res, settingsDto(s));
  },
);

// ─── Ownership transfer & deletion (owner only) ─────────────────────────────
r.post(
  '/transfer-ownership',
  { summary: 'Transfer ownership to another active member', ids: 'RBAC-09', roles: ['owner'], body: z.object({ memberId: z.uuid(), password: z.string().optional() }) },
  async (req, res) => {
    const u = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.ctx.userId]);
    if (u.password_hash && !(await verifyPassword(u.password_hash, req.body.password ?? ''))) throw forbidden('Password is incorrect', 'REAUTH_FAILED');
    const target = await db.one(`SELECT * FROM organization_members WHERE id = $1 AND organization_id = $2 AND status = 'active' AND deleted_at IS NULL`, [req.body.memberId, req.ctx.orgId]);
    if (!target) throw notFound('Member');
    if (target.id === req.ctx.memberId) throw badRequest('You are already the owner');
    const roles = await db.many(`SELECT id, slug FROM roles WHERE organization_id = $1 AND slug IN ('owner','admin')`, [req.ctx.orgId]);
    const ownerRole = roles.find((x) => x.slug === 'owner').id;
    const adminRole = roles.find((x) => x.slug === 'admin').id;
    await db.tx(async () => {
      await db.query('UPDATE organization_members SET role_id = $2, updated_at = now() WHERE id = $1', [target.id, ownerRole]);
      await db.query('UPDATE organization_members SET role_id = $2, updated_at = now() WHERE id = $1', [req.ctx.memberId, adminRole]);
      await db.query('UPDATE organizations SET owner_user_id = $2 WHERE id = $1', [req.ctx.orgId, target.user_id]);
    });
    await audit(req.ctx, 'organization.ownership_transferred', { entityType: 'organization', entityId: req.ctx.orgId, after: { newOwnerMemberId: target.id } });
    noContent(res);
  },
);

r.delete(
  '/',
  { summary: 'Delete organization (owner only, soft delete)', ids: 'AUTH-11', roles: ['owner'], body: z.object({ confirmName: z.string(), password: z.string().optional() }) },
  async (req, res) => {
    const o = await db.one('SELECT name FROM organizations WHERE id = $1', [req.ctx.orgId]);
    if (req.body.confirmName !== o.name) throw badRequest('Organization name does not match', undefined, 'CONFIRMATION_MISMATCH');
    const u = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.ctx.userId]);
    if (u.password_hash && !(await verifyPassword(u.password_hash, req.body.password ?? ''))) throw forbidden('Password is incorrect', 'REAUTH_FAILED');
    await db.query(`UPDATE organizations SET deleted_at = now(), status = 'suspended' WHERE id = $1`, [req.ctx.orgId]);
    await db.query(`UPDATE sessions SET organization_id = NULL WHERE organization_id = $1`, [req.ctx.orgId]);
    await audit(req.ctx, 'organization.deleted', { entityType: 'organization', entityId: req.ctx.orgId });
    noContent(res);
  },
);

export default r;
export { orgDto, camel };
