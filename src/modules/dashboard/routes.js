import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';
import { rangeQuery, round2, pct, addDays, startOfWeek, eachDay, todayIn } from '../reports/common.js';
import { runReport, makeContext, projectRows } from '../reports/engine.js';
import { trend, productivityWeights } from '../performance/service.js';
import { expectedSecondsForDate, memberTimezone } from '../time/summary-service.js';
import { computeStats, cached, cacheKey, dashboardScope, scopedProjectIds, attendanceSummary } from './service.js';

const r = createRouter('/dashboard', 'Dashboard');

const dashQuery = rangeQuery.extend({
  teamId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  memberId: z.uuid().optional(),
});

const filtersOf = (q) => ({
  memberIds: q.memberId ? [q.memberId] : undefined,
  teamIds: q.teamId ? [q.teamId] : undefined,
  projectIds: q.projectId ? [q.projectId] : undefined,
});

r.get(
  '/stats',
  {
    summary: 'Dashboard KPI tiles with previous-period deltas (RPT-D01…D14, ADM-10…12)',
    ids: 'RPT-D01,RPT-D02,RPT-D03,RPT-D04,RPT-D05,RPT-D06,RPT-D07,RPT-D08,RPT-D09,RPT-D10,RPT-D11,RPT-D12,RPT-D13,RPT-D14,ADM-10,ADM-11,ADM-12,ADM-20,ADM-21,ADM-22,ADM-23',
    permission: 'reports.view',
    query: dashQuery,
  },
  async (req, res) => {
    const q = req.v.query;
    ok(res, await cached(cacheKey(req.ctx, 'stats', q), () => computeStats(req.ctx, q)));
  },
);

