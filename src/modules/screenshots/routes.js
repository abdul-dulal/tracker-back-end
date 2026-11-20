import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, dateStr } from '../../lib/http.js';
import { notFound, forbidden } from '../../lib/errors.js';
import { signedGetUrl } from '../../lib/storage.js';
import { enqueue } from '../../lib/jobs.js';
import { audit } from '../../lib/audit.js';
import { accessibleMemberIds } from '../../rbac/scope.js';
import { getOrgPlan } from '../subscription/features.js';
import { getEffectiveSettings } from '../settings/effective.js';
import { memberTimezone, recomputeRange } from '../time/summary-service.js';
import { getThresholds, activityLevel, pct, assertCanSeeMember, ACTIVITY_NOTE } from '../activity/service.js';
import { SHOT_SELECT, screenshotDto, visibleKeys, deleteScreenshotObjects, bumpScreenshotCounter, screenshotFilter } from './service.js';

/** Screenshot gallery, timeline, detail, download, delete, export, storage (guide §M06, SS-*). */
const r = createRouter('/screenshots', 'Screenshots');

const filterQuery = z.object({
  memberId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  taskId: z.uuid().optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  activityLevel: z.enum(['low', 'moderate', 'high']).optional(),
});

async function loadShot(ctx, id, perm = 'screenshots.view') {
  const row = await db.one(`${SHOT_SELECT} WHERE s.id = $1 AND s.organization_id = $2 AND s.deleted_at IS NULL`, [id, ctx.orgId]);
  if (!row) throw notFound('Screenshot');
  if (row.member_id !== ctx.memberId) {
    const ids = ctx.can(perm) ? await accessibleMemberIds(ctx, perm) : [ctx.memberId];
    if (ids && !ids.includes(row.member_id)) throw notFound('Screenshot');
  }
  return row;
}

