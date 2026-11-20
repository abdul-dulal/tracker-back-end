import { z } from 'zod';
import { createRouter, zBool, zCsvUuids } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, uuidParam } from '../../lib/http.js';
import { notFound, forbidden, badRequest } from '../../lib/errors.js';
import { accessibleMemberIds, assertMemberAccess } from '../../rbac/scope.js';
import { rangeQuery, orgTimezone, resolveRange, todayIn, listMembers, round2 } from '../reports/common.js';
import { METRIC_NAMES, evaluateGoal, currentPeriod, memberMetrics, metricValue } from './service.js';

// ───────────────────────── Performance goals (PERF-17) ─────────────────────────
const goals = createRouter('/performance-goals', 'Performance');

/** Teams ctx may manage goals for (org scope → any team of the org). */
async function canManageTeam(ctx, teamId) {
  const t = await db.one('SELECT id FROM teams WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [teamId, ctx.orgId]);
  if (!t) throw notFound('Team');
  if (ctx.can('performance.view') === 'org') return true;
  const r = await db.one(
    `SELECT 1 FROM team_managers WHERE team_id = $1 AND member_id = $2 UNION SELECT 1 FROM team_members WHERE team_id = $1 AND member_id = $2 AND is_leader`,
    [teamId, ctx.memberId],
  );
  return !!r;
}

async function assertGoalTarget(ctx, scopeType, scopeId) {
  if (scopeType === 'member') {
    const m = await db.one('SELECT id FROM organization_members WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [scopeId, ctx.orgId]);
    if (!m) throw notFound('Member');
    await assertMemberAccess(ctx, 'performance.view', scopeId);
  } else if (!(await canManageTeam(ctx, scopeId))) throw forbidden('You cannot manage goals for this team');
}

/** Write access: managers (team/org scope) for their members & teams; employees only for their own member goals. */
async function assertGoalWrite(ctx, scopeType, scopeId) {
  await assertGoalTarget(ctx, scopeType, scopeId);
  if (ctx.can('performance.view') === 'own' && !(scopeType === 'member' && scopeId === ctx.memberId))
    throw forbidden('You can only manage your own goals');
}

async function goalDto(g, tz, today) {
  const p = currentPeriod(g.period, today);
  const ev = await evaluateGoal(g, p.from, p.to, tz);
  return {
    id: g.id,
    name: g.name,
    scopeType: g.scope_type,
    scopeId: g.scope_id,
    scopeName: g.scope_name ?? null,
    metric: g.metric,
    target: Number(g.target),
    comparator: g.comparator,
    period: g.period,
    active: g.active,
    createdBy: g.created_by,
    createdAt: g.created_at,
    progress: ev,
  };
}

const GOAL_SELECT = `SELECT g.*, CASE WHEN g.scope_type = 'team' THEN (SELECT name FROM teams WHERE id = g.scope_id)
  ELSE (SELECT trim(u.first_name || ' ' || u.last_name) FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.id = g.scope_id) END AS scope_name
  FROM performance_goals g`;

async function loadGoal(ctx, id) {
  const g = await db.one(`${GOAL_SELECT} WHERE g.id = $1 AND g.organization_id = $2`, [id, ctx.orgId]);
  if (!g) throw notFound('Goal');
  try {
    await assertGoalTarget(ctx, g.scope_type, g.scope_id);
  } catch {
    // Members may view goals of teams they belong to.
    const own = g.scope_type === 'team' && (await db.one('SELECT 1 FROM team_members WHERE team_id = $1 AND member_id = $2', [g.scope_id, ctx.memberId]));
    if (!own) throw notFound('Goal');
  }
  return g;
}

goals.get(
  '/',
  {
    summary: 'List performance goals with current-period progress',
    ids: 'PERF-17',
    permission: 'performance.view',
    query: z.object({ scopeType: z.enum(['member', 'team']).optional(), scopeId: z.uuid().optional(), active: zBool.optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const ids = await accessibleMemberIds(ctx, 'performance.view');
    let teamIds = null;
    if (ids) {
      // Teams the caller belongs to, leads or manages.
      teamIds = (await db.many(
        'SELECT team_id FROM team_members WHERE member_id = $1 UNION SELECT team_id FROM team_managers WHERE member_id = $1',
        [ctx.memberId],
      )).map((r) => r.team_id);
    }
    const rows = await db.many(
      `${GOAL_SELECT} WHERE g.organization_id = $1 AND ($2::text IS NULL OR g.scope_type = $2) AND ($3::uuid IS NULL OR g.scope_id = $3)
         AND ($4::boolean IS NULL OR g.active = $4)
         AND ($5::uuid[] IS NULL OR (g.scope_type = 'member' AND g.scope_id = ANY($5::uuid[])) OR (g.scope_type = 'team' AND g.scope_id = ANY($6::uuid[])))
       ORDER BY g.created_at DESC LIMIT 200`,
      [ctx.orgId, q.scopeType ?? null, q.scopeId ?? null, q.active ?? null, ids, teamIds ?? []],
    );
    const tz = await orgTimezone(ctx.orgId);
    const today = await todayIn(tz);
    const out = [];
    for (const g of rows) out.push(await goalDto(g, tz, today));
    ok(res, out);
  },
);

const goalBody = z.object({
  name: z.string().trim().min(1).max(150),
  scopeType: z.enum(['member', 'team']),
  scopeId: z.uuid(),
  metric: z.enum(METRIC_NAMES),
  target: z.number().nonnegative().max(1e9),
  comparator: z.enum(['gte', 'lte']).default('gte'),
  period: z.enum(['day', 'week', 'month']).default('week'),
  active: z.boolean().default(true),
});

goals.post('/', { summary: 'Create a performance goal', ids: 'PERF-17', permission: 'performance.view', body: goalBody }, async (req, res) => {
  const ctx = req.ctx;
  const b = req.body;
  await assertGoalWrite(ctx, b.scopeType, b.scopeId);
  const row = await db.one(
    `INSERT INTO performance_goals (organization_id, name, scope_type, scope_id, metric, target, comparator, period, active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.orgId, b.name, b.scopeType, b.scopeId, b.metric, b.target, b.comparator, b.period, b.active, ctx.memberId],
  );
  const g = await loadGoal(ctx, row.id);
  const tz = await orgTimezone(ctx.orgId);
  created(res, await goalDto(g, tz, await todayIn(tz)));
});

goals.get('/:id', { summary: 'Get a goal with progress', ids: 'PERF-17', permission: 'performance.view', params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  const g = await loadGoal(ctx, req.v.params.id);
  const tz = await orgTimezone(ctx.orgId);
  ok(res, await goalDto(g, tz, await todayIn(tz)));
});

goals.patch(
  '/:id',
  { summary: 'Update a goal', ids: 'PERF-17', permission: 'performance.view', params: uuidParam, body: goalBody.omit({ scopeType: true, scopeId: true }).partial() },
  async (req, res) => {
    const ctx = req.ctx;
    const g = await loadGoal(ctx, req.v.params.id);
    await assertGoalWrite(ctx, g.scope_type, g.scope_id);
    const b = req.body;
    await db.query(
      `UPDATE performance_goals SET name = coalesce($2, name), metric = coalesce($3, metric), target = coalesce($4, target),
         comparator = coalesce($5, comparator), period = coalesce($6, period), active = coalesce($7, active) WHERE id = $1`,
      [g.id, b.name ?? null, b.metric ?? null, b.target ?? null, b.comparator ?? null, b.period ?? null, b.active ?? null],
    );
    const tz = await orgTimezone(ctx.orgId);
    ok(res, await goalDto(await loadGoal(ctx, g.id), tz, await todayIn(tz)));
  },
);

goals.delete('/:id', { summary: 'Delete a goal', ids: 'PERF-17', permission: 'performance.view', params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  const g = await loadGoal(ctx, req.v.params.id);
  await assertGoalWrite(ctx, g.scope_type, g.scope_id);
  await db.query('DELETE FROM performance_goals WHERE id = $1', [g.id]);
  noContent(res);
});

// ───────────────────────── Custom metrics (PERF-19) ─────────────────────────
const metrics = createRouter('/custom-metrics', 'Performance');

const formulaSchema = z.object({
  terms: z.array(z.object({ metric: z.enum(METRIC_NAMES), weight: z.number().min(-1000).max(1000) })).min(1).max(10),
});

const metricDto = (m) => ({ id: m.id, name: m.name, formula: m.formula, unit: m.unit, createdAt: m.created_at });

async function loadMetric(ctx, id) {
  const m = await db.one('SELECT * FROM custom_metrics WHERE id = $1 AND organization_id = $2', [id, ctx.orgId]);
  if (!m) throw notFound('Custom metric');
  return m;
}

metrics.get('/', { summary: 'List custom metrics', ids: 'PERF-19', permission: 'performance.view' }, async (req, res) => {
  ok(res, (await db.many('SELECT * FROM custom_metrics WHERE organization_id = $1 ORDER BY name', [req.ctx.orgId])).map(metricDto));
});

metrics.post(
  '/',
  {
    summary: 'Create a custom metric (weighted whitelisted metrics; no arbitrary code)',
    ids: 'PERF-19',
    permission: 'reports.custom',
    body: z.object({ name: z.string().trim().min(1).max(100), formula: formulaSchema, unit: z.string().max(20).optional() }),
  },
  async (req, res) => {
    const b = req.body;
    const row = await db.one(
      'INSERT INTO custom_metrics (organization_id, name, formula, unit) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.ctx.orgId, b.name, db.json(b.formula), b.unit ?? null],
    );
    created(res, metricDto(row));
  },
);

metrics.get('/:id', { summary: 'Get a custom metric', ids: 'PERF-19', permission: 'performance.view', params: uuidParam }, async (req, res) => {
  ok(res, metricDto(await loadMetric(req.ctx, req.v.params.id)));
});

metrics.patch(
  '/:id',
  {
    summary: 'Update a custom metric',
    ids: 'PERF-19',
    permission: 'reports.custom',
    params: uuidParam,
    body: z.object({ name: z.string().trim().min(1).max(100).optional(), formula: formulaSchema.optional(), unit: z.string().max(20).nullable().optional() }),
  },
  async (req, res) => {
    const m = await loadMetric(req.ctx, req.v.params.id);
    const b = req.body;
    const row = await db.one(
      `UPDATE custom_metrics SET name = coalesce($2, name), formula = coalesce($3::jsonb, formula), unit = CASE WHEN $5 THEN $4 ELSE unit END
       WHERE id = $1 RETURNING *`,
      [m.id, b.name ?? null, b.formula ? db.json(b.formula) : null, b.unit ?? null, b.unit !== undefined],
    );
    ok(res, metricDto(row));
  },
);

metrics.delete('/:id', { summary: 'Delete a custom metric', ids: 'PERF-19', permission: 'reports.custom', params: uuidParam }, async (req, res) => {
  const m = await loadMetric(req.ctx, req.v.params.id);
  await db.query('DELETE FROM custom_metrics WHERE id = $1', [m.id]);
  noContent(res);
});

metrics.get(
  '/:id/evaluate',
  {
    summary: 'Evaluate a custom metric for members over a period',
    ids: 'PERF-19',
    permission: 'performance.view',
    params: uuidParam,
    query: rangeQuery.extend({ memberIds: zCsvUuids.optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const m = await loadMetric(ctx, req.v.params.id);
    const q = req.v.query;
    const acc = await accessibleMemberIds(ctx, 'performance.view');
    let ids = q.memberIds?.length ? q.memberIds : null;
    if (ids && acc && ids.some((i) => !acc.includes(i))) throw forbidden('You do not have access to one or more selected members');
    if (!ids) ids = acc;
    const members = await listMembers(ctx.orgId, ids, { includeInactive: !!q.memberIds });
    if (!members.length && q.memberIds?.length) throw badRequest('No matching members');
    const tz = await orgTimezone(ctx.orgId);
    const { from, to } = await resolveRange(q, tz, 'last_30_days');
    const all = await memberMetrics(ctx.orgId, members.map((x) => x.id), from, to, tz);
    const terms = m.formula?.terms ?? [];
    const results = members.map((mem) => {
      const mm = all.get(mem.id);
      const components = terms.map((t) => ({ metric: t.metric, weight: t.weight, value: metricValue(mm, t.metric) }));
      return {
        memberId: mem.id,
        name: mem.name,
        value: round2(components.reduce((s, c) => s + c.weight * c.value, 0)),
        components,
      };
    });
    ok(res, { metric: metricDto(m), from, to, results: results.sort((a, b) => b.value - a.value) });
  },
);

export default [goals, metrics];
