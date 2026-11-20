import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { orgTimezone, resolveRange, listMembers, rangeQuery, startOfMonth, addDays } from '../reports/common.js';
import { memberMetrics, productivityWeights, SCORE_DISCLAIMER } from './service.js';

/** Leaderboard (LB-01…LB-06). Ranks active members of the org (or a team); employees are blocked when the org hides it. */
const r = createRouter('/leaderboard', 'Performance');

const METRICS = {
  productivity: 'productivityScore',
  activity: 'activityPercent',
  tasks_completed: 'tasksCompleted',
  hours: 'trackedSeconds',
  completion_rate: 'taskCompletionRate',
};

r.get(
  '/',
  {
    summary: 'Leaderboard by productivity, activity, tasks completed, hours, completion rate or monthly ranking (LB-01…06)',
    ids: 'LB-01,LB-02,LB-03,LB-04,LB-05,LB-06',
    permission: 'performance.view',
    query: rangeQuery.extend({
      metric: z.enum(['productivity', 'activity', 'tasks_completed', 'hours', 'completion_rate', 'monthly_ranking']).default('productivity'),
      period: z.enum(['today', 'this_week', 'last_week', 'this_month', 'last_month', 'last_7_days', 'last_30_days']).optional(),
      teamId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(10),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    if (ctx.role?.baseRole === 'employee') {
      const s = await db.one('SELECT leaderboard_visible_to_employees AS v FROM organization_settings WHERE organization_id = $1', [ctx.orgId]);
      if (s && !s.v) throw forbidden('The leaderboard is not visible to employees in this organization', 'LEADERBOARD_HIDDEN');
    }
    let ids = null;
    if (q.teamId) {
      const t = await db.one('SELECT id FROM teams WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [q.teamId, ctx.orgId]);
      if (!t) throw notFound('Team');
      ids = (await db.many('SELECT member_id FROM team_members WHERE team_id = $1', [q.teamId])).map((x) => x.member_id);
    }
    const members = await listMembers(ctx.orgId, ids);
    const names = new Map(members.map((m) => [m.id, m.name]));
    const tz = await orgTimezone(ctx.orgId);
    let entries;
    let from;
    let to;
    if (q.metric === 'monthly_ranking') {
      const { today } = await resolveRange({}, tz);
      from = startOfMonth(addDays(startOfMonth(today), -1));
      to = addDays(startOfMonth(today), -1);
      const snaps = await db.many(
        `SELECT member_id, productivity_score FROM performance_snapshots
         WHERE organization_id = $1 AND period_type = 'month' AND period_start = $2 AND member_id = ANY($3::uuid[])`,
        [ctx.orgId, from, members.map((m) => m.id)],
      );
      if (snaps.length) entries = snaps.map((s) => ({ memberId: s.member_id, value: s.productivity_score === null ? null : Number(s.productivity_score) }));
      else {
        const mm = await memberMetrics(ctx.orgId, members.map((m) => m.id), from, to, tz, await productivityWeights(ctx.orgId));
        entries = [...mm.entries()].map(([id, m]) => ({ memberId: id, value: m.productivityScore }));
      }
    } else {
      ({ from, to } = await resolveRange({ from: q.from, to: q.to, range: q.period ?? q.range }, tz, 'this_week'));
      const mm = await memberMetrics(ctx.orgId, members.map((m) => m.id), from, to, tz, await productivityWeights(ctx.orgId));
      const key = METRICS[q.metric];
      entries = [...mm.entries()].map(([id, m]) => ({ memberId: id, value: m[key] }));
    }
    const ranked = entries
      .filter((e) => e.value !== null && e.value !== undefined && names.has(e.memberId))
      .sort((a, b) => b.value - a.value)
      .map((e, i) => ({ rank: i + 1, memberId: e.memberId, name: names.get(e.memberId), value: e.value }));
    ok(res, {
      metric: q.metric,
      from,
      to,
      teamId: q.teamId ?? null,
      entries: ranked.slice(0, q.limit),
      me: ranked.find((e) => e.memberId === ctx.memberId) ?? null,
      disclaimer: SCORE_DISCLAIMER,
    });
  },
);

export default r;
