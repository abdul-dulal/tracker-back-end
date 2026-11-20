import { registerCron } from '../../lib/jobs.js';
import { db } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { notify, usersWithPermission } from '../notifications/service.js';
import { orgTimezone, todayIn, listMembers, startOfWeek, startOfMonth, addDays, round2 } from '../reports/common.js';
import { memberMetrics, aggregateMetrics, productivityWeights, previousGoalPeriod, evaluateGoal } from './service.js';

/**
 * Performance crons: snapshots (PERF-16), productivity alerts (PERF-18), weekly/monthly summaries (NOTIF-16/17).
 * All are idempotent (snapshots unique per period; notifications de-duplicated by data.dedupe).
 */
const DAY = 24 * 3600_000;

async function activeOrgs() {
  return db.many(`SELECT id, name FROM organizations WHERE status = 'active' AND deleted_at IS NULL`);
}

/** Notify users that have not yet received a notification with this dedupe key. */
async function notifyOnce({ orgId, userIds, type, dedupe, ...rest }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  const done = await db.many(
    `SELECT recipient_user_id FROM notifications WHERE type = $1 AND recipient_user_id = ANY($2::uuid[]) AND data->>'dedupe' = $3`,
    [type, ids, dedupe],
  );
  const skip = new Set(done.map((d) => d.recipient_user_id));
  const todo = ids.filter((i) => !skip.has(i));
  if (!todo.length) return 0;
  await notify({ orgId, userIds: todo, type, ...rest, data: { ...(rest.data ?? {}), dedupe } });
  return todo.length;
}

const hours = (s) => round2(s / 3600);

/** Monthly + weekly snapshots with rank by productivity score. */
export async function createSnapshots() {
  let created = 0;
  for (const org of await activeOrgs()) {
    const tz = await orgTimezone(org.id);
    const today = await todayIn(tz);
    const periods = [
      { type: 'month', from: startOfMonth(addDays(startOfMonth(today), -1)), to: addDays(startOfMonth(today), -1) },
      { type: 'week', from: addDays(startOfWeek(today), -7), to: addDays(startOfWeek(today), -1) },
    ];
    const members = await listMembers(org.id);
    if (!members.length) continue;
    const weights = await productivityWeights(org.id);
    for (const p of periods) {
      const exists = await db.one(
        'SELECT 1 FROM performance_snapshots WHERE organization_id = $1 AND period_type = $2 AND period_start = $3 LIMIT 1',
        [org.id, p.type, p.from],
      );
      if (exists) continue;
      const mm = await memberMetrics(org.id, members.map((m) => m.id), p.from, p.to, tz, weights);
      const ranked = [...mm.entries()].sort((a, b) => (b[1].productivityScore ?? -1) - (a[1].productivityScore ?? -1));
      let rank = 0;
      for (const [memberId, m] of ranked) {
        const r = m.productivityScore === null ? null : ++rank;
        const ins = await db.query(
          `INSERT INTO performance_snapshots (organization_id, member_id, period_type, period_start, metrics, productivity_score, rank)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (member_id, period_type, period_start) DO NOTHING`,
          [org.id, memberId, p.type, p.from, db.json(m), m.productivityScore, r],
        );
        created += ins.rowCount ?? 0;
      }
    }
  }
  return created;
}

/** Low productivity score (< 40 over the last 7 days) and unmet goals for the previous period → 'productivity.alert'. */
export async function productivityAlerts() {
  let sent = 0;
  for (const org of await activeOrgs()) {
    const tz = await orgTimezone(org.id);
    const today = await todayIn(tz);
    const from = addDays(today, -7);
    const to = addDays(today, -1);
    const members = await listMembers(org.id);
    const mm = await memberMetrics(org.id, members.map((m) => m.id), from, to, tz);
    for (const m of members) {
      const x = mm.get(m.id);
      if (!x || x.trackedSeconds <= 0 || x.productivityScore === null || x.productivityScore >= 40) continue;
      const managers = await usersWithPermission(org.id, 'performance.view', { memberId: m.id });
      sent += await notifyOnce({
        orgId: org.id, userIds: managers, type: 'productivity.alert', dedupe: `score:${m.id}:${to}`,
        title: `Low productivity score: ${m.name}`,
        body: `${m.name}'s productivity score was ${x.productivityScore} for ${from} – ${to} (indicator only).`,
        link: `/performance/members/${m.id}`, data: { memberId: m.id, score: x.productivityScore, from, to },
      });
    }
    const goals = await db.many('SELECT * FROM performance_goals WHERE organization_id = $1 AND active', [org.id]);
    for (const g of goals) {
      const p = previousGoalPeriod(g.period, today);
      const ev = await evaluateGoal(g, p.from, p.to, tz);
      if (ev.met) continue;
      let userIds;
      if (g.scope_type === 'member') {
        const mem = await db.one('SELECT user_id FROM organization_members WHERE id = $1', [g.scope_id]);
        userIds = [mem?.user_id, ...(await usersWithPermission(org.id, 'performance.view', { memberId: g.scope_id }))];
      } else {
        userIds = (await db.many(
          `SELECT m.user_id FROM team_managers tm JOIN organization_members m ON m.id = tm.member_id WHERE tm.team_id = $1
           UNION SELECT m.user_id FROM team_members tm JOIN organization_members m ON m.id = tm.member_id WHERE tm.team_id = $1 AND tm.is_leader`,
          [g.scope_id],
        )).map((r) => r.user_id);
      }
      sent += await notifyOnce({
        orgId: org.id, userIds, type: 'productivity.alert', dedupe: `goal:${g.id}:${p.from}`,
        title: `Goal not met: ${g.name}`,
        body: `${g.metric} was ${ev.value} (target ${g.comparator === 'gte' ? '≥' : '≤'} ${ev.target}) for ${p.from} – ${p.to}.`,
        link: '/performance/goals', data: { goalId: g.id, ...ev },
      });
    }
  }
  return sent;
}

