import { db } from '../../lib/db.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { dateStr } from '../../lib/http.js';
import { accessibleMemberIds } from '../../rbac/scope.js';

/** YYYY-MM-DD that is also a real calendar date (lib/http dateStr only checks the format). */
export const realDate = dateStr.refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, 'Invalid calendar date');

/** Teams the caller manages (team_managers or leader in team_members). */
export async function managedTeamIds(ctx) {
  if (!ctx.cache) ctx.cache = new Map();
  if (ctx.cache.has('managedTeams')) return ctx.cache.get('managedTeams');
  const rows = await db.many(
    `SELECT team_id AS id FROM team_managers WHERE member_id = $1
     UNION SELECT team_id FROM team_members WHERE member_id = $1 AND is_leader`,
    [ctx.memberId],
  );
  const ids = rows.map((r) => r.id);
  ctx.cache.set('managedTeams', ids);
  return ids;
}

/** Load a team of the org or 404. */
export async function getTeam(orgId, teamId) {
  const t = await db.one('SELECT * FROM teams WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [teamId, orgId]);
  if (!t) throw notFound('Team');
  return t;
}

/**
 * teams.manage scope check: org scope → any team; team scope → only teams the caller manages.
 * @param {'any'|'org'} [min]
 */
export async function assertTeamManage(ctx, teamId, min = 'any') {
  const scope = ctx.require('teams.manage');
  const team = await getTeam(ctx.orgId, teamId);
  if (scope === 'org') return team;
  if (min === 'org') throw forbidden('This action requires organization-wide team management');
  const ids = await managedTeamIds(ctx);
  if (!ids.includes(teamId)) throw forbidden('You can only manage teams you manage');
  return team;
}

/** Ensure all ids are members of the org (not deleted). Returns the unique id list. */
export async function assertOrgMembers(orgId, ids, field = 'memberIds') {
  const unique = [...new Set(ids ?? [])];
  if (!unique.length) return unique;
  const rows = await db.many(
    `SELECT id FROM organization_members WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [orgId, unique],
  );
  if (rows.length !== unique.length) {
    const found = new Set(rows.map((r) => r.id));
    throw badRequest('Some members were not found in this organization', [{ path: `body.${field}`, message: `Unknown: ${unique.filter((x) => !found.has(x)).join(', ')}` }], 'INVALID_REFERENCE');
  }
  return unique;
}

/** Ensure all ids exist in a tenant table (teams, departments, projects, work_schedules…). */
export async function assertOrgRows(table, orgId, ids, field, { softDelete = true } = {}) {
  const unique = [...new Set((ids ?? []).filter(Boolean))];
  if (!unique.length) return unique;
  const rows = await db.many(
    `SELECT id FROM ${table} WHERE organization_id = $1 AND id = ANY($2::uuid[]) ${softDelete ? 'AND deleted_at IS NULL' : ''}`,
    [orgId, unique],
  );
  if (rows.length !== unique.length)
    throw badRequest(`Some referenced ${table.replace(/_/g, ' ')} were not found`, [{ path: `body.${field}`, message: 'Not found in this organization' }], 'INVALID_REFERENCE');
  return unique;
}

/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayIn(tz = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Resolve a from/to range (default: last 30 days ending today in tz). */
export function resolveRange(q, tz, days = 30) {
  const to = q.to ?? todayIn(tz);
  let from = q.from;
  if (!from) {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (days - 1));
    from = d.toISOString().slice(0, 10);
  }
  if (from > to) throw badRequest('`from` must be on or before `to`', [{ path: 'query.from', message: 'from > to' }], 'VALIDATION_ERROR');
  const span = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000;
  if (span > 366) throw badRequest('Date range cannot exceed 366 days', [{ path: 'query.to', message: 'Range too large' }], 'VALIDATION_ERROR');
  return { from, to };
}

/**
 * Aggregate daily_summaries per member for a date range. Returns rows with numeric fields.
 * `memberIds` must already be scope-filtered.
 */
export async function summariesByMember(orgId, memberIds, from, to) {
  if (!memberIds.length) return [];
  const rows = await db.many(
    `SELECT ds.member_id,
            coalesce(sum(tracked_seconds),0)::int AS tracked_seconds, coalesce(sum(active_seconds),0)::int AS active_seconds,
            coalesce(sum(idle_seconds),0)::int AS idle_seconds, coalesce(sum(break_seconds),0)::int AS break_seconds,
            coalesce(sum(productive_seconds),0)::int AS productive_seconds, coalesce(sum(unproductive_seconds),0)::int AS unproductive_seconds,
            coalesce(sum(neutral_seconds),0)::int AS neutral_seconds, coalesce(sum(billable_seconds),0)::int AS billable_seconds,
            coalesce(sum(overtime_seconds),0)::int AS overtime_seconds, coalesce(sum(screenshot_count),0)::int AS screenshot_count,
            count(*) FILTER (WHERE tracked_seconds > 0)::int AS days_worked
     FROM daily_summaries ds
     WHERE ds.organization_id = $1 AND ds.member_id = ANY($2::uuid[]) AND ds.date BETWEEN $3::date AND $4::date
     GROUP BY ds.member_id`,
    [orgId, memberIds, from, to],
  );
  return rows;
}

/** Derived metrics from summed seconds. */
export function metrics(s) {
  const tracked = s.tracked_seconds ?? 0;
  const categorized = (s.productive_seconds ?? 0) + (s.unproductive_seconds ?? 0) + (s.neutral_seconds ?? 0);
  return {
    trackedSeconds: tracked,
    activeSeconds: s.active_seconds ?? 0,
    idleSeconds: s.idle_seconds ?? 0,
    breakSeconds: s.break_seconds ?? 0,
    productiveSeconds: s.productive_seconds ?? 0,
    unproductiveSeconds: s.unproductive_seconds ?? 0,
    neutralSeconds: s.neutral_seconds ?? 0,
    billableSeconds: s.billable_seconds ?? 0,
    overtimeSeconds: s.overtime_seconds ?? 0,
    screenshotCount: s.screenshot_count ?? 0,
    daysWorked: s.days_worked ?? 0,
    activityPercent: tracked > 0 ? Math.min(100, Math.round(((s.active_seconds ?? 0) / tracked) * 100)) : 0,
    productivityPercent: categorized > 0 ? Math.round(((s.productive_seconds ?? 0) / categorized) * 100) : 0,
  };
}

/** Sum a list of raw summary rows. */
export function sumRows(rows) {
  const keys = ['tracked_seconds', 'active_seconds', 'idle_seconds', 'break_seconds', 'productive_seconds', 'unproductive_seconds', 'neutral_seconds', 'billable_seconds', 'overtime_seconds', 'screenshot_count', 'days_worked'];
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of rows) for (const k of keys) out[k] += Number(r[k] ?? 0);
  return out;
}

/** Member ids of a team restricted to what ctx may see for perm (null perm → no member data). */
export async function visibleTeamMemberIds(ctx, teamId, perm) {
  const rows = await db.many(
    `SELECT tm.member_id FROM team_members tm JOIN organization_members m ON m.id = tm.member_id
     WHERE tm.team_id = $1 AND m.deleted_at IS NULL`,
    [teamId],
  );
  const all = rows.map((r) => r.member_id);
  if (!ctx.can(perm)) return [];
  const allowed = await accessibleMemberIds(ctx, perm);
  return allowed ? all.filter((id) => allowed.includes(id)) : all;
}
