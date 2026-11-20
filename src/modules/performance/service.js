import { db } from '../../lib/db.js';
import { expectedSecondsForDate } from '../time/summary-service.js';
import { windowFor, eachDay, round2, startOfWeek, addDays } from '../reports/common.js';

/**
 * Performance & productivity metrics (PERF-01…19). All metrics are computed from daily_summaries,
 * tasks/task_assignees and attendance_records; never from raw keystroke content.
 */

export const SCORE_DISCLAIMER =
  'The productivity score is an indicator derived from activity levels, application/website categorization and task completion. ' +
  'It is not a complete measure of performance and should be considered together with context and conversation.';

export const DEFAULT_WEIGHTS = { activity: 0.4, productive: 0.4, tasks: 0.2 };

/** Whitelisted metric names usable in goals and custom metrics (PERF-17, PERF-19). */
export const METRIC_NAMES = [
  'trackedHours', 'activityPercent', 'productiveRatio', 'tasksCompleted', 'taskCompletionRate', 'overtimeHours', 'lateDays',
];

export async function productivityWeights(orgId) {
  const r = await db.one('SELECT productivity_weights FROM organization_settings WHERE organization_id = $1', [orgId]);
  const w = { ...DEFAULT_WEIGHTS, ...(r?.productivity_weights ?? {}) };
  return { activity: Number(w.activity) || 0, productive: Number(w.productive) || 0, tasks: Number(w.tasks) || 0 };
}

/**
 * Productivity score 0–100 = weighted mean of available terms (activity %, productive ratio %, task completion %).
 * Terms without data are left out and the remaining weights are renormalized; null when nothing is available.
 */
export function computeScore(weights, m) {
  const terms = [];
  if (m.trackedSeconds > 0) terms.push([weights.activity, m.activityPercent]);
  if (m.productiveRatio !== null && m.productiveRatio !== undefined) terms.push([weights.productive, m.productiveRatio]);
  if (m.taskCompletionRate !== null && m.taskCompletionRate !== undefined) terms.push([weights.tasks, m.taskCompletionRate]);
  const wsum = terms.reduce((s, [w]) => s + w, 0);
  if (!terms.length || wsum <= 0) return null;
  return round2(terms.reduce((s, [w, v]) => s + w * v, 0) / wsum);
}

const emptyRaw = () => ({
  tracked: 0, active: 0, idle: 0, brk: 0, prod: 0, unprod: 0, neut: 0, ot: 0, wact: 0, shots: 0, billable: 0, daysWorked: 0,
  due: 0, onTime: 0, completed: 0, late: 0, absent: 0, present: 0,
});

/** Derive API metrics from additive raw sums. */
export function deriveMetrics(r) {
  const usage = r.prod + r.unprod + r.neut;
  return {
    trackedSeconds: r.tracked,
    activeSeconds: r.active,
    idleSeconds: r.idle,
    breakSeconds: r.brk,
    billableSeconds: r.billable,
    overtimeSeconds: r.ot,
    productiveSeconds: r.prod,
    unproductiveSeconds: r.unprod,
    neutralSeconds: r.neut,
    activityPercent: r.tracked > 0 ? round2(r.wact / r.tracked) : 0,
    productiveRatio: usage > 0 ? round2((r.prod / usage) * 100) : null,
    screenshotCount: r.shots,
    daysWorked: r.daysWorked,
    tasksDue: r.due,
    tasksCompletedOnTime: r.onTime,
    tasksCompleted: r.completed,
    taskCompletionRate: r.due > 0 ? round2((r.onTime / r.due) * 100) : null,
    lateDays: r.late,
    absentDays: r.absent,
    presentDays: r.present,
  };
}

export function sumRaw(list) {
  const out = emptyRaw();
  for (const r of list) for (const k of Object.keys(out)) out[k] += r[k] ?? 0;
  return out;
}

/**
 * Raw additive sums per member over [from, to] (local dates).
 * @returns {Promise<Map<string, object>>}
 */