r.get(
  '/',
  { summary: 'Screenshot gallery', ids: 'SS-09, SS-12, SS-21, SS-23, SS-26, SS-P3', query: paginationQuery.extend(filterQuery.shape) },
  async (req, res) => {
    const q = req.v.query;
    const w = await screenshotFilter(req.ctx, q);
    const total = (await db.one(`SELECT count(*)::int AS n FROM screenshots s ${w.sql}`, w.params)).n;
    const dir = q.order === 'asc' ? 'ASC' : 'DESC';
    const rows = await db.many(`${SHOT_SELECT} ${w.sql} ORDER BY s.captured_at ${dir}, s.monitor_index LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, w.params);
    const th = await getThresholds(req.ctx.orgId);
    ok(res, rows.map((s) => screenshotDto(s, req.ctx.memberId, th)), pageMeta(q, total));
  },
);

r.get(
  '/timeline',
  { summary: 'Screenshot timeline in 10-minute slots per hour with activity', ids: 'SS-10, ACT-06', query: z.object({ memberId: z.uuid().optional(), date: dateStr }) },
  async (req, res) => {
    const ctx = req.ctx;
    const memberId = req.v.query.memberId ?? ctx.memberId;
    await assertCanSeeMember(ctx, 'screenshots.view', memberId);
    const tz = await memberTimezone(memberId);
    const win = await db.one(`SELECT ($1::date::timestamp AT TIME ZONE $2) AS ws, (($1::date + 1)::timestamp AT TIME ZONE $2) AS we`, [req.v.query.date, tz]);
    const shots = await db.many(
      `${SHOT_SELECT} WHERE s.organization_id = $1 AND s.member_id = $2 AND s.deleted_at IS NULL AND s.captured_at >= $3 AND s.captured_at < $4
       ORDER BY s.captured_at, s.monitor_index`,
      [ctx.orgId, memberId, win.ws, win.we],
    );
    const acts = await db.many(
      `SELECT floor(extract(epoch FROM (interval_start - $3::timestamptz)) / 600)::int AS slot,
              sum(active_seconds)::int AS active, sum(interval_seconds)::int AS total
       FROM activity_samples WHERE organization_id = $1 AND member_id = $2 AND interval_start >= $3 AND interval_start < $4 GROUP BY 1`,
      [ctx.orgId, memberId, win.ws, win.we],
    );
    const th = await getThresholds(ctx.orgId);
    const slots = new Map();
    const slotOf = (n) => {
      if (!slots.has(n)) slots.set(n, { slot: n, screenshots: [], activeSeconds: 0, trackedSeconds: 0 });
      return slots.get(n);
    };
    const ws = new Date(win.ws).getTime();
    for (const s of shots) slotOf(Math.floor((new Date(s.captured_at).getTime() - ws) / 600_000)).screenshots.push(screenshotDto(s, ctx.memberId, th));
    for (const a of acts) Object.assign(slotOf(a.slot), { activeSeconds: a.active, trackedSeconds: a.total });
    const hours = new Map();
    for (const s of [...slots.values()].sort((a, b) => a.slot - b.slot)) {
      const hour = Math.floor(s.slot / 6);
      if (!hours.has(hour)) hours.set(hour, { hour, slots: Array.from({ length: 6 }, (_, i) => ({ index: i, startsAt: new Date(ws + (hour * 6 + i) * 600_000).toISOString(), screenshots: [], activityPercent: null, activityLevel: null })) });
      const p = s.trackedSeconds ? pct(s.activeSeconds, s.trackedSeconds) : null;
      Object.assign(hours.get(hour).slots[s.slot % 6], { screenshots: s.screenshots, activityPercent: p, activityLevel: activityLevel(p, th), trackedSeconds: s.trackedSeconds });
    }
    ok(res, { memberId, date: req.v.query.date, timezone: tz, hours: [...hours.values()], totalScreenshots: shots.length, note: ACTIVITY_NOTE });
  },
);

r.get(
  '/latest',
  { summary: 'Latest screenshots (dashboard)', ids: 'ADM-09', query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(12), teamId: z.uuid().optional(), memberId: z.uuid().optional() }) },
  async (req, res) => {
    const w = await screenshotFilter(req.ctx, req.v.query);
    const rows = await db.many(`${SHOT_SELECT} ${w.sql} ORDER BY s.captured_at DESC LIMIT ${req.v.query.limit}`, w.params);
    const th = await getThresholds(req.ctx.orgId);
    ok(res, rows.map((s) => screenshotDto(s, req.ctx.memberId, th)));
  },
);

r.get('/storage', { summary: 'Screenshot storage usage vs plan', ids: 'SS-17, SUB-18', permission: 'settings.tracking' }, async (req, res) => {
  const orgId = req.ctx.orgId;
  const plan = await getOrgPlan(orgId);
  const used = Number((await db.one(`SELECT value FROM usage_counters WHERE organization_id = $1 AND metric = 'storage_bytes'`, [orgId]))?.value ?? 0);
  const shots = await db.one(`SELECT count(*)::int AS n, coalesce(sum(size_bytes), 0)::bigint AS bytes FROM files WHERE organization_id = $1 AND purpose = 'screenshot'`, [orgId]);
  const count = await db.one(`SELECT count(*)::int AS n, min(captured_at) AS oldest FROM screenshots WHERE organization_id = $1 AND deleted_at IS NULL`, [orgId]);
  const limitGb = plan.limits?.storageGb ?? null;
  const limitBytes = limitGb === null ? null : limitGb * 1024 ** 3;
  const { settings } = await getEffectiveSettings(orgId, {});
  ok(res, {
    usedBytes: used,
    screenshotBytes: Number(shots.bytes),
    screenshotFiles: shots.n,
    screenshotCount: count.n,
    oldestCapturedAt: count.oldest,
    limitBytes,
    limitGb,
    percentUsed: limitBytes ? Math.round((used / limitBytes) * 1000) / 10 : null,
    retentionDays: settings.screenshotRetentionDays,
    planRetentionDays: plan.limits?.screenshotRetentionDays ?? null,
  });
});

r.post(
  '/export',
  { summary: 'Export screenshots as ZIP (background job)', ids: 'SS-25', permission: 'screenshots.export', body: z.strictObject({ filters: z.strictObject(filterQuery.shape).default({}) }) },
  async (req, res) => {
    const ctx = req.ctx;
    const f = req.body.filters;
    if (f.memberId) await assertCanSeeMember(ctx, 'screenshots.export', f.memberId);
    const memberIds = await accessibleMemberIds(ctx, 'screenshots.export');
    const w = await screenshotFilter(ctx, f, { memberIds });
    const n = (await db.one(`SELECT count(*)::int AS n FROM screenshots s ${w.sql}`, w.params)).n;
    const job = await db.one(
      `INSERT INTO export_jobs (organization_id, type, params, status, requested_by) VALUES ($1, 'screenshots', $2, 'queued', $3) RETURNING *`,
      [ctx.orgId, db.json({ filters: f, memberIds, timezone: ctx.timezone ?? 'UTC', viewerMemberId: ctx.memberId, viewerUserId: ctx.userId, count: n }), ctx.memberId],
    );
    await enqueue('screenshots.export', { exportJobId: job.id });
    created(res, { id: job.id, type: job.type, status: job.status, screenshotCount: n, createdAt: job.created_at });
  },
);

r.get('/:id', { summary: 'Screenshot detail with signed URLs (blurred if required)', ids: 'SS-08, SS-11, SS-12, SS-13, SS-16, SS-22', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const ctx = req.ctx;
  const row = await loadShot(ctx, req.v.params.id);
  const th = await getThresholds(ctx.orgId);
  const others = row.capture_group_id
    ? await db.many(
        `${SHOT_SELECT} WHERE s.organization_id = $1 AND s.capture_group_id = $2 AND s.id <> $3 AND s.member_id = $4 AND s.deleted_at IS NULL ORDER BY s.monitor_index`,
        [ctx.orgId, row.capture_group_id, row.id, row.member_id],
      )
    : [];
  ok(res, { ...screenshotDto(row, ctx.memberId, th), otherMonitors: others.map((s) => screenshotDto(s, ctx.memberId, th)) });
});

r.get('/:id/download', { summary: 'Signed download URL', ids: 'SS-14', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const ctx = req.ctx;
  const row = await db.one('SELECT * FROM screenshots WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [req.v.params.id, ctx.orgId]);
  if (!row) throw notFound('Screenshot');
  if (row.member_id !== ctx.memberId) {
    if (!ctx.can('screenshots.download')) throw forbidden('Missing permission: screenshots.download');
    const ids = await accessibleMemberIds(ctx, 'screenshots.download');
    if (ids && !ids.includes(row.member_id)) throw notFound('Screenshot');
  }
  const k = visibleKeys(row, ctx.memberId);
  if (!k.full) throw notFound('Screenshot file');
  const ext = k.full.split('.').pop();
  const filename = `screenshot-${new Date(row.captured_at).toISOString().replace(/[:.]/g, '-')}-m${row.monitor_index}.${ext}`;
  ok(res, { url: signedGetUrl(k.full, { download: true, filename }), filename, blurred: k.blurred, expiresInSeconds: 300 });
});

r.delete(
  '/:id',
  { summary: 'Delete a screenshot (and its stored objects)', ids: 'SS-15, SS-P5', params: z.object({ id: z.uuid() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const row = await db.one('SELECT * FROM screenshots WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [req.v.params.id, ctx.orgId]);
    if (!row) throw notFound('Screenshot');
    const scope = ctx.can('screenshots.delete');
    if (!scope) throw forbidden('Missing permission: screenshots.delete');
    if (scope === 'own') {
      if (row.member_id !== ctx.memberId) throw forbidden('You can only delete your own screenshots');
      const { settings } = await getEffectiveSettings(ctx.orgId, { memberId: row.member_id, projectId: row.project_id });
      if (!settings.allowEmployeeScreenshotDelete) throw forbidden('Your organization does not allow deleting screenshots', 'SCREENSHOT_DELETE_NOT_ALLOWED');
    } else {
      const ids = await accessibleMemberIds(ctx, 'screenshots.delete');
      if (ids && !ids.includes(row.member_id)) throw forbidden('You do not have access to this member');
    }
    await db.query('UPDATE screenshots SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [row.id, ctx.memberId]);
    await deleteScreenshotObjects(row);
    await bumpScreenshotCounter(ctx.orgId, -1);
    await audit(ctx, 'screenshot.delete', { entityType: 'screenshot', entityId: row.id, before: { memberId: row.member_id, capturedAt: row.captured_at } });
    await recomputeRange(row.member_id, row.captured_at, row.captured_at);
    noContent(res);
  },
);

export default r;
