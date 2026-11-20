import { db } from '../../lib/db.js';
import { where } from '../../lib/http.js';
import { badRequest, AppError } from '../../lib/errors.js';
import { accessibleProjectIds, memberProjectIds } from '../../rbac/scope.js';
import { buildCategorizer, loadRules, loadCatalog } from '../apps/categorize.js';
import { hasFeature } from '../subscription/features.js';
import { orgTimezone, resolveRange, resolveMemberScope, windowFor, listMembers, round2, pct } from './common.js';
import { memberMetrics, productivityWeights, SCORE_DISCLAIMER } from '../performance/service.js';

/**
 * Report engine (guide §M15): typed report definitions
 *   { reportType, from, to, range, groupBy[], metrics[], filters{memberIds,teamIds,projectIds,clientIds} }
 * → { columns, rows, totals, series }.
 * Dates are inclusive and interpreted in the organization time zone (daily_summaries / attendance use member-local dates).
 */

export const REPORT_TYPES = ['time', 'activity', 'apps', 'websites', 'screenshots', 'attendance', 'breaks', 'projects', 'tasks', 'employees'];
export const GROUP_DIMS = ['day', 'week', 'month', 'member', 'team', 'project', 'task', 'client', 'app', 'category'];
const TIME_DIMS = ['day', 'week', 'month'];
const ENTITY_DIMS = ['member', 'team', 'project', 'task', 'client'];
const MAX_ROWS = 5000;

const DIM_COLUMNS = {
  day: { key: 'day', label: 'Date', type: 'date' },
  week: { key: 'week', label: 'Week', type: 'date' },
  month: { key: 'month', label: 'Month', type: 'string' },
  member: { key: 'member', label: 'Member', type: 'string' },
  team: { key: 'team', label: 'Team', type: 'string' },
  project: { key: 'project', label: 'Project', type: 'string' },
  task: { key: 'task', label: 'Task', type: 'string' },
  client: { key: 'client', label: 'Client', type: 'string' },
  app: { key: 'app', label: 'Application', type: 'string' },
  category: { key: 'category', label: 'Category', type: 'string' },
};

const timeDim = (dim, d) =>
  ({
    day: `to_char(${d}, 'YYYY-MM-DD')`,
    week: `to_char(date_trunc('week', ${d})::date, 'YYYY-MM-DD')`,
    month: `to_char(${d}, 'YYYY-MM')`,
  })[dim];

const timeDims = (d) => Object.fromEntries(TIME_DIMS.map((k) => [k, timeDim(k, d)]));

/** Primary team of a member (restricted to the team filter when present). */
const teamExpr = (c, memberCol) =>
  `(SELECT tm.team_id FROM team_members tm WHERE tm.member_id = ${memberCol}${c.p.teams ? ` AND tm.team_id = ANY(${c.p.teams}::uuid[])` : ''} ORDER BY tm.joined_at, tm.team_id LIMIT 1)`;

const durExpr = (a) =>
  `(CASE WHEN ${a}.ended_at IS NULL THEN greatest(extract(epoch FROM now() - ${a}.started_at)::int - ${a}.paused_seconds, 0) ELSE ${a}.duration_seconds END)`;

const rateExpr = (rateType, memberCol, dateCol) =>
  `(SELECT r.amount FROM member_rates r WHERE r.member_id = ${memberCol} AND r.rate_type = '${rateType}' AND r.pay_type = 'hourly'
     AND r.effective_from <= ${dateCol} AND (r.effective_to IS NULL OR r.effective_to > ${dateCol}) ORDER BY r.effective_from DESC LIMIT 1)`;

// ───────────────────────── report type specs ─────────────────────────
// Each spec: { from, memberCol, dims{dim: sql}, metrics{key: aggSql}, columns[], derive(row), apply(c) → add where conditions }

