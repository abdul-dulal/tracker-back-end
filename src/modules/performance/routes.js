import { z } from 'zod';
import { createRouter, zCsvUuids } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { accessibleMemberIds, assertMemberAccess, getOrgMember, assertProjectAccess } from '../../rbac/scope.js';
import { expectedSecondsForDate } from '../time/summary-service.js';
import { rangeQuery, orgTimezone, resolveRange, windowFor, listMembers, round2, addDays, startOfWeek } from '../reports/common.js';
import {
  memberMetrics, aggregateMetrics, trend, consistency, projectContribution, estimatedVsActual, productivityWeights, SCORE_DISCLAIMER,
} from './service.js';

const r = createRouter('/performance', 'Performance');

const perfQuery = rangeQuery.extend({ granularity: z.enum(['day', 'week', 'month']).default('day') });

async function period(ctx, q, fallback = 'last_30_days') {
  const tz = await orgTimezone(ctx.orgId);
  const range = await resolveRange(q, tz, fallback);
  return { tz, ...range, ...(await windowFor(range.from, range.to, tz)) };
}

/** Accessible members among ids (403 when none accessible and ids were explicitly requested). */
async function scopeIds(ctx, ids) {
  const acc = await accessibleMemberIds(ctx, 'performance.view');
  return acc ? ids.filter((i) => acc.includes(i)) : ids;
}

