import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, noContent, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { emitToOrg } from '../../lib/realtime.js';
import { managedMemberIds } from '../../rbac/scope.js';
import { getOrgPlan } from '../subscription/features.js';
import { getEffectiveSettings, TRACKING_FIELDS } from './effective.js';
import { managedTeamIds } from '../teams/service.js';

/** M22 tracking settings (SET-T01…T12), privacy settings and consents (PRIV-01…PRIV-05). */
const tracking = createRouter('/tracking-settings', 'Settings');
const privacy = createRouter('/privacy-settings', 'Settings');
const consents = createRouter('/consents', 'Settings');

const SCOPE_TABLE = { team: 'teams', project: 'projects', member: 'organization_members' };

const trackingDto = (s) => {
  const out = { id: s.id, scopeType: s.scope_type, scopeId: s.scope_id, scopeName: s.scope_name ?? null };
  for (const [field, col] of Object.entries(TRACKING_FIELDS)) out[field] = s[col] ?? null;
  if (out.weeklyLimitHours !== null) out.weeklyLimitHours = Number(out.weeklyLimitHours);
  return { ...out, version: s.version, updatedAt: s.updated_at };
};

const SELECT = `
  SELECT s.*, CASE s.scope_type
      WHEN 'team' THEN (SELECT name FROM teams WHERE id = s.scope_id)
      WHEN 'project' THEN (SELECT name FROM projects WHERE id = s.scope_id)
      WHEN 'member' THEN (SELECT trim(u.first_name || ' ' || u.last_name) FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.id = s.scope_id)
      ELSE NULL END AS scope_name
  FROM tracking_settings s`;

