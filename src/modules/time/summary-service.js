import { db } from '../../lib/db.js';
import { buildCategorizer, BROWSER_PATTERN } from '../apps/categorize.js';

/**
 * Daily summaries (guide §M15 "Performance"): one row per member per member-local date, used by
 * dashboards and reports. Recomputed incrementally whenever entries/breaks/activity/usage change,
 * and nightly for reconciliation.
 */

/** Member's effective time zone. */
export async function memberTimezone(memberId) {
  const r = await db.one(
    `SELECT coalesce(m.timezone, o.timezone, 'UTC') AS tz FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.id = $1`,
    [memberId],
  );
  return r?.tz ?? 'UTC';
}

/** Local dates (YYYY-MM-DD) touched by the [start, end) range in time zone tz. */
export async function localDatesBetween(start, end, tz) {
  const rows = await db.many(
    `SELECT to_char(d, 'YYYY-MM-DD') AS date FROM generate_series(
       ($1::timestamptz AT TIME ZONE $3)::date, (coalesce($2::timestamptz, now()) AT TIME ZONE $3)::date, interval '1 day') d`,
    [start, end, tz],
  );
  return rows.map((r) => r.date);
}

/**
 * Expected working seconds for a member on a local date, from shift assignment → member schedule →
 * team schedule → org default schedule. Holidays and non-working days → 0.
 */
export async function expectedSecondsForDate(memberId, date) {
  const m = await db.one('SELECT organization_id, work_schedule_id FROM organization_members WHERE id = $1', [memberId]);
  const dow = (await db.one(`SELECT extract(isodow FROM $1::date)::int % 7 AS d`, [date])).d; // 0=Sun..6=Sat
  const holiday = await db.one(
    `SELECT 1 FROM holidays h WHERE h.organization_id = $1 AND (h.date = $2::date OR (h.recurring_yearly AND h.date <= $2::date AND to_char(h.date,'MM-DD') = to_char($2::date,'MM-DD')))
       AND (h.applies_to = 'org'
            OR (h.applies_to = 'team' AND h.scope_id IN (SELECT team_id FROM team_members WHERE member_id = $3))
            OR (h.applies_to = 'department' AND h.scope_id = (SELECT department_id FROM organization_members WHERE id = $3)))
     LIMIT 1`,
    [m.organization_id, date, memberId],
  );
  if (holiday) return 0;
  const shift = await db.one(
    `SELECT s.start_time, s.end_time, s.crosses_midnight, s.break_minutes FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
     WHERE a.member_id = $1 AND a.start_date <= $2::date AND (a.end_date IS NULL OR a.end_date >= $2::date) AND ($3 = ANY(a.weekdays) OR ($3 = 0 AND 7 = ANY(a.weekdays)))
     ORDER BY a.start_date DESC LIMIT 1`,
    [memberId, date, dow],
  );
  if (shift) {
    const [sh, sm] = shift.start_time.split(':').map(Number);
    const [eh, em] = shift.end_time.split(':').map(Number);
    let mins = eh * 60 + em - (sh * 60 + sm);
    if (mins <= 0) mins += 24 * 60; // crosses midnight
    return Math.max(0, (mins - shift.break_minutes) * 60);
  }
  const sched = await db.one(
    `SELECT ws.* FROM work_schedules ws WHERE ws.id = coalesce(
       (SELECT work_schedule_id FROM organization_members WHERE id = $1),
       (SELECT t.work_schedule_id FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.member_id = $1 AND t.work_schedule_id IS NOT NULL LIMIT 1),
       (SELECT id FROM work_schedules WHERE organization_id = $2 AND is_default))`,
    [memberId, m.organization_id],
  );
  if (!sched) return dow >= 1 && dow <= 5 ? 8 * 3600 : 0;
  // working_days may use ISO numbering (Sunday = 7) or JS numbering (Sunday = 0)
  if (!sched.working_days.includes(dow) && !(dow === 0 && sched.working_days.includes(7))) return 0;
  return Math.round(Number(sched.required_hours_per_day) * 3600);
}

