import { db } from '../../lib/db.js';
import { accessibleMemberIds } from '../../rbac/scope.js';
import { forbidden } from '../../lib/errors.js';

/** Shown next to every activity figure (guide §M07): activity is not a performance verdict. */
export const ACTIVITY_NOTE = 'Activity level is one indicator and not the sole measure of performance.';

/** Org activity level thresholds (Low 0–lowMax, Moderate lowMax+1–moderateMax, High above). */
export async function getThresholds(orgId) {
  const s = await db.one('SELECT activity_low_max, activity_moderate_max FROM organization_settings WHERE organization_id = $1', [orgId]);
  return { lowMax: s?.activity_low_max ?? 30, moderateMax: s?.activity_moderate_max ?? 60 };
}

/** @returns {'low'|'moderate'|'high'|null} */
export function activityLevel(percent, th) {
  if (percent === null || percent === undefined) return null;
  if (percent <= th.lowMax) return 'low';
  if (percent <= th.moderateMax) return 'moderate';
  return 'high';
}

export const pct = (active, total) => (total > 0 ? Math.min(100, Math.round((active / total) * 100)) : 0);

/**
 * Member ids the viewer may see for a member-data permission. Every member can always see their
 * own data (SS-P3), even when a custom role lacks the permission entirely.
 * @returns {Promise<string[]|null>} null = whole organization
 */
export async function visibleMemberIds(ctx, perm) {
  if (!ctx.can(perm)) return ctx.memberId ? [ctx.memberId] : [];
  return accessibleMemberIds(ctx, perm);
}

export async function assertCanSeeMember(ctx, perm, memberId) {
  const ids = await visibleMemberIds(ctx, perm);
  if (ids && !ids.includes(memberId)) throw forbidden('You do not have access to this member');
}

/**
 * Resolve a member/team/project filter into the list of member ids to aggregate (intersected with the
 * viewer's scope). Returns null for "all members of the org".
 */
export async function resolveMemberFilter(ctx, perm, { memberId, teamId, projectId }) {
  const visible = await visibleMemberIds(ctx, perm);
  let ids = null;
  if (memberId) {
    const m = await db.one('SELECT id FROM organization_members WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [memberId, ctx.orgId]);
    ids = m ? [m.id] : [];
  } else if (teamId) {
    ids = (
      await db.many(
        `SELECT tm.member_id AS id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.id = $1 AND t.organization_id = $2`,
        [teamId, ctx.orgId],
      )
    ).map((r) => r.id);
  } else if (projectId) {
    ids = (
      await db.many(
        `SELECT pm.member_id AS id FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE p.id = $1 AND p.organization_id = $2
         UNION SELECT tm.member_id FROM project_teams pt JOIN team_members tm ON tm.team_id = pt.team_id JOIN projects p ON p.id = pt.project_id
           WHERE p.id = $1 AND p.organization_id = $2`,
        [projectId, ctx.orgId],
      )
    ).map((r) => r.id);
  }
  if (memberId && visible && !visible.includes(memberId)) throw forbidden('You do not have access to this member');
  if (ids === null) return visible;
  return visible ? ids.filter((x) => visible.includes(x)) : ids;
}