const SPECS = {
  time(c) {
    const ld = `(e.started_at AT TIME ZONE ${c.p.tz})::date`;
    const dur = durExpr('e');
    const cost = `coalesce(${rateExpr('cost', 'e.member_id', ld)}, ${rateExpr('pay', 'e.member_id', ld)}, 0)`;
    const bill = `coalesce((SELECT pm.billable_rate FROM project_members pm WHERE pm.project_id = e.project_id AND pm.member_id = e.member_id),
                    ${rateExpr('billable', 'e.member_id', ld)}, p.hourly_rate,
                    (SELECT os.default_billable_rate FROM organization_settings os WHERE os.organization_id = e.organization_id), 0)`;
    return {
      from: 'FROM time_entries e LEFT JOIN projects p ON p.id = e.project_id',
      dims: {
        ...timeDims(ld),
        member: 'e.member_id',
        team: teamExpr(c, 'e.member_id'),
        project: 'e.project_id',
        task: 'e.task_id',
        client: 'coalesce(e.client_id, p.client_id)',
      },
      metrics: {
        trackedSeconds: `sum(${dur})`,
        billableSeconds: `sum(CASE WHEN e.is_billable THEN ${dur} ELSE 0 END)`,
        activeSeconds: 'sum(e.active_seconds)',
        idleSeconds: 'sum(e.idle_seconds)',
        manualSeconds: `sum(CASE WHEN e.source = 'manual' THEN ${dur} ELSE 0 END)`,
        entries: 'count(*)',
        cost: `sum(${dur}::numeric / 3600 * ${cost})`,
        billableAmount: `sum(CASE WHEN e.is_billable THEN ${dur}::numeric / 3600 * ${bill} ELSE 0 END)`,
      },
      columns: [
        { key: 'trackedSeconds', label: 'Tracked', type: 'seconds' },
        { key: 'billableSeconds', label: 'Billable', type: 'seconds' },
        { key: 'nonBillableSeconds', label: 'Non-billable', type: 'seconds' },
        { key: 'manualSeconds', label: 'Manual', type: 'seconds' },
        { key: 'activeSeconds', label: 'Active', type: 'seconds' },
        { key: 'idleSeconds', label: 'Idle', type: 'seconds' },
        { key: 'activityPercent', label: 'Activity %', type: 'percent' },
        { key: 'entries', label: 'Entries', type: 'number' },
        { key: 'cost', label: 'Cost', type: 'money' },
        { key: 'billableAmount', label: 'Billable amount', type: 'money' },
      ],
      derive: (r) => {
        r.nonBillableSeconds = r.trackedSeconds - r.billableSeconds;
        r.activityPercent = pct(r.activeSeconds, r.trackedSeconds);
        r.cost = round2(r.cost);
        r.billableAmount = round2(r.billableAmount);
      },
      apply(w) {
        w.add('e.organization_id = ?', c.orgId);
        w.raw(`e.deleted_at IS NULL AND e.status <> 'rejected'`);
        if (!c.lifetime) w.raw(`e.started_at >= ${c.p.ws} AND e.started_at < ${c.p.we}`);
        if (c.ids) w.add('e.member_id = ANY(?::uuid[])', c.ids);
        if (c.filters.projectIds?.length) w.add('e.project_id = ANY(?::uuid[])', c.filters.projectIds);
        if (c.filters.clientIds?.length) w.add('coalesce(e.client_id, p.client_id) = ANY(?::uuid[])', c.filters.clientIds);
      },
    };
  },

  activity(c) {
    return {
      from: 'FROM daily_summaries s',
      dims: { ...timeDims('s.date'), member: 's.member_id', team: teamExpr(c, 's.member_id') },
      metrics: {
        trackedSeconds: 'sum(s.tracked_seconds)',
        activeSeconds: 'sum(s.active_seconds)',
        idleSeconds: 'sum(s.idle_seconds)',
        breakSeconds: 'sum(s.break_seconds)',
        meetingSeconds: 'sum(s.meeting_seconds)',
        productiveSeconds: 'sum(s.productive_seconds)',
        unproductiveSeconds: 'sum(s.unproductive_seconds)',
        neutralSeconds: 'sum(s.neutral_seconds)',
        billableSeconds: 'sum(s.billable_seconds)',
        overtimeSeconds: 'sum(s.overtime_seconds)',
        screenshotCount: 'sum(s.screenshot_count)',
        _wact: 'sum(s.activity_percent::bigint * s.tracked_seconds)',
      },
      columns: [
        { key: 'trackedSeconds', label: 'Tracked', type: 'seconds' },
        { key: 'activeSeconds', label: 'Active', type: 'seconds' },
        { key: 'idleSeconds', label: 'Idle', type: 'seconds' },
        { key: 'breakSeconds', label: 'Breaks', type: 'seconds' },
        { key: 'meetingSeconds', label: 'Meetings', type: 'seconds' },
        { key: 'activityPercent', label: 'Activity %', type: 'percent' },
        { key: 'productiveSeconds', label: 'Productive', type: 'seconds' },
        { key: 'unproductiveSeconds', label: 'Unproductive', type: 'seconds' },
        { key: 'neutralSeconds', label: 'Neutral', type: 'seconds' },
        { key: 'productiveRatio', label: 'Productive %', type: 'percent' },
        { key: 'billableSeconds', label: 'Billable', type: 'seconds' },
        { key: 'overtimeSeconds', label: 'Overtime', type: 'seconds' },
        { key: 'screenshotCount', label: 'Screenshots', type: 'number' },
      ],
      derive: (r) => {
        r.activityPercent = r.trackedSeconds > 0 ? round2(r._wact / r.trackedSeconds) : 0;
        r.productiveRatio = pct(r.productiveSeconds, r.productiveSeconds + r.unproductiveSeconds + r.neutralSeconds);
        delete r._wact;
      },
      apply(w) {
        w.add('s.organization_id = ?', c.orgId);
        w.raw(`s.date BETWEEN ${c.p.from}::date AND ${c.p.to}::date`);
        if (c.ids) w.add('s.member_id = ANY(?::uuid[])', c.ids);
      },
      notes: c.filters.projectIds?.length || c.filters.clientIds?.length ? ['Project/client filters do not apply to daily activity summaries.'] : [],
    };
  },

  apps(c) {
    const ld = `(a.started_at AT TIME ZONE ${c.p.tz})::date`;
    return {
      from: 'FROM app_usage a',
      dims: { ...timeDims(ld), member: 'a.member_id', team: teamExpr(c, 'a.member_id'), app: 'a.app_name' },
      appIdentifier: 'max(a.app_identifier)',
      categoryTarget: 'app',
      metrics: { seconds: 'sum(a.duration_seconds)', sessions: 'count(*)' },
      columns: [
        { key: 'seconds', label: 'Time', type: 'seconds' },
        { key: 'sessions', label: 'Sessions', type: 'number' },
        { key: 'percent', label: 'Share %', type: 'percent' },
      ],
      apply(w) {
        w.add('a.organization_id = ?', c.orgId);
        w.raw(`a.started_at >= ${c.p.ws} AND a.started_at < ${c.p.we}`);
        if (c.ids) w.add('a.member_id = ANY(?::uuid[])', c.ids);
      },
    };
  },

  websites(c) {
    const ld = `(x.started_at AT TIME ZONE ${c.p.tz})::date`;
    return {
      from: 'FROM web_usage x',
      dims: { ...timeDims(ld), member: 'x.member_id', team: teamExpr(c, 'x.member_id'), app: 'x.domain' },
      categoryTarget: 'website',
      metrics: { seconds: 'sum(x.duration_seconds)', visits: 'count(*)' },
      columns: [
        { key: 'seconds', label: 'Time', type: 'seconds' },
        { key: 'visits', label: 'Visits', type: 'number' },
        { key: 'percent', label: 'Share %', type: 'percent' },
      ],
      apply(w) {
        w.add('x.organization_id = ?', c.orgId);
        w.raw('NOT x.is_excluded');
        w.raw(`x.started_at >= ${c.p.ws} AND x.started_at < ${c.p.we}`);
        if (c.ids) w.add('x.member_id = ANY(?::uuid[])', c.ids);
      },
    };
  },

  screenshots(c) {
    const ld = `(sc.captured_at AT TIME ZONE ${c.p.tz})::date`;
    return {
      from: 'FROM screenshots sc LEFT JOIN projects p ON p.id = sc.project_id',
      dims: {
        ...timeDims(ld), member: 'sc.member_id', team: teamExpr(c, 'sc.member_id'), project: 'sc.project_id', task: 'sc.task_id',
        client: 'p.client_id', app: `coalesce(sc.app_name, '(unknown)')`,
      },
      metrics: {
        screenshots: 'count(*)',
        avgActivityPercent: 'coalesce(round(avg(sc.activity_percent), 2), 0)',
        blurred: 'count(*) FILTER (WHERE sc.is_blurred)',
        sizeBytes: 'sum(sc.size_bytes)',
      },
      columns: [
        { key: 'screenshots', label: 'Screenshots', type: 'number' },
        { key: 'avgActivityPercent', label: 'Avg activity %', type: 'percent' },
        { key: 'blurred', label: 'Blurred', type: 'number' },
        { key: 'sizeBytes', label: 'Size (bytes)', type: 'number' },
      ],
      nonAdditive: ['avgActivityPercent'],
      apply(w) {
        w.add('sc.organization_id = ?', c.orgId);
        w.raw('sc.deleted_at IS NULL');
        w.raw(`sc.captured_at >= ${c.p.ws} AND sc.captured_at < ${c.p.we}`);
        if (c.ids) w.add('sc.member_id = ANY(?::uuid[])', c.ids);
        if (c.filters.projectIds?.length) w.add('sc.project_id = ANY(?::uuid[])', c.filters.projectIds);
        if (c.filters.clientIds?.length) w.add('p.client_id = ANY(?::uuid[])', c.filters.clientIds);
      },
    };
  },

  attendance(c) {
    return {
      from: 'FROM attendance_records ar',
      dims: { ...timeDims('ar.date'), member: 'ar.member_id', team: teamExpr(c, 'ar.member_id') },
      metrics: {
        records: 'count(*)',
        present: `count(*) FILTER (WHERE ar.status IN ('present','late'))`,
        late: `count(*) FILTER (WHERE ar.status = 'late')`,
        halfDay: `count(*) FILTER (WHERE ar.status = 'half_day')`,
        absent: `count(*) FILTER (WHERE ar.status = 'absent')`,
        leave: `count(*) FILTER (WHERE ar.status = 'leave')`,
        holiday: `count(*) FILTER (WHERE ar.status IN ('holiday','weekend'))`,
        lateMinutes: 'sum(ar.late_minutes)',
        earlyLeaveMinutes: 'sum(ar.early_leave_minutes)',
        workedSeconds: 'sum(ar.worked_seconds)',
        overtimeSeconds: 'sum(ar.overtime_seconds)',
      },
      columns: [
        { key: 'present', label: 'Present', type: 'number' },
        { key: 'late', label: 'Late', type: 'number' },
        { key: 'halfDay', label: 'Half day', type: 'number' },
        { key: 'absent', label: 'Absent', type: 'number' },
        { key: 'leave', label: 'Leave', type: 'number' },
        { key: 'holiday', label: 'Holiday/weekend', type: 'number' },
        { key: 'attendanceRate', label: 'Attendance %', type: 'percent' },
        { key: 'lateMinutes', label: 'Late minutes', type: 'number' },
        { key: 'earlyLeaveMinutes', label: 'Early leave minutes', type: 'number' },
        { key: 'workedSeconds', label: 'Worked', type: 'seconds' },
        { key: 'overtimeSeconds', label: 'Overtime', type: 'seconds' },
      ],
      derive: (r) => {
        r.attendanceRate = pct(r.present + r.halfDay * 0.5, r.present + r.halfDay + r.absent);
      },
      apply(w) {
        w.add('ar.organization_id = ?', c.orgId);
        w.raw(`ar.date BETWEEN ${c.p.from}::date AND ${c.p.to}::date`);
        if (c.ids) w.add('ar.member_id = ANY(?::uuid[])', c.ids);
      },
    };
  },

  breaks(c) {
    const ld = `(b.started_at AT TIME ZONE ${c.p.tz})::date`;
    const dur = `(CASE WHEN b.ended_at IS NULL THEN extract(epoch FROM now() - b.started_at)::int ELSE b.duration_seconds END)`;
    return {
      from: 'FROM breaks b JOIN break_types bt ON bt.id = b.break_type_id',
      dims: { ...timeDims(ld), member: 'b.member_id', team: teamExpr(c, 'b.member_id'), category: 'bt.name' },
      metrics: {
        breaks: 'count(*)',
        totalSeconds: `sum(${dur})`,
        paidSeconds: `sum(CASE WHEN b.is_paid THEN ${dur} ELSE 0 END)`,
        exceeded: 'count(*) FILTER (WHERE b.exceeded)',
      },
      columns: [
        { key: 'breaks', label: 'Breaks', type: 'number' },
        { key: 'totalSeconds', label: 'Total', type: 'seconds' },
        { key: 'paidSeconds', label: 'Paid', type: 'seconds' },
        { key: 'unpaidSeconds', label: 'Unpaid', type: 'seconds' },
        { key: 'exceeded', label: 'Exceeded', type: 'number' },
      ],
      derive: (r) => {
        r.unpaidSeconds = r.totalSeconds - r.paidSeconds;
      },
      apply(w) {
        w.add('b.organization_id = ?', c.orgId);
        w.raw(`b.started_at >= ${c.p.ws} AND b.started_at < ${c.p.we}`);
        if (c.ids) w.add('b.member_id = ANY(?::uuid[])', c.ids);
      },
    };
  },

  tasks(c) {
    const withAssignee = c.dims.includes('member') || c.dims.includes('team');
    const actual = `(SELECT coalesce(sum(${durExpr('te')}), 0) FROM time_entries te WHERE te.task_id = t.id AND te.deleted_at IS NULL AND te.status <> 'rejected'${withAssignee ? ' AND te.member_id = ta.member_id' : ''})`;
    return {
      from: `FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN board_columns bc ON bc.id = t.column_id
             LEFT JOIN task_categories tc ON tc.id = t.category_id${withAssignee ? ' JOIN task_assignees ta ON ta.task_id = t.id' : ''}`,
      dims: {
        ...timeDims('t.due_date'), project: 't.project_id', task: 't.id', client: 'p.client_id', category: `coalesce(tc.name, '(none)')`,
        member: 'ta.member_id', team: teamExpr(c, 'ta.member_id'),
      },
      metrics: {
        tasks: 'count(*)',
        completed: 'count(*) FILTER (WHERE t.completed_at IS NOT NULL)',
        open: 'count(*) FILTER (WHERE t.completed_at IS NULL)',
        todo: `count(*) FILTER (WHERE t.completed_at IS NULL AND coalesce(bc.category, 'todo') = 'todo')`,
        inProgress: `count(*) FILTER (WHERE t.completed_at IS NULL AND bc.category = 'in_progress')`,
        inReview: `count(*) FILTER (WHERE t.completed_at IS NULL AND bc.category = 'in_review')`,
        overdue: `count(*) FILTER (WHERE t.completed_at IS NULL AND t.due_date < ${c.p.today}::date)`,
        dueInPeriod: `count(*) FILTER (WHERE t.due_date BETWEEN ${c.p.from}::date AND ${c.p.to}::date)`,
        completedOnTime: `count(*) FILTER (WHERE t.due_date BETWEEN ${c.p.from}::date AND ${c.p.to}::date AND t.completed_at IS NOT NULL AND (t.completed_at AT TIME ZONE ${c.p.tz})::date <= t.due_date)`,
        estimatedHours: 'coalesce(sum(t.estimated_hours), 0)',
        actualSeconds: `sum(${actual})`,
      },
      columns: [
        { key: 'tasks', label: 'Tasks', type: 'number' },
        { key: 'completed', label: 'Completed', type: 'number' },
        { key: 'open', label: 'Open', type: 'number' },
        { key: 'todo', label: 'To do', type: 'number' },
        { key: 'inProgress', label: 'In progress', type: 'number' },
        { key: 'inReview', label: 'In review', type: 'number' },
        { key: 'overdue', label: 'Overdue', type: 'number' },
        { key: 'completionPercent', label: 'Completion %', type: 'percent' },
        { key: 'onTimeRate', label: 'On-time %', type: 'percent' },
        { key: 'estimatedHours', label: 'Estimated h', type: 'number' },
        { key: 'actualHours', label: 'Actual h', type: 'number' },
      ],
      derive: (r) => {
        r.completionPercent = pct(r.completed, r.tasks);
        r.onTimeRate = pct(r.completedOnTime, r.dueInPeriod);
        r.estimatedHours = round2(r.estimatedHours);
        r.actualHours = round2(r.actualSeconds / 3600);
      },
      apply(w) {
        w.add('t.organization_id = ?', c.orgId);
        w.raw('t.deleted_at IS NULL AND p.deleted_at IS NULL');
        w.raw(`t.created_at < ${c.p.we} AND (t.completed_at IS NULL OR t.completed_at >= ${c.p.ws})`);
        if (c.ids) {
          if (withAssignee) w.add('ta.member_id = ANY(?::uuid[])', c.ids);
          else w.add('EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.member_id = ANY(?::uuid[]))', c.ids);
        }
        if (c.projectScope) w.add('t.project_id = ANY(?::uuid[])', c.projectScope);
        if (c.filters.projectIds?.length) w.add('t.project_id = ANY(?::uuid[])', c.filters.projectIds);
        if (c.filters.clientIds?.length) w.add('p.client_id = ANY(?::uuid[])', c.filters.clientIds);
      },
    };
  },
};