/** Recompute the daily summary of one member for one local date. */
export async function recomputeDailySummary(memberId, date) {
  const m = await db.one(
    `SELECT m.organization_id, coalesce(m.timezone, o.timezone, 'UTC') AS tz, s.overtime_mode
     FROM organization_members m JOIN organizations o ON o.id = m.organization_id
     LEFT JOIN organization_settings s ON s.organization_id = o.id WHERE m.id = $1`,
    [memberId],
  );
  if (!m) return null;
  const win = await db.one(
    `SELECT ($1::date::timestamp AT TIME ZONE $2) AS ws, (($1::date + 1)::timestamp AT TIME ZONE $2) AS we`,
    [date, m.tz],
  );
  const p = [memberId, win.ws, win.we];
  // Net worked seconds, proportionally allocated to the window for entries crossing midnight.
  const t = await db.one(
    `WITH e AS (
       SELECT entry_type, is_billable, duration_seconds,
              extract(epoch FROM (coalesce(ended_at, now()) - started_at)) AS span,
              extract(epoch FROM (least(coalesce(ended_at, now()), $3) - greatest(started_at, $2))) AS overlap,
              ended_at IS NULL AS running, paused_seconds, idle_discarded_seconds
       FROM time_entries
       WHERE member_id = $1 AND deleted_at IS NULL AND status <> 'rejected'
         AND started_at < $3 AND coalesce(ended_at, now()) > $2)
     SELECT
       coalesce(sum(CASE WHEN span > 0 THEN overlap * (CASE WHEN running THEN greatest(span - paused_seconds - idle_discarded_seconds, 0) ELSE duration_seconds END) / span ELSE 0 END), 0)::int AS tracked,
       coalesce(sum(CASE WHEN entry_type = 'meeting' AND span > 0 THEN overlap * (CASE WHEN running THEN span - paused_seconds ELSE duration_seconds END) / span ELSE 0 END), 0)::int AS meeting,
       coalesce(sum(CASE WHEN is_billable AND span > 0 THEN overlap * (CASE WHEN running THEN span - paused_seconds ELSE duration_seconds END) / span ELSE 0 END), 0)::int AS billable
     FROM e`,
    p,
  );
  const idle = await db.one(
    `SELECT coalesce(sum(extract(epoch FROM (least(ended_at, $3) - greatest(started_at, $2)))), 0)::int AS s
     FROM idle_periods WHERE member_id = $1 AND started_at < $3 AND ended_at > $2`,
    p,
  );
  const brk = await db.one(
    `SELECT coalesce(sum(extract(epoch FROM (least(coalesce(ended_at, now()), $3) - greatest(started_at, $2)))), 0)::int AS total,
            coalesce(sum(CASE WHEN is_paid THEN extract(epoch FROM (least(coalesce(ended_at, now()), $3) - greatest(started_at, $2))) END), 0)::int AS paid
     FROM breaks WHERE member_id = $1 AND started_at < $3 AND coalesce(ended_at, now()) > $2`,
    p,
  );
  const act = await db.one(
    `SELECT coalesce(sum(active_seconds), 0)::int AS active, coalesce(sum(interval_seconds), 0)::int AS total
     FROM activity_samples WHERE member_id = $1 AND interval_start >= $2 AND interval_start < $3`,
    p,
  );
  const shots = await db.one(
    `SELECT count(*)::int AS n FROM screenshots WHERE member_id = $1 AND captured_at >= $2 AND captured_at < $3 AND deleted_at IS NULL`,
    p,
  );
  // Productivity from app & website usage (browser app time is replaced by website time when present).
  const apps = await db.many(
    `SELECT app_identifier, app_name, sum(duration_seconds)::int AS s FROM app_usage
     WHERE member_id = $1 AND started_at >= $2 AND started_at < $3 GROUP BY 1, 2`,
    p,
  );
  const webs = await db.many(
    `SELECT domain, sum(duration_seconds)::int AS s FROM web_usage
     WHERE member_id = $1 AND started_at >= $2 AND started_at < $3 AND NOT is_excluded GROUP BY 1`,
    p,
  );
  const cat = { productive: 0, unproductive: 0, neutral: 0 };
  if (apps.length || webs.length) {
    const categorize = await buildCategorizer(m.organization_id, memberId);
    const hasWeb = webs.length > 0;
    for (const a of apps) {
      if (hasWeb && BROWSER_PATTERN.test(`${a.app_identifier} ${a.app_name}`)) continue;
      cat[categorize('app', [a.app_name, a.app_identifier])] += a.s;
    }
    for (const w of webs) cat[categorize('website', [w.domain])] += w.s;
  }
  let overtime = 0;
  if (['daily', 'both'].includes(m.overtime_mode)) {
    const expected = await expectedSecondsForDate(memberId, date);
    overtime = Math.max(0, t.tracked - expected);
  }
  const activityPercent = act.total > 0 ? Math.min(100, Math.round((act.active / act.total) * 100)) : 0;
  return db.one(
    `INSERT INTO daily_summaries (organization_id, member_id, date, tracked_seconds, active_seconds, idle_seconds, break_seconds,
       paid_break_seconds, meeting_seconds, productive_seconds, unproductive_seconds, neutral_seconds, billable_seconds,
       overtime_seconds, activity_percent, screenshot_count, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
     ON CONFLICT (member_id, date) DO UPDATE SET tracked_seconds = EXCLUDED.tracked_seconds, active_seconds = EXCLUDED.active_seconds,
       idle_seconds = EXCLUDED.idle_seconds, break_seconds = EXCLUDED.break_seconds, paid_break_seconds = EXCLUDED.paid_break_seconds,
       meeting_seconds = EXCLUDED.meeting_seconds, productive_seconds = EXCLUDED.productive_seconds,
       unproductive_seconds = EXCLUDED.unproductive_seconds, neutral_seconds = EXCLUDED.neutral_seconds,
       billable_seconds = EXCLUDED.billable_seconds, overtime_seconds = EXCLUDED.overtime_seconds,
       activity_percent = EXCLUDED.activity_percent, screenshot_count = EXCLUDED.screenshot_count, updated_at = now()
     RETURNING *`,
    [m.organization_id, memberId, date, t.tracked, act.active, idle.s, brk.total, brk.paid, t.meeting, cat.productive, cat.unproductive, cat.neutral, t.billable, overtime, activityPercent, shots.n],
  );
}

/** Recompute summaries for every local date touched by [start, end) for a member. */
export async function recomputeRange(memberId, start, end) {
  const tz = await memberTimezone(memberId);
  const dates = await localDatesBetween(start, end ?? new Date(), tz);
  for (const d of dates) await recomputeDailySummary(memberId, d);
  return dates;
}

/** Recompute summaries for a time entry (old and new ranges when edited). */
export async function recomputeForEntry(entry, previous) {
  await recomputeRange(entry.member_id, entry.started_at, entry.ended_at ?? new Date());
  if (previous && (previous.started_at?.getTime?.() !== entry.started_at?.getTime?.() || previous.ended_at?.getTime?.() !== entry.ended_at?.getTime?.()))
    await recomputeRange(previous.member_id, previous.started_at, previous.ended_at ?? new Date());
}