/** Weekly/monthly summaries to members (own) and team summaries to team managers/leaders. */
export async function sendSummaries(kind) {
  let sent = 0;
  const type = kind === 'week' ? 'summary.weekly' : 'summary.monthly';
  for (const org of await activeOrgs()) {
    const tz = await orgTimezone(org.id);
    const today = await todayIn(tz);
    const from = kind === 'week' ? addDays(startOfWeek(today), -7) : startOfMonth(addDays(startOfMonth(today), -1));
    const to = kind === 'week' ? addDays(startOfWeek(today), -1) : addDays(startOfMonth(today), -1);
    const label = kind === 'week' ? 'Weekly' : 'Monthly';
    const members = await listMembers(org.id);
    const mm = await memberMetrics(org.id, members.map((m) => m.id), from, to, tz);
    for (const m of members) {
      const x = mm.get(m.id);
      sent += await notifyOnce({
        orgId: org.id, userIds: [m.user_id], type, dedupe: `${type}:${m.id}:${from}`,
        title: `${label} summary (${from} – ${to})`,
        body: `You tracked ${hours(x.trackedSeconds)} h with ${x.activityPercent}% activity and completed ${x.tasksCompleted} task(s).`,
        link: '/dashboard', data: { from, to, memberId: m.id, trackedSeconds: x.trackedSeconds, activityPercent: x.activityPercent, tasksCompleted: x.tasksCompleted },
      });
    }
    const teams = await db.many('SELECT id, name FROM teams WHERE organization_id = $1 AND deleted_at IS NULL', [org.id]);
    for (const t of teams) {
      const ids = (await db.many('SELECT member_id FROM team_members WHERE team_id = $1', [t.id])).map((r) => r.member_id);
      if (!ids.length) continue;
      const managers = (await db.many(
        `SELECT m.user_id FROM team_managers tm JOIN organization_members m ON m.id = tm.member_id WHERE tm.team_id = $1
         UNION SELECT m.user_id FROM team_members tm JOIN organization_members m ON m.id = tm.member_id WHERE tm.team_id = $1 AND tm.is_leader`,
        [t.id],
      )).map((r) => r.user_id);
      if (!managers.length) continue;
      const { metrics } = await aggregateMetrics(org.id, ids, from, to, tz);
      sent += await notifyOnce({
        orgId: org.id, userIds: managers, type, dedupe: `${type}:team:${t.id}:${from}`,
        title: `${label} team summary: ${t.name}`,
        body: `${t.name} tracked ${hours(metrics.trackedSeconds)} h with ${metrics.activityPercent}% activity; ${metrics.tasksCompleted} task(s) completed.`,
        link: `/performance/teams/${t.id}`, data: { from, to, teamId: t.id, trackedSeconds: metrics.trackedSeconds, activityPercent: metrics.activityPercent },
      });
    }
  }
  return sent;
}

const safe = (name, fn) => async () => {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err }, `${name} failed`);
    throw err;
  }
};

registerCron('performance.snapshots', DAY, safe('performance.snapshots', createSnapshots));
registerCron('performance.alerts', DAY, safe('performance.alerts', productivityAlerts));
registerCron('summary.weekly', DAY, safe('summary.weekly', () => sendSummaries('week')));
registerCron('summary.monthly', DAY, safe('summary.monthly', () => sendSummaries('month')));
