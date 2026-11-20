import { db } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { accessibleProjectIds, memberProjectIds, assertProjectAccess } from '../../rbac/scope.js';
import {
  orgTimezone, resolveRange, resolveMemberScope, previousPeriod, windowFor, listMembers, round2, pct,
} from '../reports/common.js';
import { rawMemberMetrics, sumRaw, deriveMetrics } from '../performance/service.js';

/**
 * Dashboard KPIs (RPT-D01…D14, ADM-10…12, ADM-20…23). Responses are cached in memory for 30 s per
 * organization + caller scope + parameters.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map();

export function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = fn();
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  value.catch(() => cache.delete(key));
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return value;
}

export function clearDashboardCache() {
  cache.clear();
}

/** Cache key: org + caller scope (member id unless org-wide) + params. */
export function cacheKey(ctx, name, params) {
  const scope = ctx.can('reports.view') === 'org' ? 'org' : ctx.memberId;
  return `${name}:${ctx.orgId}:${scope}:${JSON.stringify(params)}`;
}

/** Members of a project (direct + through teams). */
async function projectMemberIds(orgId, projectId) {
  const rows = await db.many(
    `SELECT pm.member_id AS id FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.project_id = $1 AND p.organization_id = $2
     UNION SELECT tm.member_id FROM project_teams pt JOIN team_members tm ON tm.team_id = pt.team_id JOIN projects p ON p.id = pt.project_id
     WHERE pt.project_id = $1 AND p.organization_id = $2
     UNION SELECT DISTINCT e.member_id FROM time_entries e WHERE e.project_id = $1 AND e.organization_id = $2 AND e.deleted_at IS NULL`,
    [projectId, orgId],
  );
  return rows.map((r) => r.id);
}

/**
 * Resolve the dashboard scope: member set (filters ∩ permission scope) and date range.
 */