export async function rawMemberMetrics(orgId, memberIds, from, to, tz) {
  const out = new Map(memberIds.map((id) => [id, emptyRaw()]));
  if (!memberIds.length) return out;
  const { ws, we } = await windowFor(from, to, tz);
  const s = await db.many(
    `SELECT member_id, sum(tracked_seconds)::bigint tracked, sum(active_seconds)::bigint active, sum(idle_seconds)::bigint idle,
            sum(break_seconds)::bigint brk, sum(productive_seconds)::bigint prod, sum(unproductive_seconds)::bigint unprod,
            sum(neutral_seconds)::bigint neut, sum(overtime_seconds)::bigint ot, sum(activity_percent::bigint * tracked_seconds)::bigint wact,
            sum(screenshot_count)::bigint shots, sum(billable_seconds)::bigint billable, count(*) FILTER (WHERE tracked_seconds > 0) AS days_worked
     FROM daily_summaries WHERE organization_id = $1 AND member_id = ANY($2::uuid[]) AND date BETWEEN $3 AND $4 GROUP BY member_id`,
    [orgId, memberIds, from, to],
  );
  for (const r of s) {
    Object.assign(out.get(r.member_id), {
      tracked: r.tracked, active: r.active, idle: r.idle, brk: r.brk, prod: r.prod, unprod: r.unprod, neut: r.neut,
      ot: r.ot, wact: r.wact, shots: r.shots, billable: r.billable, daysWorked: r.days_worked,
    });
  }
  const t = await db.many(
    `SELECT ta.member_id,
            count(*) FILTER (WHERE t.due_date BETWEEN $3 AND $4) AS due,
            count(*) FILTER (WHERE t.due_date BETWEEN $3 AND $4 AND t.completed_at IS NOT NULL
                             AND (t.completed_at AT TIME ZONE $7)::date <= t.due_date) AS on_time,
            count(*) FILTER (WHERE t.completed_at >= $5 AND t.completed_at < $6) AS completed
     FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
     WHERE t.organization_id = $1 AND t.deleted_at IS NULL AND ta.member_id = ANY($2::uuid[]) GROUP BY ta.member_id`,
    [orgId, memberIds, from, to, ws, we, tz],
  );
  for (const r of t) Object.assign(out.get(r.member_id), { due: r.due, onTime: r.on_time, completed: r.completed });
  const a = await db.many(
    `SELECT member_id, count(*) FILTER (WHERE status = 'late') AS late, count(*) FILTER (WHERE status = 'absent') AS absent,
            count(*) FILTER (WHERE status IN ('present','late','half_day')) AS present
     FROM attendance_records WHERE organization_id = $1 AND member_id = ANY($2::uuid[]) AND date BETWEEN $3 AND $4 GROUP BY member_id`,
    [orgId, memberIds, from, to],
  );
  for (const r of a) Object.assign(out.get(r.member_id), { late: r.late, absent: r.absent, present: r.present });
  await addWeeklyOvertime(orgId, memberIds, from, to, out);
  return out;
}

/** Weekly overtime (overtime_mode weekly/both): tracked per ISO week above weekly_hours (minus daily overtime already counted). */
async function addWeeklyOvertime(orgId, memberIds, from, to, out) {
  const st = await db.one('SELECT overtime_mode FROM organization_settings WHERE organization_id = $1', [orgId]);
  if (!['weekly', 'both'].includes(st?.overtime_mode ?? 'weekly')) return;
  const rows = await db.many(
    `SELECT s.member_id, date_trunc('week', s.date)::date AS wk, sum(s.tracked_seconds)::bigint tracked, sum(s.overtime_seconds)::bigint ot,
            max(m.weekly_hours) AS weekly_hours
     FROM daily_summaries s JOIN organization_members m ON m.id = s.member_id
     WHERE s.organization_id = $1 AND s.member_id = ANY($2::uuid[]) AND s.date BETWEEN $3 AND $4
     GROUP BY s.member_id, 2`,
    [orgId, memberIds, from, to],
  );
  for (const r of rows) {
    const extra = Math.max(0, r.tracked - Math.round(Number(r.weekly_hours) * 3600) - r.ot);
    out.get(r.member_id).ot += extra;
  }
}