async function teamMemberIds(ctx, teamId) {
  const team = await db.one('SELECT id, name FROM teams WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [teamId, ctx.orgId]);
  if (!team) throw notFound('Team');
  const ids = (await db.many('SELECT member_id FROM team_members WHERE team_id = $1', [teamId])).map((x) => x.member_id);
  return { team, ids };
}

r.get(
  '/members/:id',
  {
    summary: 'Individual performance overview: score, trends, task completion, contribution, consistency (PERF-01…12)',
    ids: 'PERF-01,PERF-02,PERF-04,PERF-05,PERF-06,PERF-07,PERF-08,PERF-09,PERF-10,PERF-11,PERF-12',
    permission: 'performance.view',
    params: z.object({ id: z.uuid() }),
    query: perfQuery,
  },
  async (req, res) => {
    const ctx = req.ctx;
    const { id } = req.v.params;
    const m = await getOrgMember(ctx.orgId, id);
    await assertMemberAccess(ctx, 'performance.view', id);
    const q = req.v.query;
    const p = await period(ctx, q);
    const weights = await productivityWeights(ctx.orgId);
    const metrics = (await memberMetrics(ctx.orgId, [id], p.from, p.to, p.tz, weights)).get(id);
    const cons = await consistency(ctx.orgId, id, p.from, p.to, p.today);
    ok(res, {
      member: { id: m.id, name: `${m.first_name} ${m.last_name}`.trim(), email: m.email },
      from: p.from,
      to: p.to,
      granularity: q.granularity,
      weights,
      metrics: { ...metrics, consistencyScore: cons.score },
      trend: await trend(ctx.orgId, [id], p.from, p.to, p.tz, q.granularity, weights),
      consistency: cons,
      projectContribution: await projectContribution(ctx.orgId, id, p.ws, p.we),
      estimatedVsActual: await estimatedVsActual(ctx.orgId, [id], p.ws, p.we),
      disclaimer: SCORE_DISCLAIMER,
    });
  },
);

r.get(
  '/teams/:id',
  {
    summary: 'Team performance overview (PERF-03)',
    ids: 'PERF-03,PERF-04,PERF-05,PERF-06,PERF-07',
    permission: 'performance.view',
    params: z.object({ id: z.uuid() }),
    query: perfQuery,
  },
  async (req, res) => {
    const ctx = req.ctx;
    const { team, ids: all } = await teamMemberIds(ctx, req.v.params.id);
    const ids = await scopeIds(ctx, all);
    if (!ids.length && ctx.can('performance.view') !== 'org') throw forbidden('You do not have access to this team');
    const q = req.v.query;
    const p = await period(ctx, q);
    const weights = await productivityWeights(ctx.orgId);
    const { metrics } = await aggregateMetrics(ctx.orgId, ids, p.from, p.to, p.tz, weights);
    const per = await memberMetrics(ctx.orgId, ids, p.from, p.to, p.tz, weights);
    const members = await listMembers(ctx.orgId, ids, { includeInactive: true });
    ok(res, {
      team: { id: team.id, name: team.name, memberCount: ids.length },
      from: p.from,
      to: p.to,
      granularity: q.granularity,
      weights,
      metrics,
      members: members
        .map((m) => ({ memberId: m.id, name: m.name, ...per.get(m.id) }))
        .sort((a, b) => (b.productivityScore ?? -1) - (a.productivityScore ?? -1)),
      trend: await trend(ctx.orgId, ids, p.from, p.to, p.tz, q.granularity, weights),
      estimatedVsActual: await estimatedVsActual(ctx.orgId, ids, p.ws, p.we),
      disclaimer: SCORE_DISCLAIMER,
    });
  },
);

r.get(
  '/compare',
  {
    summary: 'Compare members side by side (PERF-13)',
    ids: 'PERF-13',
    permission: 'performance.view',
    query: perfQuery.extend({ memberIds: zCsvUuids.pipe(z.array(z.uuid()).min(1).max(20)) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    for (const id of q.memberIds) await assertMemberAccess(ctx, 'performance.view', id);
    const members = await listMembers(ctx.orgId, q.memberIds, { includeInactive: true });
    if (members.length !== new Set(q.memberIds).size) throw notFound('Member');
    const p = await period(ctx, q);
    const weights = await productivityWeights(ctx.orgId);
    const metrics = await memberMetrics(ctx.orgId, q.memberIds, p.from, p.to, p.tz, weights);
    const out = [];
    for (const m of members)
      out.push({ memberId: m.id, name: m.name, ...metrics.get(m.id), trend: await trend(ctx.orgId, [m.id], p.from, p.to, p.tz, q.granularity, weights) });
    ok(res, { from: p.from, to: p.to, granularity: q.granularity, members: out, disclaimer: SCORE_DISCLAIMER });
  },
);

r.get(
  '/top-contributors',
  {
    summary: 'Top contributors by hours and tasks completed in a team or project (PERF-14)',
    ids: 'PERF-14',
    permission: 'performance.view',
    query: rangeQuery.extend({ teamId: z.uuid().optional(), projectId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const p = await period(ctx, q);
    let candidates;
    if (q.teamId) candidates = (await teamMemberIds(ctx, q.teamId)).ids;
    else if (q.projectId) {
      const proj = await db.one('SELECT id FROM projects WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [q.projectId, ctx.orgId]);
      if (!proj) throw notFound('Project');
      if (ctx.can('projects.view') && ctx.can('performance.view') !== 'org') await assertProjectAccess(ctx, 'projects.view', q.projectId);
      candidates = (await db.many(
        `SELECT DISTINCT member_id FROM time_entries WHERE project_id = $1 AND deleted_at IS NULL AND started_at >= $2 AND started_at < $3
         UNION SELECT ta.member_id FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE t.project_id = $1`,
        [q.projectId, p.ws, p.we],
      )).map((x) => x.member_id);
    } else candidates = (await listMembers(ctx.orgId)).map((m) => m.id);
    const ids = await scopeIds(ctx, candidates);
    const members = await listMembers(ctx.orgId, ids, { includeInactive: true });
    const rows = await db.many(
      `SELECT m.id,
         (SELECT coalesce(sum(CASE WHEN e.ended_at IS NULL THEN greatest(extract(epoch FROM now() - e.started_at)::int - e.paused_seconds, 0) ELSE e.duration_seconds END), 0)
          FROM time_entries e WHERE e.member_id = m.id AND e.deleted_at IS NULL AND e.status <> 'rejected' AND e.started_at >= $2 AND e.started_at < $3
            AND ($4::uuid IS NULL OR e.project_id = $4))::bigint AS seconds,
         (SELECT count(*) FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id AND ta.member_id = m.id
          WHERE t.deleted_at IS NULL AND t.completed_at >= $2 AND t.completed_at < $3 AND ($4::uuid IS NULL OR t.project_id = $4)) AS tasks_completed
       FROM organization_members m WHERE m.id = ANY($1::uuid[])`,
      [members.map((m) => m.id), p.ws, p.we, q.projectId ?? null],
    );
    const names = new Map(members.map((m) => [m.id, m.name]));
    const totalSeconds = rows.reduce((s, x) => s + x.seconds, 0);
    const entries = rows
      .map((x) => ({
        memberId: x.id, name: names.get(x.id), trackedSeconds: x.seconds, tasksCompleted: x.tasks_completed,
        contributionPercent: totalSeconds > 0 ? round2((x.seconds / totalSeconds) * 100) : 0,
      }))
      .filter((x) => x.trackedSeconds > 0 || x.tasksCompleted > 0)
      .sort((a, b) => b.trackedSeconds - a.trackedSeconds || b.tasksCompleted - a.tasksCompleted)
      .slice(0, q.limit)
      .map((x, i) => ({ rank: i + 1, ...x }));
    ok(res, { from: p.from, to: p.to, teamId: q.teamId ?? null, projectId: q.projectId ?? null, totalSeconds, contributors: entries });
  },
);

r.get(
  '/workload',
  {
    summary: 'Workload distribution: open task estimates vs scheduled hours per member (PERF-15)',
    ids: 'PERF-15',
    permission: 'performance.view',
    query: z.object({ teamId: z.uuid().optional(), days: z.coerce.number().int().min(1).max(31).default(7) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const candidates = q.teamId ? (await teamMemberIds(ctx, q.teamId)).ids : (await listMembers(ctx.orgId)).map((m) => m.id);
    const ids = await scopeIds(ctx, candidates);
    const members = await listMembers(ctx.orgId, ids);
    const tz = await orgTimezone(ctx.orgId);
    const { today } = await resolveRange({}, tz);
    const wk = startOfWeek(today);
    const tasks = await db.many(
      `SELECT ta.member_id, count(*) AS open_tasks, count(*) FILTER (WHERE t.due_date < $2::date) AS overdue,
              coalesce(sum(t.estimated_hours * (100 - t.progress) / 100.0 / greatest(1, (SELECT count(*) FROM task_assignees x WHERE x.task_id = t.id))), 0) AS remaining_hours,
              count(*) FILTER (WHERE t.estimated_hours IS NULL) AS unestimated
       FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id JOIN projects p ON p.id = t.project_id
       WHERE ta.member_id = ANY($1::uuid[]) AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND t.completed_at IS NULL
       GROUP BY ta.member_id`,
      [members.map((m) => m.id), today],
    );
    const tracked = await db.many(
      `SELECT member_id, sum(tracked_seconds)::bigint AS s FROM daily_summaries WHERE member_id = ANY($1::uuid[]) AND date BETWEEN $2 AND $3 GROUP BY 1`,
      [members.map((m) => m.id), wk, today],
    );
    const tm = new Map(tasks.map((x) => [x.member_id, x]));
    const tr = new Map(tracked.map((x) => [x.member_id, x.s]));
    const out = [];
    for (const m of members) {
      let capacity = 0;
      for (let i = 0; i < q.days; i++) capacity += await expectedSecondsForDate(m.id, addDays(today, i));
      const t = tm.get(m.id);
      const remaining = round2(Number(t?.remaining_hours ?? 0));
      const capacityHours = round2(capacity / 3600);
      out.push({
        memberId: m.id,
        name: m.name,
        openTasks: t?.open_tasks ?? 0,
        overdueTasks: t?.overdue ?? 0,
        unestimatedTasks: t?.unestimated ?? 0,
        remainingEstimateHours: remaining,
        scheduledHours: capacityHours,
        trackedThisWeekSeconds: tr.get(m.id) ?? 0,
        utilizationPercent: capacityHours > 0 ? round2((remaining / capacityHours) * 100) : null,
        status: capacityHours <= 0 ? 'unavailable' : remaining > capacityHours ? 'overloaded' : remaining < capacityHours * 0.5 ? 'underloaded' : 'balanced',
      });
    }
    ok(res, { days: q.days, from: today, to: addDays(today, q.days - 1), members: out.sort((a, b) => (b.utilizationPercent ?? -1) - (a.utilizationPercent ?? -1)) });
  },
);

r.get(
  '/history',
  {
    summary: 'Performance history from monthly/weekly snapshots (PERF-16)',
    ids: 'PERF-16',
    permission: 'performance.view',
    query: z.object({ memberId: z.uuid().optional(), periodType: z.enum(['week', 'month']).default('month'), limit: z.coerce.number().int().min(1).max(60).default(12) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const memberId = q.memberId ?? ctx.memberId;
    await getOrgMember(ctx.orgId, memberId);
    await assertMemberAccess(ctx, 'performance.view', memberId);
    const rows = await db.many(
      `SELECT * FROM performance_snapshots WHERE organization_id = $1 AND member_id = $2 AND period_type = $3 ORDER BY period_start DESC LIMIT $4`,
      [ctx.orgId, memberId, q.periodType, q.limit],
    );
    ok(res, {
      memberId,
      periodType: q.periodType,
      snapshots: rows.map((s) => ({
        periodStart: s.period_start, periodType: s.period_type, productivityScore: s.productivity_score === null ? null : Number(s.productivity_score),
        rank: s.rank, metrics: s.metrics, createdAt: s.created_at,
      })),
      disclaimer: SCORE_DISCLAIMER,
    });
  },
);

export default r;