const DEFAULT_GROUP = {
  time: ['project'], activity: ['member'], apps: ['app'], websites: ['app'], screenshots: ['member'], attendance: ['member'],
  breaks: ['category'], tasks: ['project'],
};

/** Extra permission (beyond reports.view) and plan feature per report type. */
const TYPE_PERMS = { screenshots: 'screenshots.view', apps: 'apps.view', websites: 'apps.view', attendance: 'attendance.view' };
const TYPE_FEATURES = { apps: 'apps', websites: 'apps' };

// ───────────────────────── execution ─────────────────────────

async function makeContext(ctx, def) {
  const tz = await orgTimezone(ctx.orgId);
  const { from, to, today } = await resolveRange(def, tz);
  const filters = def.filters ?? {};
  const ids = await resolveMemberScope(ctx, filters);
  const { ws, we } = await windowFor(from, to, tz);
  const w = where();
  // Typed placeholders, all referenced in every query (see queryGrouped) so Postgres can infer their types.
  const p = {
    tz: `${w.param(tz)}::text`, from: `${w.param(from)}::date`, to: `${w.param(to)}::date`,
    ws: `${w.param(ws)}::timestamptz`, we: `${w.param(we)}::timestamptz`, today: `${w.param(today)}::date`,
  };
  if (filters.teamIds?.length) p.teams = `${w.param(filters.teamIds)}::uuid[]`;
  return { orgId: ctx.orgId, ctx, tz, from, to, today, ws, we, filters, ids, w, p, dims: def.groupBy ?? [] };
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));

