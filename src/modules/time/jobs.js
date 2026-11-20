import { db } from '../../lib/db.js';
import { registerCron } from '../../lib/jobs.js';
import { subscribe } from '../../lib/events.js';
import { logger } from '../../lib/logger.js';
import { notify, usersWithPermission } from '../notifications/service.js';
import { recomputeDailySummary, expectedSecondsForDate } from './summary-service.js';
import { weekBounds } from './entry-service.js';

const HOUR = 3600_000;

/** Members with tracking activity in the last 48h (entries, breaks, idle, activity). */
async function recentlyActiveMembers() {
  return db.many(
    `SELECT m.id, m.organization_id, coalesce(m.timezone, o.timezone, 'UTC') AS tz, m.weekly_hours, o.week_start,
            coalesce(s.overtime_mode, 'weekly') AS overtime_mode
     FROM organization_members m JOIN organizations o ON o.id = m.organization_id
     LEFT JOIN organization_settings s ON s.organization_id = o.id
     WHERE m.deleted_at IS NULL AND o.deleted_at IS NULL AND m.id IN (
       SELECT member_id FROM time_entries WHERE deleted_at IS NULL AND (ended_at IS NULL OR ended_at > now() - interval '48 hours' OR updated_at > now() - interval '48 hours')
       UNION SELECT member_id FROM breaks WHERE coalesce(ended_at, now()) > now() - interval '48 hours'
       UNION SELECT member_id FROM idle_periods WHERE ended_at > now() - interval '48 hours'
       UNION SELECT member_id FROM activity_samples WHERE interval_start > now() - interval '48 hours')`,
  );
}

/** Reconcile daily summaries for yesterday + today (member-local). */
registerCron('summaries.reconcile', 6 * HOUR, async () => {
  const members = await recentlyActiveMembers();
  for (const m of members) {
    try {
      const d = await db.one(
        `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today, to_char((now() AT TIME ZONE $1)::date - 1, 'YYYY-MM-DD') AS yesterday`,
        [m.tz],
      );
      await recomputeDailySummary(m.id, d.yesterday);
      await recomputeDailySummary(m.id, d.today);
    } catch (err) {
      logger.error({ err, memberId: m.id }, 'summary reconcile failed');
    }
  }
  return members.length;
});

async function alreadyAlerted(userId, memberId, period, key) {
  return !!(await db.one(
    `SELECT 1 FROM notifications WHERE recipient_user_id = $1 AND type = 'overtime.alert'
       AND data->>'memberId' = $2 AND data->>'period' = $3 AND data->>'key' = $4 LIMIT 1`,
    [userId, memberId, period, key],
  ));
}

async function sendOvertime(m, period, key, trackedSeconds, expectedSeconds) {
  const member = await db.one(
    `SELECT m.user_id, u.first_name, u.last_name FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.status = 'active'`,
    [m.id],
  );
  if (!member) return 0;
  const approvers = await usersWithPermission(m.organization_id, 'time.approve', { memberId: m.id });
  const recipients = [...new Set([member.user_id, ...approvers])];
  const pending = [];
  for (const u of recipients) if (!(await alreadyAlerted(u, m.id, period, key))) pending.push(u);
  if (!pending.length) return 0;
  const name = [member.first_name, member.last_name].filter(Boolean).join(' ');
  const hours = (s) => (s / 3600).toFixed(1);
  await notify({
    orgId: m.organization_id,
    userIds: pending,
    type: 'overtime.alert',
    title: period === 'day' ? 'Daily overtime' : 'Weekly overtime',
    body: `${name} has tracked ${hours(trackedSeconds)}h ${period === 'day' ? 'today' : 'this week'} (expected ${hours(expectedSeconds)}h).`,
    link: `/time/summary?memberId=${m.id}&period=${period}`,
    data: { memberId: m.id, period, key, trackedSeconds, expectedSeconds },
  });
  return pending.length;
}

/** Hourly overtime alerts: at most once per member per day / week. */
registerCron('alerts.overtime', HOUR, async () => {
  const members = await recentlyActiveMembers();
  let sent = 0;
  for (const m of members) {
    if (m.overtime_mode === 'none') continue;
    try {
      const today = (await db.one(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [m.tz])).d;
      const sum = await recomputeDailySummary(m.id, today);
      const tracked = sum?.tracked_seconds ?? 0;
      const expected = await expectedSecondsForDate(m.id, today);
      if (tracked > 0 && tracked > expected) sent += await sendOvertime(m, 'day', today, tracked, expected);
      const wb = weekBounds(today, m.week_start);
      const wk = await db.one(
        `SELECT coalesce(sum(tracked_seconds), 0)::int AS s FROM daily_summaries WHERE member_id = $1 AND date BETWEEN $2::date AND $3::date`,
        [m.id, wb.start, wb.end],
      );
      const weekly = Math.round(Number(m.weekly_hours ?? 40) * 3600);
      if (weekly > 0 && wk.s > weekly) sent += await sendOvertime(m, 'week', wb.start, wk.s, weekly);
    } catch (err) {
      logger.error({ err, memberId: m.id }, 'overtime alert failed');
    }
  }
  return sent;
});

/** In-app (no email) confirmations when the member's timer starts/stops (web or desktop). */
for (const [event, title] of [
  ['timer.started', 'Timer started'],
  ['timer.stopped', 'Timer stopped'],
]) {
  subscribe(event, async ({ orgId, memberId, entry }) => {
    if (!orgId || !memberId) return;
    const what = entry?.task?.title ?? entry?.project?.name ?? null;
    await notify({
      orgId,
      memberIds: [memberId],
      type: event,
      title,
      body: what ? `${title} on ${what}.` : `${title}.`,
      link: '/time',
      data: { entryId: entry?.id ?? null },
      email: false,
    });
  });
}
