import { db } from '../lib/db.js';
import { forbidden, notFound } from '../lib/errors.js';

/**
 * Data scoping (guide §M02): converts a permission grant scope into concrete id sets.
 * `null` means "whole organization" (no filter needed).
 */

async function cached(ctx, key, fn) {
  if (!ctx.cache) ctx.cache = new Map();
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const v = await fn();
  ctx.cache.set(key, v);
  return v;
}

/** Members that `ctx` manages: via team leadership/management and direct manager links (+ self). */
export function managedMemberIds(ctx) {
  return cached(ctx, 'managedMembers', async () => {
    const rows = await db.many(
      `SELECT DISTINCT tm.member_id AS id FROM team_members tm
         WHERE tm.team_id IN (
           SELECT team_id FROM team_members WHERE member_id = $1 AND is_leader
           UNION SELECT team_id FROM team_managers WHERE member_id = $1)
       UNION SELECT member_id FROM member_managers WHERE manager_member_id = $1
       UNION SELECT $1::uuid`,
      [ctx.memberId],
    );
    return rows.map((r) => r.id);
  });
}

/** Projects the member belongs to (directly or through a team). */
export function memberProjectIds(ctx, memberId = ctx.memberId) {
  return cached(ctx, `projects:${memberId}`, async () => {
    const rows = await db.many(
      `SELECT project_id AS id FROM project_members WHERE member_id = $1
       UNION SELECT pt.project_id FROM project_teams pt JOIN team_members tm ON tm.team_id = pt.team_id WHERE tm.member_id = $1`,
      [memberId],
    );
    return rows.map((r) => r.id);
  });
}

/** Projects where ctx is a project manager. */
export function managedProjectIds(ctx) {
  return cached(ctx, 'managedProjects', async () => {
    const rows = await db.many(`SELECT project_id AS id FROM project_members WHERE member_id = $1 AND role = 'manager'`, [
      ctx.memberId,
    ]);
    return rows.map((r) => r.id);
  });
}

/** Members of projects ctx manages (+ self). */
export function projectMemberIds(ctx) {
  return cached(ctx, 'projectMembers', async () => {
    const pids = await managedProjectIds(ctx);
    if (!pids.length) return [ctx.memberId];
    const rows = await db.many(
      `SELECT member_id AS id FROM project_members WHERE project_id = ANY($1::uuid[])
       UNION SELECT tm.member_id FROM project_teams pt JOIN team_members tm ON tm.team_id = pt.team_id WHERE pt.project_id = ANY($1::uuid[])
       UNION SELECT $2::uuid`,
      [pids, ctx.memberId],
    );
    return rows.map((r) => r.id);
  });
}

/**
 * Member ids accessible for a member-data permission (time, screenshots, activity, attendance…).
 * @returns {Promise<string[]|null>} null = all members of the org.
 */
export async function accessibleMemberIds(ctx, perm) {
  const scope = ctx.require(perm);
  if (scope === 'org') return null;
  if (scope === 'own') return [ctx.memberId];
  if (scope === 'team') return managedMemberIds(ctx);
  if (scope === 'project') return projectMemberIds(ctx);
  return [ctx.memberId];
}

/** Throw 403 unless memberId is within the scope of perm. */
export async function assertMemberAccess(ctx, perm, memberId) {
  const ids = await accessibleMemberIds(ctx, perm);
  if (ids && !ids.includes(memberId)) throw forbidden('You do not have access to this member');
}

/** Can ctx access memberId for perm (boolean)? */
export async function canAccessMember(ctx, perm, memberId) {
  if (!ctx.can(perm)) return false;
  const ids = await accessibleMemberIds(ctx, perm);
  return !ids || ids.includes(memberId);
}

/**
 * Project ids accessible for a project-data permission.
 * own/project → projects the member belongs to; team → + projects of managed teams; org → null.
 */
/** Project-management permissions: with `project` scope these require being a project manager, not just a member. */
const PROJECT_MANAGEMENT_PERMS = new Set([
  'projects.update',
  'projects.archive',
  'projects.delete',
  'board.manage_columns',
  'tasks.delete',
  'tasks.assign',
  'tasks.approve',
]);

export async function accessibleProjectIds(ctx, perm) {
  const scope = ctx.require(perm);
  if (scope === 'org') return null;
  if (scope === 'project' && PROJECT_MANAGEMENT_PERMS.has(perm)) return managedProjectIds(ctx);
  const own = await memberProjectIds(ctx);
  if (scope !== 'team') return own;
  return cached(ctx, `teamProjects`, async () => {
    const rows = await db.many(
      `SELECT pt.project_id AS id FROM project_teams pt
       WHERE pt.team_id IN (SELECT team_id FROM team_managers WHERE member_id = $1
                            UNION SELECT team_id FROM team_members WHERE member_id = $1 AND is_leader)`,
      [ctx.memberId],
    );
    return [...new Set([...own, ...rows.map((r) => r.id)])];
  });
}

export async function assertProjectAccess(ctx, perm, projectId) {
  const ids = await accessibleProjectIds(ctx, perm);
  if (ids && !ids.includes(projectId)) throw forbidden('You do not have access to this project');
}

/** Ensure a member id belongs to the organization; returns the member row. */
export async function getOrgMember(orgId, memberId) {
  const m = await db.one(
    `SELECT m.*, u.email, u.first_name, u.last_name, u.timezone AS user_timezone
     FROM organization_members m JOIN users u ON u.id = m.user_id
     WHERE m.id = $1 AND m.organization_id = $2 AND m.deleted_at IS NULL`,
    [memberId, orgId],
  );
  if (!m) throw notFound('Member');
  return m;
}

/** Apply member scope to a where() builder for a column. */
export async function scopeMembers(ctx, perm, w, column) {
  const ids = await accessibleMemberIds(ctx, perm);
  if (ids) w.add(`${column} = ANY(?::uuid[])`, ids);
  return ids;
}

/** Apply project scope to a where() builder for a column. */
export async function scopeProjects(ctx, perm, w, column) {
  const ids = await accessibleProjectIds(ctx, perm);
  if (ids) w.add(`${column} = ANY(?::uuid[])`, ids);
  return ids;
}