/** Validate the scope target and the caller's scope of settings.tracking. */
async function assertScope(ctx, scopeType, scopeId) {
  const scope = ctx.require('settings.tracking');
  if (scopeType === 'org') {
    if (scopeId) throw badRequest('scopeId must be empty for org scope', [{ path: 'scopeId', message: 'Must be empty' }], 'VALIDATION_ERROR');
    if (scope !== 'org') throw forbidden('Organization-wide settings require org scope');
    return;
  }
  if (!scopeId) throw badRequest(`scopeId is required for ${scopeType} scope`, [{ path: 'scopeId', message: 'Required' }], 'VALIDATION_ERROR');
  const row = await db.one(
    `SELECT 1 FROM ${SCOPE_TABLE[scopeType]} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [scopeId, ctx.orgId],
  );
  if (!row) throw notFound(scopeType[0].toUpperCase() + scopeType.slice(1));
  if (scope === 'org') return;
  if (scopeType === 'team' && (await managedTeamIds(ctx)).includes(scopeId)) return;
  if (scopeType === 'member' && (await managedMemberIds(ctx)).includes(scopeId)) return;
  throw forbidden('This scope is outside your permission');
}

tracking.get(
  '/',
  {
    summary: 'Tracking settings at a scope (or all overrides)',
    ids: 'SET-T01…SET-T12',
    permission: 'settings.tracking',
    query: z.object({ scopeType: z.enum(['org', 'team', 'project', 'member']).optional(), scopeId: z.uuid().optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    if (q.scopeType) {
      await assertScope(req.ctx, q.scopeType, q.scopeId ?? null);
      const row = await db.one(
        `${SELECT} WHERE s.organization_id = $1 AND s.scope_type = $2 AND s.scope_id IS NOT DISTINCT FROM $3::uuid`,
        [req.ctx.orgId, q.scopeType, q.scopeId ?? null],
      );
      return ok(res, row ? trackingDto(row) : null);
    }
    const rows = await db.many(`${SELECT} WHERE s.organization_id = $1 ORDER BY array_position(ARRAY['org','team','project','member'], s.scope_type), scope_name`, [req.ctx.orgId]);
    const plan = await getOrgPlan(req.ctx.orgId);
    ok(res, rows.map(trackingDto), {
      planLimits: { minScreenshotInterval: plan.limits?.minScreenshotInterval ?? 3, screenshotRetentionDays: plan.limits?.screenshotRetentionDays ?? null },
    });
  },
);

const nullable = (s) => s.nullable().optional();
const fieldsSchema = {
  screenshotsEnabled: nullable(z.boolean()),
  screenshotIntervalMinutes: nullable(z.union([z.literal(3), z.literal(5), z.literal(10), z.literal(15)])),
  screenshotRandom: nullable(z.boolean()),
  screenshotBlur: nullable(z.boolean()),
  screenshotRetentionDays: nullable(z.number().int().min(1).max(3650)),
  allowEmployeeScreenshotDelete: nullable(z.boolean()),
  captureWindowTitles: nullable(z.boolean()),
  notifyOnCapture: nullable(z.boolean()),
  activityTrackingEnabled: nullable(z.boolean()),
  appTrackingEnabled: nullable(z.boolean()),
  websiteTrackingEnabled: nullable(z.boolean()),
  trackFullUrl: nullable(z.boolean()),
  idleThresholdMinutes: nullable(z.number().int().min(1).max(120)),
  autoPauseMinutes: nullable(z.number().int().min(1).max(240)),
  weeklyLimitHours: nullable(z.number().min(1).max(168)),
  limitMode: nullable(z.enum(['warn', 'block'])),
};

/** Enforce plan limits (SUB-19): min screenshot interval and max retention. */
async function assertPlanLimits(orgId, b) {
  const plan = await getOrgPlan(orgId);
  const minInt = plan.limits?.minScreenshotInterval;
  if (b.screenshotIntervalMinutes && minInt && b.screenshotIntervalMinutes < minInt)
    throw unprocessable('PLAN_LIMIT', `Your plan allows a screenshot interval of at least ${minInt} minutes`, { field: 'screenshotIntervalMinutes', min: minInt });
  const maxRet = plan.limits?.screenshotRetentionDays;
  if (b.screenshotRetentionDays && maxRet && b.screenshotRetentionDays > maxRet)
    throw unprocessable('PLAN_LIMIT', `Your plan keeps screenshots for at most ${maxRet} days`, { field: 'screenshotRetentionDays', max: maxRet });
}

/** Upsert a tracking settings row (only provided fields change; null = inherit). Returns { before, after }. */
export async function upsertTrackingSettings(ctx, scopeType, scopeId, b) {
  await assertPlanLimits(ctx.orgId, b);
  const provided = Object.keys(TRACKING_FIELDS).filter((f) => b[f] !== undefined);
  return db.tx(async () => {
    const before = await db.one(
      `SELECT * FROM tracking_settings WHERE organization_id = $1 AND scope_type = $2 AND scope_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
      [ctx.orgId, scopeType, scopeId],
    );
    let id;
    if (before) {
      id = before.id;
      const params = [id];
      const sets = provided.map((f) => {
        params.push(b[f]);
        return `${TRACKING_FIELDS[f]} = $${params.length}`;
      });
      await db.query(`UPDATE tracking_settings SET ${[...sets, 'version = version + 1', 'updated_at = now()'].join(', ')} WHERE id = $1`, params);
    } else {
      const cols = ['organization_id', 'scope_type', 'scope_id', ...provided.map((f) => TRACKING_FIELDS[f])];
      const vals = [ctx.orgId, scopeType, scopeId, ...provided.map((f) => b[f])];
      id = (await db.one(`INSERT INTO tracking_settings (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals)).id;
    }
    const after = await db.one(`${SELECT} WHERE s.id = $1`, [id]);
    return { before, after };
  });
}

tracking.put(
  '/',
  {
    summary: 'Upsert tracking settings at a scope (null field = inherit)',
    ids: 'SET-T01…SET-T12, SS-05, SS-06, SUB-19',
    permission: 'settings.tracking',
    body: z.object({ scopeType: z.enum(['org', 'team', 'project', 'member']), scopeId: z.uuid().nullable().optional(), ...fieldsSchema }),
  },
  async (req, res) => {
    const b = req.body;
    const scopeId = b.scopeType === 'org' ? null : (b.scopeId ?? null);
    if (b.scopeType === 'org' && b.scopeId) throw badRequest('scopeId must be empty for org scope', [{ path: 'body.scopeId', message: 'Must be empty' }], 'VALIDATION_ERROR');
    await assertScope(req.ctx, b.scopeType, scopeId);
    const { before, after } = await upsertTrackingSettings(req.ctx, b.scopeType, scopeId, b);
    await audit(req.ctx, 'tracking_settings.updated', { entityType: 'tracking_settings', entityId: after.id, before: before ? trackingDto(before) : null, after: trackingDto(after) });
    emitToOrg(req.ctx.orgId, 'settings.updated', { kind: 'tracking', scopeType: b.scopeType, scopeId, version: after.version });
    ok(res, trackingDto(after));
  },
);

tracking.get(
  '/effective',
  { summary: 'Effective (merged) tracking settings for a member/project', ids: 'SET-T11, SET-T12, SS-07', query: z.object({ memberId: z.uuid().optional(), projectId: z.uuid().optional() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const memberId = req.v.query.memberId ?? ctx.memberId;
    const projectId = req.v.query.projectId;
    if (memberId !== ctx.memberId) {
      const scope = ctx.can('settings.tracking');
      if (!scope) throw forbidden('Missing permission: settings.tracking');
      if (scope !== 'org' && !(await managedMemberIds(ctx)).includes(memberId)) throw forbidden('You do not have access to this member');
    }
    if (memberId && !(await db.one('SELECT 1 FROM organization_members WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [memberId, ctx.orgId]))) throw notFound('Member');
    if (projectId && !(await db.one('SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [projectId, ctx.orgId]))) throw notFound('Project');
    const eff = await getEffectiveSettings(ctx.orgId, { memberId, projectId });
    ok(res, { memberId: memberId ?? null, projectId: projectId ?? null, ...eff });
  },
);

tracking.get('/:id', { summary: 'Tracking settings row', ids: 'SET-T01…SET-T12', permission: 'settings.tracking', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const row = await db.one(`${SELECT} WHERE s.id = $1 AND s.organization_id = $2`, [req.v.params.id, req.ctx.orgId]);
  if (!row) throw notFound('Tracking settings');
  await assertScope(req.ctx, row.scope_type, row.scope_id);
  ok(res, trackingDto(row));
});

tracking.delete('/:id', { summary: 'Remove an override (scope inherits again)', ids: 'SET-T11, SET-T12', permission: 'settings.tracking', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const row = await db.one(`${SELECT} WHERE s.id = $1 AND s.organization_id = $2`, [req.v.params.id, req.ctx.orgId]);
  if (!row) throw notFound('Tracking settings');
  if (row.scope_type === 'org') throw conflict('ORG_SETTINGS_REQUIRED', 'Organization defaults cannot be removed; update them instead');
  await assertScope(req.ctx, row.scope_type, row.scope_id);
  await db.query('DELETE FROM tracking_settings WHERE id = $1', [row.id]);
  await audit(req.ctx, 'tracking_settings.deleted', { entityType: 'tracking_settings', entityId: row.id, before: trackingDto(row) });
  emitToOrg(req.ctx.orgId, 'settings.updated', { kind: 'tracking', scopeType: row.scope_type, scopeId: row.scope_id, removed: true });
  noContent(res);
});

// ─── Privacy settings (PRIV-01, PRIV-04, PRIV-05) ──────────────────────────
async function privacyDto(orgId) {
  const s = await db.one(
    `SELECT consent_policy_version, consent_policy_text, data_retention_days, activity_retention_days, updated_at FROM organization_settings WHERE organization_id = $1`,
    [orgId],
  );
  const t = await db.one(`SELECT * FROM tracking_settings WHERE organization_id = $1 AND scope_type = 'org'`, [orgId]);
  const plan = await getOrgPlan(orgId);
  const counts = await db.one(
    `SELECT count(*)::int AS total, count(c.id)::int AS accepted FROM organization_members m JOIN roles r ON r.id = m.role_id
     LEFT JOIN consents c ON c.member_id = m.id AND c.policy_version = $2
     WHERE m.organization_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL AND r.base_role <> 'client'`,
    [orgId, s.consent_policy_version],
  );
  return {
    consentPolicyVersion: s.consent_policy_version,
    consentPolicyText: s.consent_policy_text,
    dataRetentionDays: s.data_retention_days,
    activityRetentionDays: s.activity_retention_days,
    screenshotRetentionDays: t?.screenshot_retention_days ?? null,
    captureWindowTitles: t?.capture_window_titles ?? null,
    trackFullUrl: t?.track_full_url ?? null,
    screenshotBlur: t?.screenshot_blur ?? null,
    allowEmployeeScreenshotDelete: t?.allow_employee_screenshot_delete ?? null,
    showIndicator: true, // PRIV-02: always visible, cannot be disabled
    planMaxScreenshotRetentionDays: plan.limits?.screenshotRetentionDays ?? null,
    consent: { total: counts.total, accepted: counts.accepted, pending: counts.total - counts.accepted },
    updatedAt: s.updated_at,
  };
}

privacy.get('/', { summary: 'Privacy settings (consent policy, retention, capture options)', ids: 'PRIV-01…PRIV-05', permission: 'settings.privacy' }, async (req, res) => {
  ok(res, await privacyDto(req.ctx.orgId));
});

privacy.put(
  '/',
  {
    summary: 'Update privacy settings (changing the policy text bumps the consent version)',
    ids: 'PRIV-01, PRIV-04, PRIV-05',
    permission: 'settings.privacy',
    body: z.object({
      consentPolicyText: z.string().trim().min(20).max(20000).optional(),
      dataRetentionDays: z.number().int().min(30).max(3650).nullable().optional(),
      activityRetentionDays: z.number().int().min(7).max(3650).nullable().optional(),
      screenshotRetentionDays: z.number().int().min(1).max(3650).optional(),
      captureWindowTitles: z.boolean().optional(),
      trackFullUrl: z.boolean().optional(),
      screenshotBlur: z.boolean().optional(),
      allowEmployeeScreenshotDelete: z.boolean().optional(),
    }),
  },
  async (req, res) => {
    req.ctx.require('settings.privacy', 'org');
    const b = req.body;
    const before = await privacyDto(req.ctx.orgId);
    const policyChanged = b.consentPolicyText !== undefined && b.consentPolicyText !== before.consentPolicyText;
    const trackingFields = ['screenshotRetentionDays', 'captureWindowTitles', 'trackFullUrl', 'screenshotBlur', 'allowEmployeeScreenshotDelete'].filter((f) => b[f] !== undefined);
    if (trackingFields.length) await assertPlanLimits(req.ctx.orgId, b);
    let trackingVersion = null;
    await db.tx(async () => {
      await db.query(
        `UPDATE organization_settings SET
           consent_policy_text = CASE WHEN $2::boolean THEN $3 ELSE consent_policy_text END,
           consent_policy_version = consent_policy_version + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
           data_retention_days = CASE WHEN $4::boolean THEN $5::int ELSE data_retention_days END,
           activity_retention_days = CASE WHEN $6::boolean THEN $7::int ELSE activity_retention_days END,
           updated_at = now()
         WHERE organization_id = $1`,
        [req.ctx.orgId, policyChanged, b.consentPolicyText ?? null, b.dataRetentionDays !== undefined, b.dataRetentionDays ?? null, b.activityRetentionDays !== undefined, b.activityRetentionDays ?? null],
      );
      if (trackingFields.length) {
        const { after } = await upsertTrackingSettings(req.ctx, 'org', null, Object.fromEntries(trackingFields.map((f) => [f, b[f]])));
        trackingVersion = after.version;
      }
    });
    const after = await privacyDto(req.ctx.orgId);
    await audit(req.ctx, 'privacy_settings.updated', {
      entityType: 'organization',
      entityId: req.ctx.orgId,
      before: { ...before, consent: undefined, consentPolicyText: policyChanged ? before.consentPolicyText : undefined },
      after: { ...after, consent: undefined, consentPolicyText: policyChanged ? after.consentPolicyText : undefined },
    });
    if (policyChanged) emitToOrg(req.ctx.orgId, 'consent.required', { policyVersion: after.consentPolicyVersion });
    emitToOrg(req.ctx.orgId, 'settings.updated', { kind: 'privacy', consentPolicyVersion: after.consentPolicyVersion, ...(trackingVersion ? { scopeType: 'org', version: trackingVersion } : {}) });
    ok(res, after);
  },
);

// ─── Consents (PRIV-01) ─────────────────────────────────────────────────────
consents.get(
  '/',
  {
    summary: 'Who has / has not accepted the current tracking policy',
    ids: 'PRIV-01',
    permission: 'settings.privacy',
    query: paginationQuery.extend({ status: z.enum(['accepted', 'pending']).optional(), teamId: z.uuid().optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    const ctx = req.ctx;
    const version = (await db.one('SELECT consent_policy_version FROM organization_settings WHERE organization_id = $1', [ctx.orgId])).consent_policy_version;
    const w = where([ctx.orgId, version]).raw(`m.organization_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL AND r.base_role <> 'client'`);
    if (ctx.can('settings.privacy') !== 'org') w.add('m.id = ANY(?::uuid[])', await managedMemberIds(ctx));
    if (q.status === 'accepted') w.raw('c.id IS NOT NULL');
    if (q.status === 'pending') w.raw('c.id IS NULL');
    if (q.teamId) w.add('m.id IN (SELECT member_id FROM team_members WHERE team_id = ?)', q.teamId);
    if (q.search) w.add(`(u.first_name || ' ' || u.last_name ILIKE ? OR u.email ILIKE ?)`, `%${q.search}%`, `%${q.search}%`);
    const base = `FROM organization_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
      LEFT JOIN consents c ON c.member_id = m.id AND c.policy_version = $2 ${w.sql}`;
    const total = (await db.one(`SELECT count(*)::int AS n ${base}`, w.params)).n;
    const rows = await db.many(
      `SELECT m.id, u.email, trim(u.first_name || ' ' || u.last_name) AS name, c.accepted_at, c.ip::text AS ip, c.features,
              (SELECT max(policy_version) FROM consents c2 WHERE c2.member_id = m.id) AS last_version
       ${base} ORDER BY c.accepted_at DESC NULLS FIRST, lower(u.first_name) LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      w.params,
    );
    ok(
      res,
      rows.map((x) => ({
        member: { id: x.id, name: x.name, email: x.email },
        status: x.accepted_at ? 'accepted' : 'pending',
        acceptedAt: x.accepted_at,
        ip: x.ip,
        features: x.features,
        lastAcceptedVersion: x.last_version,
      })),
      { ...pageMeta(q, total), policyVersion: version },
    );
  },
);

export default [tracking, privacy, consents];