async function queryGrouped(spec, c, sqlDims) {
  const exprs = sqlDims.map((d) => {
    const e = spec.dims[d];
    if (!e) throw badRequest(`groupBy '${d}' is not supported for this report type`);
    return e;
  });
  const metricKeys = Object.keys(spec.metrics);
  const sel = [
    ...exprs.map((e, i) => `${e} AS d${i}`),
    ...metricKeys.map((k) => `${spec.metrics[k]} AS "${k}"`),
    ...(spec.appIdentifier && sqlDims.includes('app') ? [`${spec.appIdentifier} AS app_identifier`] : []),
  ];
  const w = where(c.w.params);
  w.raw(Object.values(c.p).map((x) => `${x} IS NOT NULL`).join(' AND '));
  spec.apply(w);
  const sql = `SELECT ${sel.join(', ')} ${spec.from} ${w.sql} ${sqlDims.length ? `GROUP BY ${sqlDims.map((_, i) => i + 1).join(', ')}` : ''} LIMIT ${MAX_ROWS * 4}`;
  const rows = await db.many(sql, w.params);
  return rows.map((r) => {
    const o = {};
    sqlDims.forEach((d, i) => {
      o[ENTITY_DIMS.includes(d) ? `${d}Id` : d] = r[`d${i}`] ?? null;
    });
    for (const k of metricKeys) o[k] = num(r[k]);
    if (r.app_identifier) o._appIdentifier = r.app_identifier;
    return o;
  });
}