/** Metrics + score for each member. @returns {Promise<Map<string, object>>} */
export async function memberMetrics(orgId, memberIds, from, to, tz, weights) {
  weights = weights ?? (await productivityWeights(orgId));
  const raw = await rawMemberMetrics(orgId, memberIds, from, to, tz);
  const out = new Map();
  for (const [id, r] of raw) {
    const m = deriveMetrics(r);
    m.productivityScore = computeScore(weights, m);
    out.set(id, m);
  }
  return out;
}

/** Aggregate (team) metrics from raw sums. */
export async function aggregateMetrics(orgId, memberIds, from, to, tz, weights) {
  weights = weights ?? (await productivityWeights(orgId));
  const raw = await rawMemberMetrics(orgId, memberIds, from, to, tz);
  const m = deriveMetrics(sumRaw([...raw.values()]));
  m.productivityScore = computeScore(weights, m);
  return { metrics: m, raw };
}

/** Value of a whitelisted metric. */
export function metricValue(m, name) {
  switch (name) {
    case 'trackedHours':
      return round2(m.trackedSeconds / 3600);
    case 'activityPercent':
      return m.activityPercent ?? 0;
    case 'productiveRatio':
      return m.productiveRatio ?? 0;
    case 'tasksCompleted':
      return m.tasksCompleted ?? 0;
    case 'taskCompletionRate':
      return m.taskCompletionRate ?? 0;
    case 'overtimeHours':
      return round2((m.overtimeSeconds ?? 0) / 3600);
    case 'lateDays':
      return m.lateDays ?? 0;
    case 'productivityScore':
      return m.productivityScore ?? 0;
    default:
      return 0;
  }
}

const BUCKET = {
  day: (c) => `to_char(${c}, 'YYYY-MM-DD')`,
  week: (c) => `to_char(date_trunc('week', ${c})::date, 'YYYY-MM-DD')`,
  month: (c) => `to_char(${c}, 'YYYY-MM')`,
};

/** Time series of aggregated metrics for a member set (PERF-04…07, PERF-12). */
export async function trend(orgId, memberIds, from, to, tz, granularity = 'day', weights) {
  weights = weights ?? (await productivityWeights(orgId));
  const b = BUCKET[granularity];
  const rows = await db.many(
    `SELECT ${b('s.date')} AS period, sum(tracked_seconds)::bigint tracked, sum(active_seconds)::bigint active, sum(idle_seconds)::bigint idle,
            sum(break_seconds)::bigint brk, sum(productive_seconds)::bigint prod, sum(unproductive_seconds)::bigint unprod,
            sum(neutral_seconds)::bigint neut, sum(overtime_seconds)::bigint ot, sum(activity_percent::bigint * tracked_seconds)::bigint wact,
            sum(screenshot_count)::bigint shots, sum(billable_seconds)::bigint billable, count(*) FILTER (WHERE tracked_seconds > 0) AS days_worked
     FROM daily_summaries s WHERE organization_id = $1 AND member_id = ANY($2::uuid[]) AND date BETWEEN $3 AND $4 GROUP BY 1`,
    [orgId, memberIds, from, to],
  );
  const tasks = await db.many(
    `SELECT ${b('t.due_date')} AS period, count(*) AS due,
            count(*) FILTER (WHERE t.completed_at IS NOT NULL AND (t.completed_at AT TIME ZONE $5)::date <= t.due_date) AS on_time
     FROM tasks t WHERE t.organization_id = $1 AND t.deleted_at IS NULL AND t.due_date BETWEEN $3 AND $4
       AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.member_id = ANY($2::uuid[])) GROUP BY 1`,
    [orgId, memberIds, from, to, tz],
  );
  const map = new Map();
  const get = (p) => {
    if (!map.has(p)) map.set(p, emptyRaw());
    return map.get(p);
  };
  for (const d of eachDay(from, to)) {
    const key = granularity === 'day' ? d : granularity === 'week' ? startOfWeek(d) : d.slice(0, 7);
    get(key);
  }
  for (const r of rows)
    Object.assign(get(r.period), {
      tracked: r.tracked, active: r.active, idle: r.idle, brk: r.brk, prod: r.prod, unprod: r.unprod, neut: r.neut, ot: r.ot,
      wact: r.wact, shots: r.shots, billable: r.billable, daysWorked: r.days_worked,
    });
  for (const r of tasks) Object.assign(get(r.period), { due: r.due, onTime: r.on_time });
  return [...map.entries()]
    .sort(([a], [b2]) => a.localeCompare(b2))
    .map(([period, raw]) => {
      const m = deriveMetrics(raw);
      return {
        period,
        trackedSeconds: m.trackedSeconds,
        activeSeconds: m.activeSeconds,
        idleSeconds: m.idleSeconds,
        productiveSeconds: m.productiveSeconds,
        activityPercent: m.activityPercent,
        productiveRatio: m.productiveRatio,
        taskCompletionRate: m.taskCompletionRate,
        productivityScore: computeScore(weights, m),
      };
    });
}

