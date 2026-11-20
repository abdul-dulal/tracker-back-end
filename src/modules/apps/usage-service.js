import { db } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { buildCategorizer, loadRules, loadCatalog } from './categorize.js';
import { memberTimezone } from '../time/summary-service.js';
import { resolveMemberFilter, assertCanSeeMember } from '../activity/service.js';

/** Shared helpers for app & website usage views (guide §M08). */
export const PERM = 'apps.view';

/** Per-member categorizers sharing one rules/catalog load. */
export async function categorizerFactory(orgId) {
  const rules = await loadRules(orgId);
  const catalog = await loadCatalog();
  const cache = new Map();
  return async (memberId) => {
    if (!cache.has(memberId)) cache.set(memberId, await buildCategorizer(orgId, memberId, { rules, catalog }));
    return cache.get(memberId);
  };
}

export async function rangeWindow(ctx, q) {
  const today = new Date().toISOString().slice(0, 10);
  const to = q.to ?? today;
  const from = q.from ?? new Date(new Date(`${to}T00:00:00Z`).getTime() - 6 * 86400_000).toISOString().slice(0, 10);
  if (from > to) throw badRequest('`from` must be before `to`');
  const tz = q.memberId ? await memberTimezone(q.memberId) : (ctx.orgTimezone ?? ctx.timezone ?? 'UTC');
  const w = await db.one(`SELECT ($1::date::timestamp AT TIME ZONE $3) AS ws, (($2::date + 1)::timestamp AT TIME ZONE $3) AS we`, [from, to, tz]);
  return { from, to, tz, ws: w.ws, we: w.we };
}

export async function dayWindow(memberId, date) {
  const tz = await memberTimezone(memberId);
  const w = await db.one(`SELECT ($1::date::timestamp AT TIME ZONE $2) AS ws, (($1::date + 1)::timestamp AT TIME ZONE $2) AS we`, [date, tz]);
  return { tz, ws: w.ws, we: w.we };
}

export { resolveMemberFilter, assertCanSeeMember };

const share = (s, total) => (total ? Math.round((s / total) * 1000) / 10 : 0);

/**
 * Aggregate usage rows `{ member_id, key, label, s }` into items with categories.
 * @param {'app'|'website'} targetType
 */
export async function aggregateUsage(orgId, rows, targetType, groupBy) {
  const cat = await categorizerFactory(orgId);
  const byKey = new Map();
  const totals = { productive: 0, unproductive: 0, neutral: 0 };
  let total = 0;
  for (const r of rows) {
    const c = r.key === '(excluded)' ? 'neutral' : (await cat(r.member_id))(targetType, [r.label, r.key]);
    totals[c] += r.s;
    total += r.s;
    const k = groupBy === 'category' ? c : r.key;
    if (!byKey.has(k)) byKey.set(k, { key: k, label: groupBy === 'category' ? c : r.label, category: c, seconds: 0, members: new Set() });
    const it = byKey.get(k);
    it.seconds += r.s;
    it.members.add(r.member_id);
  }
  const items = [...byKey.values()]
    .sort((a, b) => b.seconds - a.seconds)
    .map((i) => ({ key: i.key, name: i.label, category: i.category, seconds: i.seconds, percent: share(i.seconds, total), memberCount: i.members.size }));
  return {
    totalSeconds: total,
    productiveSeconds: totals.productive,
    unproductiveSeconds: totals.unproductive,
    neutralSeconds: totals.neutral,
    categories: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { seconds: v, percent: share(v, total) }])),
    items,
  };
}
