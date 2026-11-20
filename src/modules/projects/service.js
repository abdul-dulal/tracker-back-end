import { db } from '../../lib/db.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { assertProjectAccess } from '../../rbac/scope.js';
import { signedGetUrl } from '../../lib/storage.js';

/** Shared project helpers (M09) reused by tasks, board, comments, attachments and jobs. */

export const DEFAULT_COLUMNS = [
  { name: 'To Do', category: 'todo' },
  { name: 'In Progress', category: 'in_progress' },
  { name: 'In Review', category: 'in_review' },
  { name: 'Completed', category: 'done' },
];

export const num = (v) => (v === null || v === undefined ? null : Number(v));
export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const hours = (secs) => r2((Number(secs) || 0) / 3600);

/** KAN-01…04: seed default board columns for a new project. */
export async function seedColumns(orgId, projectId) {
  let pos = 1;
  for (const c of DEFAULT_COLUMNS) {
    await db.query(
      `INSERT INTO board_columns (organization_id, project_id, name, category, position) VALUES ($1,$2,$3,$4,$5)`,
      [orgId, projectId, c.name, c.category, pos++],
    );
  }
}

/** Load a non-deleted project of the org or 404. */
export async function loadProject(orgId, id) {
  const p = await db.one(
    `SELECT p.*, cl.name AS client_name FROM projects p LEFT JOIN clients cl ON cl.id = p.client_id
     WHERE p.id = $1 AND p.organization_id = $2 AND p.deleted_at IS NULL`,
    [id, orgId],
  );
  if (!p) throw notFound('Project');
  return p;
}

/** Load project (404 across orgs) then enforce the permission scope (403). */
export async function getProjectFor(ctx, id, perm = 'projects.view') {
  const p = await loadProject(ctx.orgId, id);
  await assertProjectAccess(ctx, perm, id);
  return p;
}

export function progressOf(p, total, done) {
  if (p.progress_mode === 'manual') return p.progress_manual ?? 0;
  const t = Number(total) || 0;
  return t ? Math.round((Number(done) / t) * 100) : 0;
}

/** PROJ-16: auto progress = done top-level tasks / total top-level tasks (or manual override). */
export async function projectProgress(p) {
  const c = await db.one(
    `SELECT count(*) AS total, count(*) FILTER (WHERE completed_at IS NOT NULL) AS done
     FROM tasks WHERE project_id = $1 AND parent_task_id IS NULL AND deleted_at IS NULL`,
    [p.id],
  );
  return { progress: progressOf(p, c.total, c.done), tasksTotal: c.total, tasksDone: c.done };
}

export function projectDto(p, extra = {}) {
  return {
    id: p.id,
    name: p.name,
    code: p.code,
    description: p.description,
    clientId: p.client_id,
    clientName: p.client_name ?? null,
    status: p.status,
    priority: p.priority,
    startDate: p.start_date,
    deadline: p.deadline,
    budgetType: p.budget_type,
    budgetValue: num(p.budget_value),
    currency: p.currency,
    hourlyRate: num(p.hourly_rate),
    isBillableDefault: p.is_billable_default,
    progressMode: p.progress_mode,
    progressManual: p.progress_manual,
    clientVisible: p.client_visible,
    color: p.color,
    archived: !!p.archived_at,
    archivedAt: p.archived_at,
    createdBy: p.created_by,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    ...extra,
  };
}

export async function orgTimezone(orgId) {
  const o = await db.one('SELECT timezone FROM organizations WHERE id = $1', [orgId]);
  return o?.timezone ?? 'UTC';
}

/**
 * Aggregate time on a project (PROJ-17/18): hours, billable hours, cost and revenue.
 * cost   = hours × member cost (fallback pay) hourly rate effective at the entry's date.
 * revenue = billable hours × project_member.billable_rate → project.hourly_rate → client.hourly_rate
 *           → organization_settings.default_billable_rate.
 */
export async function projectTotals(orgId, projectId, { from, to, tz = 'UTC' } = {}) {
  const params = [projectId, tz, orgId];
  let range = '';
  if (from) {
    params.push(from);
    range += ` AND (e.started_at AT TIME ZONE $2::text)::date >= $${params.length}::date`;
  }
  if (to) {
    params.push(to);
    range += ` AND (e.started_at AT TIME ZONE $2::text)::date <= $${params.length}::date`;
  }
  const rows = await db.many(
    `SELECT e.member_id, e.task_id, e.duration_seconds AS secs, e.active_seconds, e.is_billable,
       (SELECT r.amount FROM member_rates r
         WHERE r.member_id = e.member_id AND r.rate_type IN ('cost','pay') AND r.pay_type = 'hourly'
           AND r.effective_from <= (e.started_at AT TIME ZONE $2::text)::date
           AND (r.effective_to IS NULL OR r.effective_to > (e.started_at AT TIME ZONE $2::text)::date)
         ORDER BY CASE r.rate_type WHEN 'cost' THEN 0 ELSE 1 END LIMIT 1) AS cost_rate,
       coalesce(pm.billable_rate, p.hourly_rate, cl.hourly_rate, s.default_billable_rate) AS bill_rate
     FROM time_entries e
     JOIN projects p ON p.id = e.project_id
     LEFT JOIN clients cl ON cl.id = p.client_id
     LEFT JOIN organization_settings s ON s.organization_id = p.organization_id
     LEFT JOIN project_members pm ON pm.project_id = e.project_id AND pm.member_id = e.member_id
     WHERE e.project_id = $1 AND e.organization_id = $3 AND e.deleted_at IS NULL AND e.status <> 'rejected'${range}`,
    params,
  );
  const tot = { seconds: 0, billableSeconds: 0, activeSeconds: 0, cost: 0, revenue: 0 };
  const perMember = new Map();
  const perTask = new Map();
  for (const e of rows) {
    const secs = Number(e.secs) || 0;
    const h = secs / 3600;
    const cost = e.cost_rate !== null ? h * Number(e.cost_rate) : 0;
    const revenue = e.is_billable && e.bill_rate !== null ? h * Number(e.bill_rate) : 0;
    tot.seconds += secs;
    tot.activeSeconds += Number(e.active_seconds) || 0;
    if (e.is_billable) tot.billableSeconds += secs;
    tot.cost += cost;
    tot.revenue += revenue;
    const m = perMember.get(e.member_id) ?? { seconds: 0, billableSeconds: 0, activeSeconds: 0, cost: 0, revenue: 0 };
    m.seconds += secs;
    m.activeSeconds += Number(e.active_seconds) || 0;
    if (e.is_billable) m.billableSeconds += secs;
    m.cost += cost;
    m.revenue += revenue;
    perMember.set(e.member_id, m);
    if (e.task_id) {
      const t = perTask.get(e.task_id) ?? { seconds: 0, billableSeconds: 0 };
      t.seconds += secs;
      if (e.is_billable) t.billableSeconds += secs;
      perTask.set(e.task_id, t);
    }
  }
  return { ...tot, cost: r2(tot.cost), revenue: r2(tot.revenue), perMember, perTask };
}