export async function dashboardScope(ctx, q, fallbackRange = 'today') {
  const tz = await orgTimezone(ctx.orgId);
  const range = await resolveRange(q, tz, fallbackRange);
  let ids = await resolveMemberScope(ctx, {
    memberIds: q.memberId ? [q.memberId] : undefined,
    teamIds: q.teamId ? [q.teamId] : undefined,
  });
  if (q.projectId) {
    const p = await db.one('SELECT id FROM projects WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [q.projectId, ctx.orgId]);
    if (!p) throw badRequest('Unknown project', undefined, 'INVALID_REFERENCE');
    if (ctx.can('projects.view') && ctx.can('reports.view') !== 'org') await assertProjectAccess(ctx, 'projects.view', q.projectId);
    const pm = await projectMemberIds(ctx.orgId, q.projectId);
    ids = ids ? ids.filter((i) => pm.includes(i)) : pm;
  }
  const members = await listMembers(ctx.orgId, ids, { includeInactive: true });
  return { tz, ...range, ids, members, memberIds: members.map((m) => m.id) };
}

/** Period metrics for the member set (optionally restricted to one project via time entries). */
async function periodMetrics(orgId, memberIds, from, to, tz, projectId) {
  const raw = await rawMemberMetrics(orgId, memberIds, from, to, tz);
  const m = deriveMetrics(sumRaw([...raw.values()]));
  const out = {
    totalWorkingSeconds: m.trackedSeconds,
    productiveSeconds: m.productiveSeconds,
    unproductiveSeconds: m.unproductiveSeconds,
    idleSeconds: m.idleSeconds,
    breakSeconds: m.breakSeconds,
    avgActivityPercent: m.activityPercent,
    overtimeSeconds: m.overtimeSeconds,
    billableSeconds: m.billableSeconds,
    trackedEmployees: [...raw.values()].filter((r) => r.tracked > 0).length,
    completedTasksInPeriod: m.tasksCompleted,
  };
  if (projectId && memberIds.length) {
    const { ws, we } = await windowFor(from, to, tz);
    const t = await db.one(
      `SELECT coalesce(sum(CASE WHEN ended_at IS NULL THEN greatest(extract(epoch FROM now() - started_at)::int - paused_seconds, 0) ELSE duration_seconds END), 0)::bigint AS tracked,
              coalesce(sum(active_seconds), 0)::bigint AS active, coalesce(sum(idle_seconds), 0)::bigint AS idle,
              coalesce(sum(duration_seconds) FILTER (WHERE is_billable), 0)::bigint AS billable,
              count(DISTINCT member_id) AS members
       FROM time_entries WHERE organization_id = $1 AND project_id = $2 AND member_id = ANY($3::uuid[]) AND deleted_at IS NULL
         AND status <> 'rejected' AND started_at >= $4 AND started_at < $5`,
      [orgId, projectId, memberIds, ws, we],
    );
    out.totalWorkingSeconds = t.tracked;
    out.idleSeconds = t.idle;
    out.billableSeconds = t.billable;
    out.avgActivityPercent = t.tracked > 0 ? round2((t.active / t.tracked) * 100) : 0;
    out.trackedEmployees = t.members;
  }
  return out;
}

/** Projects visible to ctx (null = all), narrowed by filters. */
export async function scopedProjectIds(ctx, q, memberIds) {
  let pids = ctx.can('projects.view') ? await accessibleProjectIds(ctx, 'projects.view') : await memberProjectIds(ctx);
  if (q.projectId) pids = pids ? pids.filter((p) => p === q.projectId) : [q.projectId];
  if (q.teamId) {
    const rows = await db.many(
      `SELECT project_id AS id FROM project_teams WHERE team_id = $1
       UNION SELECT project_id FROM project_members WHERE member_id = ANY($2::uuid[])`,
      [q.teamId, memberIds],
    );
    const t = rows.map((r) => r.id);
    pids = pids ? pids.filter((p) => t.includes(p)) : t;
  }
  return pids;
}

async function projectTaskCounts(ctx, q, scope) {
  const pids = await scopedProjectIds(ctx, q, scope.memberIds);
  const proj = await db.one(
    `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'completed') AS completed
     FROM projects WHERE organization_id = $1 AND deleted_at IS NULL AND archived_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
    [ctx.orgId, pids],
  );
  // Restricted member scope (own/team or member/team filter) → only tasks assigned to those members.
  const restrict = scope.ids !== null || !!q.memberId || !!q.teamId;
  const tasks = await db.one(
    `SELECT count(*) AS total, count(*) FILTER (WHERE t.completed_at IS NOT NULL) AS completed,
            count(*) FILTER (WHERE t.completed_at IS NULL) AS pending,
            count(*) FILTER (WHERE t.completed_at IS NULL AND t.due_date < $5::date) AS overdue
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.organization_id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL
       AND ($2::uuid[] IS NULL OR t.project_id = ANY($2::uuid[]))
       AND (NOT $3 OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.member_id = ANY($4::uuid[])))`,
    [ctx.orgId, pids, restrict, scope.memberIds, scope.today],
  );
  return { projects: proj, tasks };
}

/** Attendance summary for a local date (ADM-12). */
export async function attendanceSummary(orgId, memberIds, date) {
  const r = await db.one(
    `SELECT count(*) FILTER (WHERE status IN ('present','late','half_day')) AS present, count(*) FILTER (WHERE status = 'late') AS late,
            count(*) FILTER (WHERE status = 'absent') AS absent, count(*) FILTER (WHERE status = 'leave') AS on_leave,
            count(*) FILTER (WHERE status IN ('holiday','weekend')) AS off
     FROM attendance_records WHERE organization_id = $1 AND date = $2 AND member_id = ANY($3::uuid[])`,
    [orgId, date, memberIds],
  );
  const recorded = r.present + r.absent + r.on_leave + r.off;
  return { present: r.present, late: r.late, absent: r.absent, onLeave: r.on_leave, off: r.off, notRecorded: Math.max(0, memberIds.length - recorded) };
}

const DELTA_KEYS = [
  'totalWorkingSeconds', 'productiveSeconds', 'idleSeconds', 'breakSeconds', 'avgActivityPercent', 'overtimeSeconds',
  'billableSeconds', 'trackedEmployees', 'completedTasksInPeriod',
];

export async function computeStats(ctx, q) {
  const scope = await dashboardScope(ctx, q, 'today');
  const { from, to, tz, memberIds } = scope;
  const ids = memberIds;
  const live = await db.one(
    `SELECT count(*) FILTER (WHERE m.last_seen_at > now() - interval '2 minutes'
                               OR EXISTS (SELECT 1 FROM time_entries e WHERE e.member_id = m.id AND e.ended_at IS NULL AND e.deleted_at IS NULL)) AS online,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM time_entries e WHERE e.member_id = m.id AND e.ended_at IS NULL AND e.deleted_at IS NULL AND e.status = 'running')) AS tracking
     FROM organization_members m WHERE m.organization_id = $1 AND m.id = ANY($2::uuid[]) AND m.status = 'active'`,
    [ctx.orgId, ids],
  );
  const activeIds = scope.members.filter((m) => m.status === 'active').map((m) => m.id);
  const current = await periodMetrics(ctx.orgId, ids, from, to, tz, q.projectId);
  const prev = previousPeriod(from, to);
  const previous = await periodMetrics(ctx.orgId, ids, prev.from, prev.to, tz, q.projectId);
  const { projects, tasks } = await projectTaskCounts(ctx, q, scope);
  const deltas = {};
  for (const k of DELTA_KEYS) {
    const change = round2(current[k] - previous[k]);
    deltas[k] = { previous: previous[k], change, changePercent: previous[k] ? round2((change / previous[k]) * 100) : null };
  }
  return {
    from,
    to,
    timezone: tz,
    previousPeriod: prev,
    totalEmployees: scope.members.length,
    activeEmployees: activeIds.length,
    onlineEmployees: live.online,
    currentlyTracking: live.tracking,
    ...current,
    totalProjects: projects.total,
    activeProjects: projects.active,
    totalTasks: tasks.total,
    completedTasks: tasks.completed,
    pendingTasks: tasks.pending,
    overdueTasks: tasks.overdue,
    attendanceToday: await attendanceSummary(ctx.orgId, activeIds, scope.today),
    deltas,
  };
}

export { pct };