const dimKey = (d) => (ENTITY_DIMS.includes(d) ? `${d}Id` : d);

/** Re-aggregate rows by dims (additive metrics summed). */
function regroup(rows, dims, metricKeys, nonAdditive = []) {
  const map = new Map();
  for (const r of rows) {
    const key = dims.map((d) => r[dimKey(d)]).join('\u0001');
    let g = map.get(key);
    if (!g) {
      g = Object.fromEntries(dims.map((d) => [dimKey(d), r[dimKey(d)]]));
      for (const k of metricKeys) g[k] = 0;
      g._n = 0;
      map.set(key, g);
    }
    for (const k of metricKeys) g[k] += nonAdditive.includes(k) ? r[k] * (r.screenshots ?? 1) : r[k];
    g._n += r.screenshots ?? 1;
  }
  return [...map.values()].map((g) => {
    for (const k of nonAdditive) g[k] = g._n ? round2(g[k] / g._n) : 0;
    delete g._n;
    return g;
  });
}

async function runSpec(spec, c, dims) {
  const metricKeys = Object.keys(spec.metrics);
  if (dims.includes('category') && spec.categoryTarget) {
    const sqlDims = [...new Set([...dims.filter((d) => d !== 'category'), 'member', 'app'])];
    const rows = await queryGrouped(spec, c, sqlDims);
    const [rules, catalog] = await Promise.all([loadRules(c.orgId), loadCatalog()]);
    const cats = new Map();
    for (const r of rows) {
      if (!cats.has(r.memberId)) cats.set(r.memberId, await buildCategorizer(c.orgId, r.memberId, { rules, catalog }));
      r.category = cats.get(r.memberId)(spec.categoryTarget, [r.app, r._appIdentifier]);
    }
    return regroup(rows, dims, metricKeys, spec.nonAdditive);
  }
  const rows = await queryGrouped(spec, c, dims);
  for (const r of rows) delete r._appIdentifier;
  return rows;
}