/** PROJ-10: budget usage for hours|amount budgets (amount budget consumes billable revenue). */
export function budgetUsage(p, totals) {
  if (p.budget_type === 'none' || p.budget_value === null || p.budget_value === undefined) {
    return { type: p.budget_type, value: num(p.budget_value), used: null, remaining: null, percent: null };
  }
  const value = Number(p.budget_value);
  const used = p.budget_type === 'hours' ? hours(totals.seconds) : r2(totals.revenue);
  return {
    type: p.budget_type,
    value,
    used,
    remaining: r2(value - used),
    percent: value > 0 ? Math.round((used / value) * 1000) / 10 : null,
  };
}

export async function projectMembers(projectId) {
  const rows = await db.many(
    `SELECT pm.member_id, pm.role, pm.billable_rate, u.first_name, u.last_name, u.email, u.avatar_key
     FROM project_members pm JOIN organization_members m ON m.id = pm.member_id JOIN users u ON u.id = m.user_id
     WHERE pm.project_id = $1 AND m.deleted_at IS NULL ORDER BY pm.role, u.first_name`,
    [projectId],
  );
  return rows.map((r) => ({
    memberId: r.member_id,
    role: r.role,
    billableRate: num(r.billable_rate),
    name: `${r.first_name} ${r.last_name}`.trim(),
    email: r.email,
    avatarUrl: signedGetUrl(r.avatar_key),
  }));
}

/** Member ids of project managers (project_members.role = 'manager'). */
export async function projectManagerIds(projectId) {
  const rows = await db.many(`SELECT member_id FROM project_members WHERE project_id = $1 AND role = 'manager'`, [projectId]);
  return rows.map((r) => r.member_id);
}

/** All member ids with direct or team membership in a project. */
export async function projectAllMemberIds(projectId) {
  const rows = await db.many(
    `SELECT member_id FROM project_members WHERE project_id = $1
     UNION SELECT tm.member_id FROM project_teams pt JOIN team_members tm ON tm.team_id = pt.team_id WHERE pt.project_id = $1`,
    [projectId],
  );
  return rows.map((r) => r.member_id);
}

/** Validate that all member ids belong to the org (non-deleted). */
export async function assertOrgMembers(orgId, memberIds) {
  const ids = [...new Set(memberIds)];
  if (!ids.length) return;
  const rows = await db.many(
    `SELECT id FROM organization_members WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [orgId, ids],
  );
  if (rows.length !== ids.length) throw badRequest('One or more members were not found', undefined, 'INVALID_REFERENCE');
}

/** Member ids of owners/admins in the org (budget alerts). */
export async function adminMemberIds(orgId) {
  const rows = await db.many(
    `SELECT m.id FROM organization_members m JOIN roles r ON r.id = m.role_id
     WHERE m.organization_id = $1 AND r.base_role IN ('owner','admin') AND m.status = 'active' AND m.deleted_at IS NULL`,
    [orgId],
  );
  return rows.map((r) => r.id);
}

/** Does a member (not ctx) have access to a project? (org-scope tasks.view, membership or team). */
export async function memberHasProjectAccess(orgId, memberId, projectId) {
  const row = await db.one(
    `SELECT 1 FROM organization_members m
     WHERE m.id = $1 AND m.organization_id = $3 AND m.deleted_at IS NULL
       AND (EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions pe ON pe.id = rp.permission_id
                    WHERE rp.role_id = m.role_id AND pe.key = 'tasks.view' AND rp.scope = 'org')
            OR EXISTS (SELECT 1 FROM project_members WHERE project_id = $2 AND member_id = m.id)
            OR EXISTS (SELECT 1 FROM project_teams pt JOIN team_members tm ON tm.team_id = pt.team_id
                       WHERE pt.project_id = $2 AND tm.member_id = m.id))`,
    [memberId, projectId, orgId],
  );
  return !!row;
}

export function activityDto(a) {
  return {
    id: a.id,
    entityType: a.entity_type,
    entityId: a.entity_id,
    action: a.action,
    changes: a.changes,
    actor: a.actor_member_id ? { memberId: a.actor_member_id, name: `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim(), avatarUrl: signedGetUrl(a.avatar_key) } : null,
    createdAt: a.created_at,
  };
}
