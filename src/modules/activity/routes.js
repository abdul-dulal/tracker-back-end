import { z } from 'zod';
import { createRouter, zCsvUuids } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, dateStr } from '../../lib/http.js';
import { badRequest } from '../../lib/errors.js';
import { memberTimezone } from '../time/summary-service.js';
import { getThresholds, activityLevel, pct, assertCanSeeMember, resolveMemberFilter, visibleMemberIds, ACTIVITY_NOTE } from './service.js';

/**
 * Activity monitoring views (guide §M07, ACT-06…17). Only per-interval activity seconds exist —
 * there is no keystroke content, key code or pointer position anywhere in the system.
 */
const r = createRouter('/activity', 'Activity');

const PERM = 'activity.view';

/** Window [ws, we) for a local date range. */
async function windowFor(from, to, tz) {
  return db.one(`SELECT ($1::date::timestamp AT TIME ZONE $3) AS ws, (($2::date + 1)::timestamp AT TIME ZONE $3) AS we`, [from, to, tz]);
}

const defaultRange = (q) => {
  const today = new Date().toISOString().slice(0, 10);
  const to = q.to ?? today;
  const from = q.from ?? new Date(new Date(`${to}T00:00:00Z`).getTime() - 6 * 86400_000).toISOString().slice(0, 10);
  if (from > to) throw badRequest('`from` must be before `to`');
  return { from, to };
};

/** Aggregate activity samples (+ idle periods) for member ids, optionally restricted to a project. */
async function aggregate({ orgId, memberIds, projectId, ws, we, tz, granularity }) {
  const params = [orgId, ws, we, memberIds, projectId ?? null];
  const filter = `a.organization_id = $1 AND a.interval_start >= $2 AND a.interval_start < $3
    AND ($4::uuid[] IS NULL OR a.member_id = ANY($4::uuid[])) AND ($5::uuid IS NULL OR a.project_id = $5)`;
  const series = granularity
    ? await db.many(
        `SELECT to_char(date_trunc('${granularity}', a.interval_start AT TIME ZONE $6::text), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
                sum(a.active_seconds)::int AS active, sum(a.interval_seconds)::int AS total
         FROM activity_samples a WHERE ${filter} GROUP BY 1 ORDER BY 1`,
        [...params, tz],
      )
    : [];
  const tot = await db.one(`SELECT coalesce(sum(a.active_seconds), 0)::int AS active, coalesce(sum(a.interval_seconds), 0)::int AS total FROM activity_samples a WHERE ${filter}`, params);
  const dist = await db.many(`SELECT a.activity_percent AS p, count(*)::int AS n FROM activity_samples a WHERE ${filter} GROUP BY 1`, params);
  return { series, tot, dist };
}

function levelDistribution(dist, th) {
  const out = { low: 0, moderate: 0, high: 0 };
  let n = 0;
  for (const d of dist) {
    out[activityLevel(d.p, th)] += d.n;
    n += d.n;
  }
  return {
    counts: out,
    percent: { low: n ? Math.round((out.low / n) * 100) : 0, moderate: n ? Math.round((out.moderate / n) * 100) : 0, high: n ? Math.round((out.high / n) * 100) : 0 },
  };
}

r.get(
  '/timeline',
  { summary: 'Activity timeline in 10-minute buckets for one member-day', ids: 'ACT-06, ACT-17', query: z.object({ memberId: z.uuid().optional(), date: dateStr }) },
  async (req, res) => {
    const ctx = req.ctx;
    const memberId = req.v.query.memberId ?? ctx.memberId;
    await assertCanSeeMember(ctx, PERM, memberId);
    const tz = await memberTimezone(memberId);
    const win = await windowFor(req.v.query.date, req.v.query.date, tz);
    const rows = await db.many(
      `SELECT floor(extract(epoch FROM (interval_start - $3::timestamptz)) / 600)::int AS slot, sum(active_seconds)::int AS active,
              sum(interval_seconds)::int AS total, sum(keyboard_active_seconds)::int AS kb, sum(mouse_active_seconds)::int AS mouse
       FROM activity_samples WHERE organization_id = $1 AND member_id = $2 AND interval_start >= $3 AND interval_start < $4 GROUP BY 1 ORDER BY 1`,
      [ctx.orgId, memberId, win.ws, win.we],
    );
    const idle = await db.many(
      `SELECT id, started_at, ended_at, duration_seconds, resolution FROM idle_periods WHERE organization_id = $1 AND member_id = $2 AND started_at < $4 AND ended_at > $3 ORDER BY started_at`,
      [ctx.orgId, memberId, win.ws, win.we],
    );
    const th = await getThresholds(ctx.orgId);
    const ws = new Date(win.ws).getTime();
    const buckets = rows.map((b) => {
      const p = pct(b.active, b.total);
      return {
        startsAt: new Date(ws + b.slot * 600_000).toISOString(),
        trackedSeconds: b.total,
        activeSeconds: b.active,
        idleSeconds: Math.max(0, b.total - b.active),
        keyboardActiveSeconds: b.kb,
        mouseActiveSeconds: b.mouse,
        activityPercent: p,
        level: activityLevel(p, th),
      };
    });
    const active = rows.reduce((s, b) => s + b.active, 0);
    const total = rows.reduce((s, b) => s + b.total, 0);
    ok(res, {
      memberId,
      date: req.v.query.date,
      timezone: tz,
      thresholds: th,
      buckets,
      idlePeriods: idle.map((i) => ({ id: i.id, startedAt: i.started_at, endedAt: i.ended_at, durationSeconds: i.duration_seconds, resolution: i.resolution })),
      totals: { trackedSeconds: total, activeSeconds: active, idleSeconds: Math.max(0, total - active), activityPercent: pct(active, total), level: total ? activityLevel(pct(active, total), th) : null },
      note: ACTIVITY_NOTE,
    });
  },
);