/** Resolve display labels of entity dims in place. */
async function attachLabels(orgId, rows) {
  const collect = (k) => [...new Set(rows.map((r) => r[k]).filter(Boolean))];
  const lookups = {
    member: [`SELECT m.id, trim(u.first_name || ' ' || u.last_name) AS label FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND m.id = ANY($2::uuid[])`],
    team: ['SELECT id, name AS label FROM teams WHERE organization_id = $1 AND id = ANY($2::uuid[])'],
    project: ['SELECT id, name AS label FROM projects WHERE organization_id = $1 AND id = ANY($2::uuid[])'],
    task: ['SELECT id, title AS label FROM tasks WHERE organization_id = $1 AND id = ANY($2::uuid[])'],
    client: ['SELECT id, name AS label FROM clients WHERE organization_id = $1 AND id = ANY($2::uuid[])'],
  };
  const fallback = { member: '(unknown)', team: '(no team)', project: '(no project)', task: '(no task)', client: '(no client)' };
  for (const [dim, [sql]] of Object.entries(lookups)) {
    const key = `${dim}Id`;
    if (!rows.some((r) => key in r)) continue;
    const ids = collect(key);
    const names = new Map(ids.length ? (await db.many(sql, [orgId, ids])).map((x) => [x.id, x.label]) : []);
    for (const r of rows) if (key in r) r[dim] = r[key] ? (names.get(r[key]) ?? fallback[dim]) : fallback[dim];
  }
}

function sortRows(rows, dims, primary) {
  const tdims = dims.filter((d) => TIME_DIMS.includes(d));
  return rows.sort((a, b) => {
    for (const d of tdims) {
      const x = String(a[d] ?? '');
      const y = String(b[d] ?? '');
      if (x !== y) return x < y ? -1 : 1;
    }
    return (b[primary] ?? 0) - (a[primary] ?? 0);
  });
}

function selectMetrics(columns, metrics) {
  if (!metrics?.length) return columns;
  const unknown = metrics.filter((m) => !columns.some((c) => c.key === m));
  if (unknown.length) throw badRequest(`Unknown metrics: ${unknown.join(', ')}`, { available: columns.map((c) => c.key) });
  return columns.filter((c) => metrics.includes(c.key));
}

function shape(rows, dims, columns) {
  const keep = new Set([...dims.flatMap((d) => (ENTITY_DIMS.includes(d) ? [`${d}Id`, d] : [d])), ...columns.map((c) => c.key)]);
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))));
}

function addShare(rows, totals, key) {
  for (const r of rows) r.percent = pct(r[key], totals[key]);
  totals.percent = totals[key] > 0 ? 100 : 0;
}

/**
 * Run a report definition for ctx.
 * @returns {Promise<{reportType, from, to, timezone, groupBy, columns, rows, totals, series, notes?}>}
 */
export async function runReport(ctx, def) {
  const type = def.reportType;
  if (!REPORT_TYPES.includes(type)) throw badRequest(`Unknown report type '${type}'`);
  ctx.require('reports.view');
  if (TYPE_PERMS[type]) ctx.require(TYPE_PERMS[type]);
  if (TYPE_FEATURES[type] && !(await hasFeature(ctx, TYPE_FEATURES[type])))
    throw new AppError(403, 'FEATURE_NOT_IN_PLAN', `Your plan does not include ${TYPE_FEATURES[type]}`, { feature: TYPE_FEATURES[type] });
  const groupBy = [...new Set(def.groupBy?.length ? def.groupBy : (DEFAULT_GROUP[type] ?? []))];
  const bad = groupBy.filter((g) => !GROUP_DIMS.includes(g));
  if (bad.length) throw badRequest(`Invalid groupBy: ${bad.join(', ')}`);
  if (type === 'projects') return projectsReport(ctx, def);
  if (type === 'employees') return employeesReport(ctx, def);

  const c = await makeContext(ctx, { ...def, groupBy });
  if (type === 'tasks') c.projectScope = ctx.can('tasks.view') ? await accessibleProjectIds(ctx, 'tasks.view') : null;
  const spec = SPECS[type](c);
  const columns = selectMetrics(spec.columns, def.metrics);
  const metricKeys = Object.keys(spec.metrics);

  let rows = await runSpec(spec, c, groupBy);
  const [totalRow] = await runSpec(spec, c, []);
  const totals = totalRow ?? Object.fromEntries(metricKeys.map((k) => [k, 0]));
  for (const r of rows) spec.derive?.(r);
  spec.derive?.(totals);
  const primary = columns[0]?.key ?? metricKeys[0];
  if (type === 'apps' || type === 'websites') addShare(rows, totals, 'seconds');

  const seriesDim = groupBy.find((d) => TIME_DIMS.includes(d)) ?? 'day';
  let series;
  if (groupBy.length === 1 && groupBy[0] === seriesDim) series = rows.map((r) => ({ ...r }));
  else {
    series = await runSpec(spec, c, [seriesDim]);
    for (const r of series) spec.derive?.(r);
  }
  series = series.filter((s) => s[seriesDim] !== null).sort((a, b) => String(a[seriesDim]).localeCompare(String(b[seriesDim])));
  series = series.map((s) => ({ date: s[seriesDim], ...Object.fromEntries(columns.map((col) => [col.key, s[col.key]])) }));

  await attachLabels(ctx.orgId, rows);
  rows = sortRows(rows, groupBy, primary).slice(0, MAX_ROWS);
  return {
    reportType: type,
    from: c.from,
    to: c.to,
    timezone: c.tz,
    groupBy,
    columns: [...groupBy.map((d) => DIM_COLUMNS[d]), ...columns],
    rows: shape(rows, groupBy, columns),
    totals: Object.fromEntries(columns.map((col) => [col.key, totals[col.key] ?? 0])),
    series,
    ...(spec.notes?.length ? { notes: spec.notes } : {}),
  };
}

// ───────────────────────── projects report (RPT-P01…P06) ─────────────────────────

