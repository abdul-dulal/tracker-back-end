import { db } from '../../lib/db.js';
import { accessibleMemberIds, accessibleProjectIds } from '../../rbac/scope.js';

/**
 * Pending-approval aggregator (ADM-13…16). Each source is filtered to what the caller can approve
 * (scope of the matching *.approve permission); own items are excluded (no self-approval).
 */
export const APPROVAL_TYPES = {
  manual_time: 'time.approve',
  timesheet: 'timesheets.approve',
  attendance: 'attendance.approve',
  idle: 'idle.approve',
  task: 'tasks.approve',
};

const NAME = `trim(u.first_name || ' ' || u.last_name)`;

const SOURCES = {
  manual_time: (scopeSql) => `
    SELECT 'manual_time' AS type, e.id, e.member_id, ${NAME} AS member_name, e.created_at,
           concat('Manual time ', to_char(e.started_at, 'YYYY-MM-DD HH24:MI'), ' – ', to_char(e.ended_at, 'HH24:MI'),
                  ' (', round(e.duration_seconds / 3600.0, 2), ' h)', coalesce(': ' || e.approval_reason, '')) AS summary,
           '/time/approvals?entryId=' || e.id AS link
    FROM time_entries e JOIN organization_members m ON m.id = e.member_id JOIN users u ON u.id = m.user_id
    WHERE e.organization_id = $1 AND e.status = 'pending' AND e.deleted_at IS NULL AND e.member_id <> $2 ${scopeSql('e.member_id')}`,
  timesheet: (scopeSql) => `
    SELECT 'timesheet' AS type, ts.id, ts.member_id, ${NAME} AS member_name, coalesce(ts.submitted_at, ts.updated_at) AS created_at,
           concat('Timesheet ', ts.period_start, ' – ', ts.period_end, ' (', round(ts.total_seconds / 3600.0, 2), ' h)') AS summary,
           '/timesheets/' || ts.id AS link
    FROM timesheets ts JOIN organization_members m ON m.id = ts.member_id JOIN users u ON u.id = m.user_id
    WHERE ts.organization_id = $1 AND ts.status = 'submitted' AND ts.member_id <> $2 ${scopeSql('ts.member_id')}`,
  attendance: (scopeSql) => `
    SELECT 'attendance' AS type, c.id, c.member_id, ${NAME} AS member_name, c.created_at,
           concat('Attendance correction for ', c.date, ': ', c.reason) AS summary, '/attendance/corrections/' || c.id AS link
    FROM attendance_corrections c JOIN organization_members m ON m.id = c.member_id JOIN users u ON u.id = m.user_id
    WHERE c.organization_id = $1 AND c.status = 'pending' AND c.member_id <> $2 ${scopeSql('c.member_id')}`,
  idle: (scopeSql) => `
    SELECT 'idle' AS type, r.id, r.member_id, ${NAME} AS member_name, r.created_at,
           concat('Idle time ', r.requested_action, ' request (', round(ip.duration_seconds / 60.0), ' min): ', r.reason) AS summary,
           '/time/idle-requests/' || r.id AS link
    FROM idle_adjustment_requests r JOIN idle_periods ip ON ip.id = r.idle_period_id
    JOIN organization_members m ON m.id = r.member_id JOIN users u ON u.id = m.user_id
    WHERE r.organization_id = $1 AND r.status = 'pending' AND r.member_id <> $2 ${scopeSql('r.member_id')}`,
  task: (scopeSql) => `
    SELECT 'task' AS type, t.id, m.id AS member_id, ${NAME} AS member_name, t.updated_at AS created_at,
           concat('Task review: ', t.title) AS summary, '/projects/' || t.project_id || '/tasks/' || t.id AS link
    FROM tasks t LEFT JOIN organization_members m ON m.id = t.created_by LEFT JOIN users u ON u.id = m.user_id
    WHERE t.organization_id = $1 AND t.approval_status = 'pending' AND t.deleted_at IS NULL
      AND t.created_by IS DISTINCT FROM $2::uuid ${scopeSql('t.project_id')}`,
};

/**
 * Build the scoped union for the requested types.
 * @returns {Promise<{sql:string, params:any[]}|null>} null when the caller can approve nothing.
 */
async function buildUnion(ctx, types) {
  const params = [ctx.orgId, ctx.memberId];
  const parts = [];
  for (const type of types) {
    const perm = APPROVAL_TYPES[type];
    if (!ctx.can(perm)) continue;
    let ids;
    if (type === 'task') {
      ids = await accessibleProjectIds(ctx, perm);
      if (ids) {
        params.push(ids);
        const p = `$${params.length}`;
        parts.push(SOURCES.task((col) => `AND (${col} = ANY(${p}::uuid[]) OR t.reviewer_member_id = $2)`));
        continue;
      }
    } else {
      ids = await accessibleMemberIds(ctx, perm);
      if (ids) {
        params.push(ids);
        const p = `$${params.length}`;
        parts.push(SOURCES[type]((col) => `AND ${col} = ANY(${p}::uuid[])`));
        continue;
      }
    }
    parts.push(SOURCES[type](() => ''));
  }
  if (!parts.length) return null;
  return { sql: parts.map((p) => `(${p})`).join(' UNION ALL '), params };
}

export function canApproveAnything(ctx) {
  return Object.values(APPROVAL_TYPES).some((p) => ctx.can(p));
}

export async function pendingApprovals(ctx, { type, limit = 50, offset = 0 } = {}) {
  const u = await buildUnion(ctx, type ? [type] : Object.keys(APPROVAL_TYPES));
  if (!u) return { items: [], total: 0 };
  const total = (await db.one(`SELECT count(*)::int AS n FROM (${u.sql}) x`, u.params)).n;
  const rows = await db.many(`SELECT * FROM (${u.sql}) x ORDER BY created_at ASC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, u.params);
  return {
    total,
    items: rows.map((r) => ({
      type: r.type,
      id: r.id,
      member: r.member_id ? { id: r.member_id, name: r.member_name } : null,
      summary: r.summary,
      createdAt: r.created_at,
      link: r.link,
    })),
  };
}

export async function approvalCounts(ctx) {
  const counts = { manual_time: 0, timesheet: 0, attendance: 0, idle: 0, task: 0 };
  const u = await buildUnion(ctx, Object.keys(APPROVAL_TYPES));
  if (u) {
    const rows = await db.many(`SELECT type, count(*)::int AS n FROM (${u.sql}) x GROUP BY type`, u.params);
    for (const r of rows) counts[r.type] = r.n;
  }
  return { ...counts, total: Object.values(counts).reduce((s, n) => s + n, 0) };
}