/**
 * Working-hour consistency (PERF-11): 100 − normalized RMS deviation of daily tracked vs expected seconds
 * (days with expected > 0 or tracked > 0, up to today). Deviations are normalized by the mean expected day.
 */
export async function consistency(orgId, memberId, from, to, today) {
  const end = to < today ? to : today;
  if (end < from) return { score: null, days: [] };
  const rows = await db.many(
    `SELECT to_char(date, 'YYYY-MM-DD') AS d, tracked_seconds FROM daily_summaries WHERE organization_id = $1 AND member_id = $2 AND date BETWEEN $3 AND $4`,
    [orgId, memberId, from, end],
  );
  const tracked = new Map(rows.map((r) => [r.d, r.tracked_seconds]));
  const days = [];
  for (const d of eachDay(from, end)) {
    const expected = await expectedSecondsForDate(memberId, d);
    const t = tracked.get(d) ?? 0;
    if (expected > 0 || t > 0) days.push({ date: d, trackedSeconds: t, expectedSeconds: expected });
  }
  if (!days.length) return { score: null, days };
  const working = days.filter((x) => x.expectedSeconds > 0);
  const norm = working.length ? working.reduce((s, x) => s + x.expectedSeconds, 0) / working.length : 8 * 3600;
  const rms = Math.sqrt(days.reduce((s, x) => s + ((x.trackedSeconds - x.expectedSeconds) / norm) ** 2, 0) / days.length);
  return { score: round2(Math.max(0, 100 - Math.min(100, rms * 100))), days };
}

/** Project contribution (PERF-09): member hours per project ÷ project total hours in period. */
export async function projectContribution(orgId, memberId, ws, we) {
  const rows = await db.many(
    `WITH e AS (
       SELECT project_id, member_id, CASE WHEN ended_at IS NULL THEN greatest(extract(epoch FROM now() - started_at)::int - paused_seconds, 0) ELSE duration_seconds END AS dur
       FROM time_entries WHERE organization_id = $1 AND deleted_at IS NULL AND status <> 'rejected' AND project_id IS NOT NULL
         AND started_at >= $3 AND started_at < $4)
     SELECT p.id, p.name, sum(e.dur) FILTER (WHERE e.member_id = $2)::bigint AS member_seconds, sum(e.dur)::bigint AS project_seconds
     FROM e JOIN projects p ON p.id = e.project_id
     GROUP BY p.id, p.name HAVING sum(e.dur) FILTER (WHERE e.member_id = $2) > 0 ORDER BY 3 DESC`,
    [orgId, memberId, ws, we],
  );
  return rows.map((r) => ({
    projectId: r.id,
    projectName: r.name,
    memberSeconds: r.member_seconds,
    projectSeconds: r.project_seconds,
    contributionPercent: r.project_seconds > 0 ? round2((r.member_seconds / r.project_seconds) * 100) : 0,
  }));
}