r.get(
  '/overview',
  {
    summary: 'Organization overview: members by status/department, teams, projects at risk, tasks (ADM-01…05)',
    ids: 'ADM-01,ADM-02,ADM-03,ADM-04,ADM-05',
    permission: 'reports.view',
    query: dashQuery,
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const data = await cached(cacheKey(ctx, 'overview', q), async () => {
      const scope = await dashboardScope(ctx, q, 'this_week');
      const ids = scope.memberIds;
      const byStatus = await db.many(
        `SELECT status, count(*)::int AS n FROM organization_members WHERE organization_id = $1 AND id = ANY($2::uuid[]) GROUP BY status`,
        [ctx.orgId, ids],
      );
      const byDept = await db.many(
        `SELECT m.department_id, coalesce(d.name, '(no department)') AS name, count(*)::int AS n
         FROM organization_members m LEFT JOIN departments d ON d.id = m.department_id
         WHERE m.organization_id = $1 AND m.id = ANY($2::uuid[]) GROUP BY 1, 2 ORDER BY 3 DESC`,
        [ctx.orgId, ids],
      );
      const teams = await db.many(
        `SELECT t.id, t.name, count(DISTINCT tm.member_id)::int AS members,
                coalesce(sum(s.tracked_seconds), 0)::bigint AS tracked, coalesce(sum(s.active_seconds), 0)::bigint AS active,
                coalesce(sum(s.activity_percent::bigint * s.tracked_seconds), 0)::bigint AS wact,
                coalesce(sum(s.productive_seconds), 0)::bigint AS prod
         FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.member_id = ANY($2::uuid[])
         LEFT JOIN daily_summaries s ON s.member_id = tm.member_id AND s.date BETWEEN $3 AND $4
         WHERE t.organization_id = $1 AND t.deleted_at IS NULL ${q.teamId ? 'AND t.id = $5' : ''}
         GROUP BY t.id, t.name ORDER BY t.name`,
        q.teamId ? [ctx.orgId, ids, scope.from, scope.to, q.teamId] : [ctx.orgId, ids, scope.from, scope.to],
      );
      const c = await makeContext(ctx, { from: scope.from, to: scope.to, filters: { ...filtersOf(q), memberIds: scope.ids ?? undefined, teamIds: undefined } });
      const projects = (await projectRows(ctx, {}, c)).filter((p) => !['completed', 'cancelled'].includes(p.status));
      const pids = await scopedProjectIds(ctx, q, ids);
      const restrict = scope.ids !== null || !!q.memberId || !!q.teamId;
      const tasks = await db.one(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE t.completed_at IS NULL AND coalesce(bc.category, 'todo') = 'todo')::int AS todo,
                count(*) FILTER (WHERE t.completed_at IS NULL AND bc.category = 'in_progress')::int AS in_progress,
                count(*) FILTER (WHERE t.completed_at IS NULL AND bc.category = 'in_review')::int AS in_review,
                count(*) FILTER (WHERE t.completed_at IS NOT NULL OR bc.category = 'done')::int AS done,
                count(*) FILTER (WHERE t.completed_at IS NULL AND t.due_date < $5::date)::int AS overdue,
                count(*) FILTER (WHERE t.completed_at IS NULL AND t.due_date = $5::date)::int AS due_today
         FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN board_columns bc ON bc.id = t.column_id
         WHERE t.organization_id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL
           AND ($2::uuid[] IS NULL OR t.project_id = ANY($2::uuid[]))
           AND (NOT $3 OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.member_id = ANY($4::uuid[])))`,
        [ctx.orgId, pids, restrict, ids, scope.today],
      );
      const pick = (p) => ({ id: p.projectId, name: p.project, status: p.status, deadline: p.deadline, budgetUsedPercent: p.budgetUsedPercent, progress: p.progress });
      return {
        from: scope.from,
        to: scope.to,
        employees: {
          total: ids.length,
          byStatus: Object.fromEntries(byStatus.map((x) => [x.status, x.n])),
          byDepartment: byDept.map((x) => ({ departmentId: x.department_id, name: x.name, count: x.n })),
        },
        teams: teams.map((t) => ({
          id: t.id, name: t.name, members: t.members, trackedSeconds: t.tracked, activeSeconds: t.active,
          activityPercent: t.tracked > 0 ? round2(t.wact / t.tracked) : 0, productiveSeconds: t.prod,
        })),
        projects: {
          active: projects.filter((p) => p.status === 'active').length,
          atRiskCount: projects.filter((p) => p.atRisk).length,
          overBudgetCount: projects.filter((p) => p.overBudget).length,
          atRisk: projects.filter((p) => p.atRisk).map(pick),
          overBudget: projects.filter((p) => p.overBudget).map(pick),
        },
        tasks: {
          total: tasks.total,
          byStatus: { todo: tasks.todo, in_progress: tasks.in_progress, in_review: tasks.in_review, done: tasks.done },
          overdue: tasks.overdue,
          dueToday: tasks.due_today,
        },
        attendanceToday: await attendanceSummary(ctx.orgId, scope.members.filter((m) => m.status === 'active').map((m) => m.id), scope.today),
      };
    });
    ok(res, data);
  },
);

const CHARTS = ['hours-distribution', 'active-vs-idle', 'productivity-trend', 'app-usage', 'attendance', 'employee-comparison', 'project-comparison'];

r.get(
  '/charts/:chart',
  {
    summary: 'Chart data {series, totals} (RPT-A01…A10)',
    ids: 'RPT-A01,RPT-A02,RPT-A03,RPT-A04,RPT-A05,RPT-A06,RPT-A07,RPT-A08,RPT-A09,RPT-A10,RPT-A11',
    permission: 'reports.view',
    params: z.object({ chart: z.enum(CHARTS) }),
    query: dashQuery.extend({ granularity: z.enum(['day', 'week', 'month']).default('day'), limit: z.coerce.number().int().min(1).max(50).default(10) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const chart = req.v.params.chart;
    const data = await cached(cacheKey(ctx, `chart:${chart}`, q), async () => {
      const base = { from: q.from, to: q.to, range: q.range ?? 'last_7_days', filters: filtersOf(q) };
      const g = q.granularity;
      const pick = (rep, keys) => ({
        from: rep.from,
        to: rep.to,
        series: rep.rows.map((row) => ({ date: row[g], ...Object.fromEntries(keys.map((k) => [k, row[k]])) })),
        totals: Object.fromEntries(keys.map((k) => [k, rep.totals[k]])),
      });
      switch (chart) {
        case 'hours-distribution': {
          const rep = await runReport(ctx, { ...base, reportType: q.projectId ? 'time' : 'activity', groupBy: [g] });
          return pick(rep, q.projectId ? ['trackedSeconds', 'billableSeconds'] : ['trackedSeconds', 'billableSeconds', 'overtimeSeconds']);
        }
        case 'active-vs-idle':
          return pick(await runReport(ctx, { ...base, reportType: 'activity', groupBy: [g] }), ['activeSeconds', 'idleSeconds', 'trackedSeconds', 'activityPercent']);
        case 'productivity-trend': {
          const rep = await runReport(ctx, { ...base, reportType: 'activity', groupBy: [g] });
          const scope = await dashboardScope(ctx, { ...q, range: base.range }, 'last_7_days');
          const scores = await trend(ctx.orgId, scope.memberIds, rep.from, rep.to, scope.tz, g, await productivityWeights(ctx.orgId));
          const byPeriod = new Map(scores.map((s) => [s.period, s]));
          const out = pick(rep, ['productiveSeconds', 'unproductiveSeconds', 'neutralSeconds', 'productiveRatio', 'activityPercent']);
          out.series = out.series.map((s) => ({ ...s, productivityScore: byPeriod.get(s.date)?.productivityScore ?? null }));
          return out;
        }
        case 'app-usage': {
          const apps = await runReport(ctx, { ...base, reportType: 'apps', groupBy: ['app'] });
          const cats = await runReport(ctx, { ...base, reportType: 'apps', groupBy: ['category'] });
          const top = apps.rows.slice(0, q.limit).map((x) => ({ name: x.app, seconds: x.seconds, percent: x.percent }));
          const rest = apps.rows.slice(q.limit).reduce((s, x) => s + x.seconds, 0);
          if (rest > 0) top.push({ name: 'Other', seconds: rest, percent: pct(rest, apps.totals.seconds) });
          return {
            from: apps.from,
            to: apps.to,
            series: top,
            byCategory: cats.rows.map((x) => ({ category: x.category, seconds: x.seconds, percent: x.percent })),
            totals: { seconds: apps.totals.seconds },
          };
        }
        case 'attendance':
          return pick(await runReport(ctx, { ...base, reportType: 'attendance', groupBy: [g] }), ['present', 'late', 'halfDay', 'absent', 'leave', 'attendanceRate']);
        case 'employee-comparison': {
          const rep = await runReport(ctx, { ...base, reportType: 'activity', groupBy: ['member'] });
          return {
            from: rep.from,
            to: rep.to,
            series: rep.rows.slice(0, q.limit).map((x) => ({
              memberId: x.memberId, name: x.member, trackedSeconds: x.trackedSeconds, activityPercent: x.activityPercent,
              productiveSeconds: x.productiveSeconds, productiveRatio: x.productiveRatio,
            })),
            totals: { trackedSeconds: rep.totals.trackedSeconds, activityPercent: rep.totals.activityPercent },
          };
        }
        case 'project-comparison':
        default: {
          const rep = await runReport(ctx, { ...base, reportType: 'time', groupBy: ['project'] });
          return {
            from: rep.from,
            to: rep.to,
            series: rep.rows.slice(0, q.limit).map((x) => ({
              projectId: x.projectId, name: x.project, trackedSeconds: x.trackedSeconds, billableSeconds: x.billableSeconds, cost: x.cost,
            })),
            totals: { trackedSeconds: rep.totals.trackedSeconds, billableSeconds: rep.totals.billableSeconds, cost: rep.totals.cost },
          };
        }
      }
    });
    ok(res, { chart, granularity: q.granularity, ...data });
  },
);

r.get(
  '/me',
  { summary: 'Employee dashboard: own hours vs expected, activity, tasks, attendance, screenshots', ids: 'RPT-D05,RPT-E02' },
  async (req, res) => {
    const ctx = req.ctx;
    const me = ctx.memberId;
    const tz = await memberTimezone(me);
    const today = await todayIn(tz);
    const weekStart = startOfWeek(today);
    const weekEnd = addDays(weekStart, 6);
    const sums = await db.many(
      `SELECT to_char(date, 'YYYY-MM-DD') AS d, tracked_seconds, active_seconds, idle_seconds, break_seconds, productive_seconds,
              unproductive_seconds, neutral_seconds, activity_percent, screenshot_count, overtime_seconds
       FROM daily_summaries WHERE member_id = $1 AND date BETWEEN $2 AND $3`,
      [me, weekStart, weekEnd],
    );
    const byDay = new Map(sums.map((s) => [s.d, s]));
    const days = [];
    for (const d of eachDay(weekStart, weekEnd)) {
      const s = byDay.get(d);
      days.push({ date: d, trackedSeconds: s?.tracked_seconds ?? 0, expectedSeconds: await expectedSecondsForDate(me, d), activityPercent: s?.activity_percent ?? 0 });
    }
    const t = byDay.get(today);
    const weekTracked = sums.reduce((s, x) => s + x.tracked_seconds, 0);
    const weekW = sums.reduce((s, x) => s + x.activity_percent * x.tracked_seconds, 0);
    const prod = sums.reduce((s, x) => s + x.productive_seconds, 0);
    const usage = sums.reduce((s, x) => s + x.productive_seconds + x.unproductive_seconds + x.neutral_seconds, 0);
    const running = await db.one(
      `SELECT e.id, e.started_at, e.status, e.project_id, p.name AS project_name, e.task_id, tk.title AS task_title
       FROM time_entries e LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN tasks tk ON tk.id = e.task_id
       WHERE e.member_id = $1 AND e.ended_at IS NULL AND e.deleted_at IS NULL`,
      [me],
    );
    const tasks = await db.many(
      `SELECT t.id, t.title, t.due_date, t.priority, t.project_id, p.name AS project_name
       FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id AND ta.member_id = $1 JOIN projects p ON p.id = t.project_id
       WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL AND t.completed_at IS NULL AND t.organization_id = $2
       ORDER BY t.due_date NULLS LAST, t.created_at LIMIT 200`,
      [me, ctx.orgId],
    );
    const taskDto = (x) => ({ id: x.id, title: x.title, dueDate: x.due_date, priority: x.priority, projectId: x.project_id, projectName: x.project_name });
    const att = await db.one(
      'SELECT status, check_in_at, check_out_at, late_minutes, worked_seconds FROM attendance_records WHERE member_id = $1 AND date = $2',
      [me, today],
    );
    const shots24 = await db.one(
      `SELECT count(*)::int AS n FROM screenshots WHERE member_id = $1 AND deleted_at IS NULL AND captured_at > now() - interval '24 hours'`,
      [me],
    );
    const todayDay = days.find((d) => d.date === today);
    ok(res, {
      date: today,
      timezone: tz,
      today: {
        trackedSeconds: t?.tracked_seconds ?? 0,
        expectedSeconds: todayDay.expectedSeconds,
        progressPercent: pct(t?.tracked_seconds ?? 0, todayDay.expectedSeconds),
        activeSeconds: t?.active_seconds ?? 0,
        idleSeconds: t?.idle_seconds ?? 0,
        breakSeconds: t?.break_seconds ?? 0,
        activityPercent: t?.activity_percent ?? 0,
        screenshotCount: t?.screenshot_count ?? 0,
      },
      week: {
        from: weekStart,
        to: weekEnd,
        trackedSeconds: weekTracked,
        expectedSeconds: days.reduce((s, d) => s + d.expectedSeconds, 0),
        expectedToDateSeconds: days.filter((d) => d.date <= today).reduce((s, d) => s + d.expectedSeconds, 0),
        overtimeSeconds: sums.reduce((s, x) => s + x.overtime_seconds, 0),
        activityPercent: weekTracked > 0 ? round2(weekW / weekTracked) : 0,
        productiveRatio: usage > 0 ? pct(prod, usage) : null,
        days,
      },
      timer: running
        ? { entryId: running.id, startedAt: running.started_at, status: running.status, projectId: running.project_id, projectName: running.project_name, taskId: running.task_id, taskTitle: running.task_title }
        : null,
      tasks: {
        open: tasks.length,
        dueToday: tasks.filter((x) => x.due_date === today).map(taskDto),
        overdue: tasks.filter((x) => x.due_date && x.due_date < today).map(taskDto),
        upcoming: tasks.filter((x) => x.due_date && x.due_date > today).slice(0, 10).map(taskDto),
      },
      attendanceToday: att
        ? { status: att.status, checkInAt: att.check_in_at, checkOutAt: att.check_out_at, lateMinutes: att.late_minutes, workedSeconds: att.worked_seconds }
        : null,
      screenshots: { today: t?.screenshot_count ?? 0, last24h: shots24.n },
    });
  },
);

export default r;
