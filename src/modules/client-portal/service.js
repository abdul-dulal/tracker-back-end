import { db } from '../../lib/db.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { round2 } from '../currencies/service.js';

/**
 * Client portal helpers (M17). A client user only ever sees projects where
 * projects.client_id = member.client_id AND client_visible AND not deleted; responses are filtered by
 * clients.portal_permissions (CLI-18).
 */

export const DEFAULT_PORTAL_PERMISSIONS = { showScreenshots: false, showActivity: false, showMemberNames: true, showRates: false };

/** Resolve the portal context of the current client user (throws if not linked to an active client). */
export async function portalContext(ctx) {
  if (!ctx.clientId) throw forbidden('Your account is not linked to a client', 'CLIENT_NOT_LINKED');
  const client = await db.one(`SELECT * FROM clients WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`, [ctx.clientId, ctx.orgId]);
  if (!client) throw forbidden('Your client account is not available', 'CLIENT_NOT_LINKED');
  const perms = { ...DEFAULT_PORTAL_PERMISSIONS, ...(client.portal_permissions ?? {}) };
  for (const k of Object.keys(DEFAULT_PORTAL_PERMISSIONS)) perms[k] = perms[k] === true;
  return { orgId: ctx.orgId, clientId: client.id, client, perms, tz: ctx.orgTimezone || 'UTC', ctx };
}

/** SQL predicate for client-visible projects (alias p; $1 = orgId, $2 = clientId). */
export const VISIBLE_PROJECT = `p.organization_id = $1 AND p.client_id = $2 AND p.client_visible AND p.deleted_at IS NULL`;

export async function visibleProjectIds(pc) {
  const rows = await db.many(`SELECT p.id FROM projects p WHERE ${VISIBLE_PROJECT} ORDER BY p.created_at`, [pc.orgId, pc.clientId]);
  return rows.map((r) => r.id);
}

export async function loadVisibleProject(pc, id) {
  const p = await db.one(`SELECT p.* FROM projects p WHERE p.id = $3 AND ${VISIBLE_PROJECT}`, [pc.orgId, pc.clientId, id]);
  if (!p) throw notFound('Project');
  return p;
}

/**
 * Member display labels across all visible projects: real names when showMemberNames,
 * otherwise stable aliases "Team member N" (ordered by membership age).
 */
export async function memberLabels(pc) {
  if (pc.labels) return pc.labels;
  const ids = await visibleProjectIds(pc);
  const rows = ids.length
    ? await db.many(
        `SELECT m.id, trim(u.first_name || ' ' || u.last_name) AS name, m.created_at FROM organization_members m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = $1 AND m.id IN (
           SELECT member_id FROM project_members WHERE project_id = ANY($2::uuid[])
           UNION SELECT member_id FROM time_entries WHERE project_id = ANY($2::uuid[]) AND deleted_at IS NULL)
         ORDER BY m.created_at, m.id`,
        [pc.orgId, ids],
      )
    : [];
  const map = new Map();
  rows.forEach((r, i) => map.set(r.id, pc.perms.showMemberNames ? r.name : `Team member ${i + 1}`));
  pc.labels = { get: (id) => map.get(id) ?? (pc.perms.showMemberNames ? null : 'Team member') };
  return pc.labels;
}

/** Project progress: manual, or done tasks / all tasks. */
export async function projectProgress(project) {
  const t = await db.one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE t.completed_at IS NOT NULL OR bc.category = 'done')::int AS done
     FROM tasks t LEFT JOIN board_columns bc ON bc.id = t.column_id
     WHERE t.project_id = $1 AND t.deleted_at IS NULL`,
    [project.id],
  );
  const auto = t.total ? Math.round((t.done / t.total) * 100) : 0;
  return {
    percent: project.progress_mode === 'manual' && project.progress_manual !== null ? project.progress_manual : auto,
    mode: project.progress_mode,
    tasksTotal: t.total,
    tasksDone: t.done,
  };
}

/** Worked (completed/approved, non-deleted) time aggregated per project, with billable amounts. */
export async function projectTimeStats(pc, projectIds, { from, to } = {}) {
  if (!projectIds.length) return new Map();
  const params = [pc.orgId, projectIds];
  let range = '';
  if (from) {
    params.push(from);
    range += ` AND (e.started_at AT TIME ZONE o.timezone)::date >= $${params.length}::date`;
  }
  if (to) {
    params.push(to);
    range += ` AND (e.started_at AT TIME ZONE o.timezone)::date <= $${params.length}::date`;
  }
  const rows = await db.many(
    `SELECT e.project_id, coalesce(sum(e.duration_seconds), 0)::bigint AS total,
            coalesce(sum(e.duration_seconds) FILTER (WHERE e.is_billable), 0)::bigint AS billable,
            coalesce(sum(e.active_seconds), 0)::bigint AS active,
            coalesce(sum(CASE WHEN e.is_billable THEN e.duration_seconds / 3600.0 * coalesce(pm.billable_rate, p.hourly_rate, c.hourly_rate, s.default_billable_rate, 0) END), 0) AS amount
     FROM time_entries e JOIN projects p ON p.id = e.project_id JOIN organizations o ON o.id = e.organization_id
     LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN organization_settings s ON s.organization_id = e.organization_id
     LEFT JOIN project_members pm ON pm.project_id = e.project_id AND pm.member_id = e.member_id
     WHERE e.organization_id = $1 AND e.project_id = ANY($2::uuid[]) AND e.deleted_at IS NULL AND e.status IN ('completed','approved')${range}
     GROUP BY e.project_id`,
    params,
  );
  return new Map(
    rows.map((r) => [
      r.project_id,
      {
        totalHours: round2(Number(r.total) / 3600),
        billableHours: round2(Number(r.billable) / 3600),
        activityPercent: Number(r.total) > 0 ? Math.min(100, Math.round((Number(r.active) / Number(r.total)) * 100)) : null,
        billableAmount: round2(r.amount),
      },
    ]),
  );
}

export const emptyStats = { totalHours: 0, billableHours: 0, activityPercent: null, billableAmount: 0 };

/** Budget overview (CLI-11): hour budgets always; amount budgets only when rates are visible. */
export function budgetOverview(project, stats, perms) {
  if (project.budget_type === 'none' || project.budget_value === null) return null;
  if (project.budget_type === 'amount' && !perms.showRates) return null;
  const value = Number(project.budget_value);
  const used = project.budget_type === 'hours' ? stats.totalHours : stats.billableAmount;
  return { type: project.budget_type, value, used: round2(used), remaining: round2(value - used), percentUsed: value > 0 ? round2((used / value) * 100) : null };
}

/** Project DTO filtered by portal permissions. */
export function projectDto(p, stats, perms) {
  const s = stats ?? emptyStats;
  return {
    id: p.id,
    name: p.name,
    code: p.code,
    description: p.description,
    status: p.status,
    startDate: p.start_date,
    deadline: p.deadline,
    color: p.color,
    archived: !!p.archived_at,
    totalHours: s.totalHours,
    billableHours: s.billableHours,
    ...(perms.showActivity ? { activityPercent: s.activityPercent } : {}),
    ...(perms.showRates ? { currency: p.currency, hourlyRate: p.hourly_rate === null ? null : Number(p.hourly_rate), billableAmount: s.billableAmount } : {}),
  };
}