async function visibleProjects(ctx) {
  if (ctx.can('projects.view')) return accessibleProjectIds(ctx, 'projects.view');
  return memberProjectIds(ctx);
}

export async function projectRows(ctx, def, c) {
  const pids = await visibleProjects(ctx);
  const w = where([ctx.orgId]);
  w.raw('p.organization_id = $1 AND p.deleted_at IS NULL');
  if (pids) w.add('p.id = ANY(?::uuid[])', pids);
  if (c.filters.projectIds?.length) w.add('p.id = ANY(?::uuid[])', c.filters.projectIds);
  if (c.filters.clientIds?.length) w.add('p.client_id = ANY(?::uuid[])', c.filters.clientIds);
  const tz = c.tz;
  const projects = await db.many(
    `SELECT p.id, p.name, p.status, p.deadline, p.start_date, p.budget_type, p.budget_value, p.progress_mode, p.progress_manual,
            p.currency, p.client_id, cl.name AS client_name, p.archived_at,
            (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL) AS tasks,
            (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.completed_at IS NOT NULL) AS completed_tasks,
            (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.completed_at IS NULL
               AND t.due_date < (now() AT TIME ZONE ${w.param(tz)}::text)::date) AS overdue_tasks
     FROM projects p LEFT JOIN clients cl ON cl.id = p.client_id ${w.sql} ORDER BY p.name LIMIT ${MAX_ROWS}`,
    w.params,
  );
  // Period hours/cost (scoped to accessible members) and lifetime totals for budget usage.
  const period = await runSpec(SPECS.time(c), c, ['project']);
  // lifetime: no period window (budget usage spans the whole project)
  const allTime = { ...c, lifetime: true };
  const lifetime = await runSpec(SPECS.time(allTime), allTime, ['project']);
  const per = new Map(period.map((r) => [r.projectId, r]));
  const life = new Map(lifetime.map((r) => [r.projectId, r]));
  return projects.map((p) => {
    const r = per.get(p.id) ?? {};
    const l = life.get(p.id) ?? {};
    const budget = p.budget_value === null ? null : Number(p.budget_value);
    const used = p.budget_type === 'hours' ? round2((l.trackedSeconds ?? 0) / 3600) : p.budget_type === 'amount' ? round2(l.billableAmount ?? 0) : null;
    const budgetUsedPercent = budget && used !== null ? round2((used / budget) * 100) : null;
    const progress = p.progress_mode === 'manual' ? (p.progress_manual ?? 0) : p.tasks > 0 ? Math.round((p.completed_tasks / p.tasks) * 100) : 0;
    const deadlinePassed = !!p.deadline && p.deadline < c.today && p.status !== 'completed';
    return {
      projectId: p.id,
      project: p.name,
      clientId: p.client_id,
      client: p.client_name ?? '(no client)',
      status: p.status,
      deadline: p.deadline,
      trackedSeconds: r.trackedSeconds ?? 0,
      billableSeconds: r.billableSeconds ?? 0,
      cost: round2(r.cost ?? 0),
      billableAmount: round2(r.billableAmount ?? 0),
      lifetimeSeconds: l.trackedSeconds ?? 0,
      lifetimeCost: round2(l.cost ?? 0),
      budgetType: p.budget_type,
      budget,
      budgetUsed: used,
      budgetUsedPercent,
      progress,
      tasks: p.tasks,
      completedTasks: p.completed_tasks,
      overdueTasks: p.overdue_tasks,
      completionPercent: pct(p.completed_tasks, p.tasks),
      atRisk: deadlinePassed || (budgetUsedPercent !== null && budgetUsedPercent > 90),
      overBudget: budgetUsedPercent !== null && budgetUsedPercent > 100,
    };
  });
}

const PROJECT_COLUMNS = [
  { key: 'project', label: 'Project', type: 'string' },
  { key: 'client', label: 'Client', type: 'string' },
  { key: 'status', label: 'Status', type: 'string' },
  { key: 'trackedSeconds', label: 'Tracked', type: 'seconds' },
  { key: 'billableSeconds', label: 'Billable', type: 'seconds' },
  { key: 'cost', label: 'Cost', type: 'money' },
  { key: 'billableAmount', label: 'Billable amount', type: 'money' },
  { key: 'budgetUsedPercent', label: 'Budget used %', type: 'percent' },
  { key: 'progress', label: 'Progress %', type: 'percent' },
  { key: 'tasks', label: 'Tasks', type: 'number' },
  { key: 'completedTasks', label: 'Completed', type: 'number' },
  { key: 'overdueTasks', label: 'Overdue', type: 'number' },
  { key: 'completionPercent', label: 'Completion %', type: 'percent' },
];