/** Estimated vs actual (PERF-10) for tasks assigned to the members and active in the window. */
export async function estimatedVsActual(orgId, memberIds, ws, we) {
  const rows = await db.many(
    `SELECT t.id, t.title, t.project_id, t.estimated_hours, t.completed_at, t.due_date,
            (SELECT coalesce(sum(CASE WHEN e.ended_at IS NULL THEN greatest(extract(epoch FROM now() - e.started_at)::int - e.paused_seconds, 0) ELSE e.duration_seconds END), 0)
             FROM time_entries e WHERE e.task_id = t.id AND e.deleted_at IS NULL AND e.status <> 'rejected' AND e.member_id = ANY($2::uuid[]))::bigint AS actual_seconds
     FROM tasks t
     WHERE t.organization_id = $1 AND t.deleted_at IS NULL AND t.estimated_hours IS NOT NULL
       AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.member_id = ANY($2::uuid[]))
       AND t.created_at < $4 AND (t.completed_at IS NULL OR t.completed_at >= $3)
     ORDER BY t.due_date NULLS LAST LIMIT 200`,
    [orgId, memberIds, ws, we],
  );
  const tasks = rows.map((r) => {
    const est = Number(r.estimated_hours);
    const act = round2(r.actual_seconds / 3600);
    return {
      taskId: r.id, title: r.title, projectId: r.project_id, estimatedHours: est, actualHours: act,
      varianceHours: round2(act - est), variancePercent: est > 0 ? round2(((act - est) / est) * 100) : null,
      completed: !!r.completed_at,
    };
  });
  const estimatedHours = round2(tasks.reduce((s, t) => s + t.estimatedHours, 0));
  const actualHours = round2(tasks.reduce((s, t) => s + t.actualHours, 0));
  return { estimatedHours, actualHours, varianceHours: round2(actualHours - estimatedHours), tasks };
}

/** Period bounds containing `today` for goals ('day' | 'week' | 'month'). */
export function currentPeriod(period, today) {
  if (period === 'day') return { from: today, to: today };
  if (period === 'week') return { from: startOfWeek(today), to: addDays(startOfWeek(today), 6) };
  const from = `${today.slice(0, 7)}-01`;
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return { from, to: d.toISOString().slice(0, 10) };
}

/** Previous complete period before the one containing `today`. */
export function previousGoalPeriod(period, today) {
  const cur = currentPeriod(period, today);
  return currentPeriod(period, addDays(cur.from, -1));
}

const SUM_METRICS = ['trackedHours', 'tasksCompleted', 'overtimeHours', 'lateDays'];

/** Evaluate a goal for a period: team goals sum additive metrics and use the aggregate for ratios. */
export async function evaluateGoal(goal, from, to, tz) {
  let memberIds = [goal.scope_id];
  if (goal.scope_type === 'team')
    memberIds = (await db.many('SELECT member_id FROM team_members WHERE team_id = $1', [goal.scope_id])).map((r) => r.member_id);
  const { metrics } = await aggregateMetrics(goal.organization_id, memberIds, from, to, tz);
  const value = metricValue(metrics, goal.metric);
  const target = Number(goal.target);
  let progress;
  if (goal.comparator === 'gte') progress = target > 0 ? Math.min(100, round2((value / target) * 100)) : 100;
  else progress = value <= target ? 100 : value > 0 ? round2((target / value) * 100) : 100;
  const met = goal.comparator === 'gte' ? value >= target : value <= target;
  return { value, target, progress, met, periodFrom: from, periodTo: to, aggregated: SUM_METRICS.includes(goal.metric) ? 'sum' : 'aggregate' };
}