r.get(
  '/summary',
  {
    summary: 'Active vs idle series, average activity and level distribution',
    ids: 'ACT-07, ACT-08, ACT-09, ACT-10, ACT-17',
    query: z.object({
      memberId: z.uuid().optional(),
      teamId: z.uuid().optional(),
      projectId: z.uuid().optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
      granularity: z.enum(['hour', 'day', 'week', 'month']).default('day'),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const { from, to } = defaultRange(q);
    const memberIds = await resolveMemberFilter(ctx, PERM, q);
    const tz = q.memberId ? await memberTimezone(q.memberId) : (ctx.orgTimezone ?? ctx.timezone ?? 'UTC');
    const win = await windowFor(from, to, tz);
    const th = await getThresholds(ctx.orgId);
    const { series, tot, dist } = await aggregate({ orgId: ctx.orgId, memberIds, projectId: q.projectId, ws: win.ws, we: win.we, tz, granularity: q.granularity });
    const idleTot = await db.one(
      `SELECT coalesce(sum(duration_seconds), 0)::int AS s FROM idle_periods
       WHERE organization_id = $1 AND started_at >= $2 AND started_at < $3 AND ($4::uuid[] IS NULL OR member_id = ANY($4::uuid[]))`,
      [ctx.orgId, win.ws, win.we, memberIds],
    );
    ok(res, {
      from,
      to,
      timezone: tz,
      granularity: q.granularity,
      thresholds: th,
      series: series.map((s) => {
        const p = pct(s.active, s.total);
        return { bucket: s.bucket, activeSeconds: s.active, idleSeconds: Math.max(0, s.total - s.active), trackedSeconds: s.total, activityPercent: p, level: activityLevel(p, th) };
      }),
      totals: {
        trackedSeconds: tot.total,
        activeSeconds: tot.active,
        idleSeconds: Math.max(0, tot.total - tot.active),
        idlePeriodSeconds: idleTot.s,
        averageActivityPercent: pct(tot.active, tot.total),
        level: tot.total ? activityLevel(pct(tot.active, tot.total), th) : null,
      },
      levelDistribution: levelDistribution(dist, th),
      note: ACTIVITY_NOTE,
    });
  },
);

r.get(
  '/compare',
  {
    summary: 'Compare activity between members, teams or projects',
    ids: 'ACT-11, ACT-12, ACT-13',
    query: z.object({ memberIds: zCsvUuids.optional(), teamIds: zCsvUuids.optional(), projectIds: zCsvUuids.optional(), from: dateStr.optional(), to: dateStr.optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const { from, to } = defaultRange(q);
    const kind = q.memberIds?.length ? 'member' : q.teamIds?.length ? 'team' : q.projectIds?.length ? 'project' : null;
    if (!kind) throw badRequest('Provide memberIds, teamIds or projectIds');
    const ids = (q.memberIds ?? q.teamIds ?? q.projectIds).slice(0, 50);
    const tz = ctx.orgTimezone ?? ctx.timezone ?? 'UTC';
    const win = await windowFor(from, to, tz);
    const th = await getThresholds(ctx.orgId);
    const visible = await visibleMemberIds(ctx, PERM);
    const items = [];
    for (const id of ids) {
      let memberIds;
      let projectId;
      let name;
      if (kind === 'member') {
        const m = await db.one(`SELECT u.first_name || ' ' || u.last_name AS name FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.organization_id = $2`, [id, ctx.orgId]);
        if (!m || (visible && !visible.includes(id))) continue;
        memberIds = [id];
        name = m.name;
      } else if (kind === 'team') {
        const t = await db.one('SELECT name FROM teams WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [id, ctx.orgId]);
        if (!t) continue;
        memberIds = await resolveMemberFilter(ctx, PERM, { teamId: id });
        name = t.name;
      } else {
        const p = await db.one('SELECT name FROM projects WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [id, ctx.orgId]);
        if (!p) continue;
        memberIds = visible;
        projectId = id;
        name = p.name;
      }
      const { tot, dist } = await aggregate({ orgId: ctx.orgId, memberIds, projectId, ws: win.ws, we: win.we, tz });
      const p = pct(tot.active, tot.total);
      items.push({
        id,
        type: kind,
        name,
        trackedSeconds: tot.total,
        activeSeconds: tot.active,
        idleSeconds: Math.max(0, tot.total - tot.active),
        averageActivityPercent: p,
        level: tot.total ? activityLevel(p, th) : null,
        levelDistribution: levelDistribution(dist, th),
      });
    }
    ok(res, { from, to, type: kind, thresholds: th, items, note: ACTIVITY_NOTE });
  },
);

r.get(
  '/trends',
  {
    summary: 'Activity trend: daily series, 7-day moving average and period-over-period delta',
    ids: 'ACT-14',
    query: z.object({ memberId: z.uuid().optional(), teamId: z.uuid().optional(), period: z.enum(['week', 'month', 'quarter']).default('week') }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const memberIds = await resolveMemberFilter(ctx, PERM, q);
    const tz = q.memberId ? await memberTimezone(q.memberId) : (ctx.orgTimezone ?? ctx.timezone ?? 'UTC');
    const days = { week: 7, month: 30, quarter: 90 }[q.period];
    const { today } = await db.one(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`, [tz]);
    const end = new Date(`${today}T00:00:00Z`);
    const curFrom = new Date(end.getTime() - (days - 1) * 86400_000).toISOString().slice(0, 10);
    const prevTo = new Date(end.getTime() - days * 86400_000).toISOString().slice(0, 10);
    const prevFrom = new Date(end.getTime() - (2 * days - 1) * 86400_000).toISOString().slice(0, 10);
    const th = await getThresholds(ctx.orgId);
    const cw = await windowFor(curFrom, today, tz);
    const pw = await windowFor(prevFrom, prevTo, tz);
    const cur = await aggregate({ orgId: ctx.orgId, memberIds, ws: cw.ws, we: cw.we, tz, granularity: 'day' });
    const prev = await aggregate({ orgId: ctx.orgId, memberIds, ws: pw.ws, we: pw.we, tz });
    const byDay = new Map(cur.series.map((s) => [s.bucket.slice(0, 10), s]));
    const series = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(new Date(`${curFrom}T00:00:00Z`).getTime() + i * 86400_000).toISOString().slice(0, 10);
      const s = byDay.get(d);
      series.push({ date: d, activeSeconds: s?.active ?? 0, trackedSeconds: s?.total ?? 0, activityPercent: s ? pct(s.active, s.total) : null });
    }
    for (let i = 0; i < series.length; i++) {
      const window = series.slice(Math.max(0, i - 6), i + 1).filter((x) => x.trackedSeconds > 0);
      const a = window.reduce((s, x) => s + x.activeSeconds, 0);
      const t = window.reduce((s, x) => s + x.trackedSeconds, 0);
      series[i].movingAverage = t ? pct(a, t) : null;
    }
    const curAvg = cur.tot.total ? pct(cur.tot.active, cur.tot.total) : null;
    const prevAvg = prev.tot.total ? pct(prev.tot.active, prev.tot.total) : null;
    ok(res, {
      period: q.period,
      current: { from: curFrom, to: today, averageActivityPercent: curAvg, trackedSeconds: cur.tot.total, level: curAvg === null ? null : activityLevel(curAvg, th) },
      previous: { from: prevFrom, to: prevTo, averageActivityPercent: prevAvg, trackedSeconds: prev.tot.total },
      deltaPercentPoints: curAvg !== null && prevAvg !== null ? curAvg - prevAvg : null,
      direction: curAvg === null || prevAvg === null ? null : curAvg > prevAvg ? 'up' : curAvg < prevAvg ? 'down' : 'flat',
      series,
      note: ACTIVITY_NOTE,
    });
  },
);

export default r;