async function projectsReport(ctx, def) {
  const c = await makeContext(ctx, { ...def, groupBy: [] });
  let rows = await projectRows(ctx, def, c);
  if (def.filters?.projectIds?.length || def.includeEmpty) {
    /* keep all */
  } else rows = rows.filter((r) => r.trackedSeconds > 0 || r.status === 'active' || r.tasks > 0);
  const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const totals = {
    projects: rows.length,
    trackedSeconds: sum('trackedSeconds'),
    billableSeconds: sum('billableSeconds'),
    cost: round2(sum('cost')),
    billableAmount: round2(sum('billableAmount')),
    tasks: sum('tasks'),
    completedTasks: sum('completedTasks'),
    overdueTasks: sum('overdueTasks'),
    completionPercent: pct(sum('completedTasks'), sum('tasks')),
  };
  const spec = SPECS.time(c);
  const series = (await runSpec(spec, c, ['day'])).map((s) => {
    spec.derive(s);
    return { date: s.day, trackedSeconds: s.trackedSeconds, billableSeconds: s.billableSeconds, cost: s.cost };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const columns = selectMetrics(PROJECT_COLUMNS, def.metrics);
  return {
    reportType: 'projects', from: c.from, to: c.to, timezone: c.tz, groupBy: ['project'], columns,
    rows: rows.sort((a, b) => b.trackedSeconds - a.trackedSeconds),
    totals, series,
  };
}

/** Project detail report (RPT-P01…P06): hours, cost, progress, completion and member contribution. */
export async function projectDetail(ctx, projectId, def) {
  const c = await makeContext(ctx, { ...def, groupBy: [], filters: { ...(def.filters ?? {}), projectIds: [projectId] } });
  const [summary] = await projectRows(ctx, def, c);
  if (!summary) return null;
  const spec = SPECS.time(c);
  const derive = (rows) => rows.map((r) => (spec.derive(r), r));
  const byMember = derive(await runSpec(spec, c, ['member']));
  const byTask = derive(await runSpec(spec, c, ['task']));
  const byDay = derive(await runSpec(spec, c, ['day']));
  await attachLabels(ctx.orgId, byMember);
  await attachLabels(ctx.orgId, byTask);
  const total = byMember.reduce((s, r) => s + r.trackedSeconds, 0);
  const tasksByStatus = await db.many(
    `SELECT CASE WHEN t.completed_at IS NOT NULL THEN 'done' ELSE coalesce(bc.category, 'todo') END AS status, count(*)::int AS n
     FROM tasks t LEFT JOIN board_columns bc ON bc.id = t.column_id WHERE t.project_id = $1 AND t.deleted_at IS NULL GROUP BY 1`,
    [projectId],
  );
  return {
    project: summary,
    from: c.from,
    to: c.to,
    contribution: byMember
      .map((r) => ({ memberId: r.memberId, member: r.member, trackedSeconds: r.trackedSeconds, cost: r.cost, contributionPercent: pct(r.trackedSeconds, total) }))
      .sort((a, b) => b.trackedSeconds - a.trackedSeconds),
    tasks: byTask.map((r) => ({ taskId: r.taskId, task: r.task, trackedSeconds: r.trackedSeconds })).sort((a, b) => b.trackedSeconds - a.trackedSeconds),
    tasksByStatus: Object.fromEntries(tasksByStatus.map((r) => [r.status, r.n])),
    series: byDay.map((r) => ({ date: r.day, trackedSeconds: r.trackedSeconds, cost: r.cost })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// ───────────────────────── employees report (RPT-E01…E08) ─────────────────────────

const EMPLOYEE_COLUMNS = [
  { key: 'member', label: 'Member', type: 'string' },
  { key: 'trackedSeconds', label: 'Tracked', type: 'seconds' },
  { key: 'activeSeconds', label: 'Active', type: 'seconds' },
  { key: 'idleSeconds', label: 'Idle', type: 'seconds' },
  { key: 'activityPercent', label: 'Activity %', type: 'percent' },
  { key: 'productiveRatio', label: 'Productive %', type: 'percent' },
  { key: 'overtimeSeconds', label: 'Overtime', type: 'seconds' },
  { key: 'screenshotCount', label: 'Screenshots', type: 'number' },
  { key: 'presentDays', label: 'Present days', type: 'number' },
  { key: 'lateDays', label: 'Late days', type: 'number' },
  { key: 'absentDays', label: 'Absent days', type: 'number' },
  { key: 'tasksCompleted', label: 'Tasks completed', type: 'number' },
  { key: 'taskCompletionRate', label: 'Task completion %', type: 'percent' },
  { key: 'productivityScore', label: 'Productivity score', type: 'number' },
];

async function employeesReport(ctx, def) {
  const c = await makeContext(ctx, { ...def, groupBy: [] });
  const members = await listMembers(ctx.orgId, c.ids);
  const weights = await productivityWeights(ctx.orgId);
  const metrics = await memberMetrics(ctx.orgId, members.map((m) => m.id), c.from, c.to, c.tz, weights);
  const rows = members.map((m) => ({ memberId: m.id, member: m.name, ...metrics.get(m.id) }));
  const columns = selectMetrics(EMPLOYEE_COLUMNS, def.metrics);
  const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const tracked = sum('trackedSeconds');
  const totals = {
    members: rows.length,
    trackedSeconds: tracked,
    activeSeconds: sum('activeSeconds'),
    idleSeconds: sum('idleSeconds'),
    activityPercent: tracked > 0 ? round2(rows.reduce((s, r) => s + r.activityPercent * r.trackedSeconds, 0) / tracked) : 0,
    overtimeSeconds: sum('overtimeSeconds'),
    screenshotCount: sum('screenshotCount'),
    tasksCompleted: sum('tasksCompleted'),
  };
  const spec = SPECS.activity(c);
  const series = (await runSpec(spec, c, ['day'])).map((s) => {
    spec.derive(s);
    return { date: s.day, trackedSeconds: s.trackedSeconds, activityPercent: s.activityPercent };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return {
    reportType: 'employees', from: c.from, to: c.to, timezone: c.tz, groupBy: ['member'], columns,
    rows: rows.sort((a, b) => b.trackedSeconds - a.trackedSeconds), totals, series, disclaimer: SCORE_DISCLAIMER,
  };
}

export { makeContext, runSpec, SPECS, attachLabels };
