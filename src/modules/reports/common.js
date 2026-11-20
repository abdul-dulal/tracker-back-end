import { z } from 'zod';
import { db } from '../../lib/db.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { accessibleMemberIds } from '../../rbac/scope.js';
import { loadMemberContext, withHelpers } from '../../rbac/context.js';
import { dateStr } from '../../lib/http.js';
import { zCsvUuids } from '../../lib/router.js';

/**
 * Helpers shared by dashboard, reports and performance: date ranges (org time zone), member scope
 * resolution and synthetic contexts for background runs (scheduled reports, public shares).
 */

export const RANGES = [
  'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month',
  'last_7_days', 'last_30_days', 'last_90_days', 'this_year',
];
export const MAX_RANGE_DAYS = 366;

// ── pure date helpers on 'YYYY-MM-DD' strings ──
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86_400_000);
/** ISO week start (Monday). */
export const startOfWeek = (s) => {
  const d = toDate(s);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(s, -dow);
};
export const startOfMonth = (s) => `${s.slice(0, 7)}-01`;
export const endOfMonth = (s) => {
  const d = toDate(startOfMonth(s));
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return fmt(d);
};
export const eachDay = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

export async function orgTimezone(orgId) {
  const r = await db.one('SELECT timezone FROM organizations WHERE id = $1', [orgId]);
  return r?.timezone ?? 'UTC';
}

export async function todayIn(tz) {
  return (await db.one(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [tz])).d;
}

/** Turn a named range into from/to dates relative to `today`. */
export function rangeDates(range, today) {
  switch (range) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'this_week':
      return { from: startOfWeek(today), to: today };
    case 'last_week': {
      const s = addDays(startOfWeek(today), -7);
      return { from: s, to: addDays(s, 6) };
    }
    case 'this_month':
      return { from: startOfMonth(today), to: today };
    case 'last_month': {
      const s = startOfMonth(addDays(startOfMonth(today), -1));
      return { from: s, to: endOfMonth(s) };
    }
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'last_90_days':
      return { from: addDays(today, -89), to: today };
    case 'this_year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'last_7_days':
    default:
      return { from: addDays(today, -6), to: today };
  }
}

/**
 * Resolve {from, to, range} (inclusive dates) in time zone tz.
 * @returns {Promise<{from:string,to:string,today:string}>}
 */
export async function resolveRange(def = {}, tz = 'UTC', fallback = 'last_7_days') {
  const today = await todayIn(tz);
  let { from, to } = def;
  if (!from && !to) ({ from, to } = rangeDates(def.range ?? fallback, today));
  else if (!from) from = addDays(to, -6);
  else if (!to) to = from > today ? from : today;
  if (from > to) throw badRequest('`from` must be on or before `to`');
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw badRequest(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
  return { from, to, today };
}

/** Same-length period immediately before [from, to]. */
export function previousPeriod(from, to) {
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

/** UTC window for an inclusive local date range. */
export async function windowFor(from, to, tz) {
  return db.one(
    `SELECT ($1::date::timestamp AT TIME ZONE $3) AS ws, (($2::date + 1)::timestamp AT TIME ZONE $3) AS we`,
    [from, to, tz],
  );
}

/**
 * Members accessible for `perm`, narrowed by memberIds / teamIds filters.
 * Explicitly requested out-of-scope members → 403.
 * @returns {Promise<string[]|null>} null = whole organization.
 */
export async function resolveMemberScope(ctx, filters = {}, perm = 'reports.view') {
  let ids = await accessibleMemberIds(ctx, perm);
  const memberIds = filters.memberIds?.filter(Boolean);
  if (memberIds?.length) {
    if (ids) {
      const denied = memberIds.filter((m) => !ids.includes(m));
      if (denied.length) throw forbidden('You do not have access to one or more selected members');
    }
    const rows = await db.many('SELECT id FROM organization_members WHERE organization_id = $1 AND id = ANY($2::uuid[])', [
      ctx.orgId,
      memberIds,
    ]);
    ids = rows.map((r) => r.id);
  }
  const teamIds = filters.teamIds?.filter(Boolean);
  if (teamIds?.length) {
    const rows = await db.many(
      `SELECT DISTINCT tm.member_id AS id FROM team_members tm JOIN teams t ON t.id = tm.team_id
       WHERE t.organization_id = $1 AND t.deleted_at IS NULL AND tm.team_id = ANY($2::uuid[])`,
      [ctx.orgId, teamIds],
    );
    const inTeams = rows.map((r) => r.id);
    ids = ids ? ids.filter((i) => inTeams.includes(i)) : inTeams;
  }
  return ids;
}

/** Active, non-client members of the org (optionally limited to ids). */
export async function listMembers(orgId, ids = null, { includeInactive = false } = {}) {
  return db.many(
    `SELECT m.id, m.user_id, m.status, m.department_id, m.weekly_hours, m.last_seen_at, u.email,
            trim(u.first_name || ' ' || u.last_name) AS name
     FROM organization_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
     WHERE m.organization_id = $1 AND m.deleted_at IS NULL AND r.base_role <> 'client'
       ${includeInactive ? '' : `AND m.status = 'active'`}
       AND ($2::uuid[] IS NULL OR m.id = ANY($2::uuid[]))
     ORDER BY name`,
    [orgId, ids],
  );
}

/** Build a request-like context for a member (scheduled reports / shares run with the creator's scope). */
export async function memberContext(memberId) {
  if (!memberId) return null;
  const m = await db.one(
    `SELECT user_id, organization_id FROM organization_members WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
    [memberId],
  );
  if (!m) return null;
  const mc = await loadMemberContext(m.user_id, m.organization_id);
  if (!mc || mc.orgStatus !== 'active') return null;
  return withHelpers({ ...mc, userId: m.user_id, authType: 'system', actorType: 'system' });
}

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

// ── Zod pieces ──
export const zDims = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean));

export const filtersSchema = z
  .object({
    memberIds: z.array(z.uuid()).max(500).optional(),
    teamIds: z.array(z.uuid()).max(100).optional(),
    projectIds: z.array(z.uuid()).max(200).optional(),
    clientIds: z.array(z.uuid()).max(100).optional(),
  })
  .default({});

export const rangeQuery = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  range: z.enum(RANGES).optional(),
});

export const filterQuery = {
  memberIds: zCsvUuids.optional(),
  teamIds: zCsvUuids.optional(),
  projectIds: zCsvUuids.optional(),
  clientIds: zCsvUuids.optional(),
};
