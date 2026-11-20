import { db } from '../../lib/db.js';
import { conflict } from '../../lib/errors.js';
import { canAccessMember } from '../../rbac/scope.js';
import { memberTimezone, expectedSecondsForDate } from './summary-service.js';

/**
 * Shared helpers for time entries (M05) used by the time, idle and breaks modules.
 */

export async function orgSettings(orgId) {
  return (
    (await db.one('SELECT * FROM organization_settings WHERE organization_id = $1', [orgId])) ?? {
      require_manual_time_approval: true,
      allow_employee_edit_time: false,
      allow_employee_delete_time: false,
      overtime_mode: 'weekly',
    }
  );
}

/** Does ctx hold time.approve over memberId (privileged editor / approver)? */
export function canApproveMember(ctx, memberId) {
  return canAccessMember(ctx, 'time.approve', memberId);
}

/**
 * LOCK RULE (TIME-26/27): an entry is locked when invoiced, or when a timesheet of the member covering
 * any member-local date of the range is submitted/approved or explicitly locked.
 * @param {object} entry time entry row (needs invoice_id, member_id, organization_id)
 * @param {{start?:Date|string, end?:Date|string|null}[]} ranges extra ranges to check (e.g. the new range of an edit)
 */
export async function assertNotLocked(entry, ranges = []) {
  if (entry.invoice_id) throw conflict('TIMESHEET_LOCKED', 'This entry has been invoiced and can no longer be changed');
  const tz = await memberTimezone(entry.member_id);
  const all = [{ start: entry.started_at, end: entry.ended_at }, ...ranges];
  for (const r of all) {
    if (!r?.start) continue;
    const hit = await db.one(
      `SELECT id, status FROM timesheets
       WHERE member_id = $1 AND organization_id = $2
         AND (status IN ('submitted','approved') OR locked_at IS NOT NULL)
         AND period_start <= (coalesce($4::timestamptz, now()) AT TIME ZONE $5)::date
         AND period_end >= ($3::timestamptz AT TIME ZONE $5)::date
       LIMIT 1`,
      [entry.member_id, entry.organization_id, r.start, r.end ?? null, tz],
    );
    if (hit)
      throw conflict('TIMESHEET_LOCKED', 'The timesheet covering this entry is submitted, approved or locked', { timesheetId: hit.id, status: hit.status });
  }
}

/** Recalculate paused_seconds of an entry from its closed pause rows. */
export async function recalcPausedSeconds(entryId) {
  await db.query(
    `UPDATE time_entries SET paused_seconds = coalesce((SELECT sum(extract(epoch FROM (ended_at - started_at)))::int
       FROM time_entry_pauses WHERE time_entry_id = $1 AND ended_at IS NOT NULL), 0) WHERE id = $1`,
    [entryId],
  );
}

/** Attach { id, name } member info to entry DTOs. */
export async function attachMembers(dtos) {
  const ids = [...new Set(dtos.map((d) => d.memberId))];
  if (!ids.length) return dtos;
  const rows = await db.many(
    `SELECT m.id, u.first_name, u.last_name FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.id = ANY($1::uuid[])`,
    [ids],
  );
  const map = new Map(rows.map((r) => [r.id, { id: r.id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') }]));
  for (const d of dtos) d.member = map.get(d.memberId) ?? { id: d.memberId, name: null };
  return dtos;
}

const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};
const dow = (s) => new Date(`${s}T00:00:00Z`).getUTCDay();

/** Today's date in a time zone (YYYY-MM-DD). */
export async function localToday(tz) {
  return (await db.one(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d`, [tz])).d;
}

export function weekBounds(date, weekStart) {
  const start = addDays(date, -((dow(date) - weekStart + 7) % 7));
  return { start, end: addDays(start, 6) };
}

export function periodBounds(period, date, weekStart) {
  if (period === 'day') return { start: date, end: date };
  if (period === 'week') return weekBounds(date, weekStart);
  const [y, m] = date.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = fmt(new Date(Date.UTC(y, m, 0)));
  return { start, end };
}

export function datesBetween(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Tracked seconds of a member per local date and project in [start, end] (inclusive local dates),
 * allocating entries proportionally across midnight. Running entries are live.
 */
export async function trackedByDayProject(orgId, memberId, start, end, tz) {
  return db.many(
    `WITH days AS (
       SELECT d::date AS day, (d::date::timestamp AT TIME ZONE $5) AS ws, ((d::date + 1)::timestamp AT TIME ZONE $5) AS we
       FROM generate_series($3::date, $4::date, interval '1 day') d),
     e AS (
       SELECT e.id, e.project_id, e.is_billable, e.started_at, coalesce(e.ended_at, now()) AS en,
              extract(epoch FROM (coalesce(e.ended_at, now()) - e.started_at)) AS span,
              CASE WHEN e.ended_at IS NULL THEN greatest(extract(epoch FROM (now() - e.started_at)) - e.paused_seconds - e.idle_discarded_seconds
                     - coalesce((SELECT extract(epoch FROM (now() - p.started_at)) FROM time_entry_pauses p WHERE p.time_entry_id = e.id AND p.ended_at IS NULL), 0), 0)
                   ELSE e.duration_seconds END AS net
       FROM time_entries e
       WHERE e.member_id = $2 AND e.organization_id = $1 AND e.deleted_at IS NULL AND e.status <> 'rejected'
         AND e.started_at < (($4::date + 1)::timestamp AT TIME ZONE $5) AND coalesce(e.ended_at, now()) > ($3::date::timestamp AT TIME ZONE $5))
     SELECT to_char(days.day, 'YYYY-MM-DD') AS date, e.project_id,
            sum(CASE WHEN e.span > 0 THEN e.net * extract(epoch FROM (least(e.en, days.we) - greatest(e.started_at, days.ws))) / e.span ELSE 0 END)::float AS seconds,
            sum(CASE WHEN e.is_billable AND e.span > 0 THEN e.net * extract(epoch FROM (least(e.en, days.we) - greatest(e.started_at, days.ws))) / e.span ELSE 0 END)::float AS billable
     FROM days JOIN e ON e.started_at < days.we AND e.en > days.ws
     GROUP BY 1, 2`,
    [orgId, memberId, start, end, tz],
  );
}

/**
 * Time summary for a member over local dates [start, end] (TIME-11…17, TIME-32).
 * Overtime: daily = Σ max(0, day − expected) when mode daily|both; weekly per week overlapping the range =
 * max(0, weekTotal − (mode both ? weekDailyOvertime : 0) − weekly_hours) when mode weekly|both (no double counting).
 */
export async function buildSummary(orgId, memberId, start, end) {
  const tz = await memberTimezone(memberId);
  const info = await db.one(
    `SELECT m.weekly_hours, o.week_start, coalesce(s.overtime_mode, 'weekly') AS overtime_mode
     FROM organization_members m JOIN organizations o ON o.id = m.organization_id
     LEFT JOIN organization_settings s ON s.organization_id = o.id WHERE m.id = $1`,
    [memberId],
  );
  const mode = info.overtime_mode;
  const dailyMode = ['daily', 'both'].includes(mode);
  const weeklyMode = ['weekly', 'both'].includes(mode);
  const extStart = weekBounds(start, info.week_start).start;
  const extEnd = weekBounds(end, info.week_start).end;
  const rows = await trackedByDayProject(orgId, memberId, extStart, extEnd, tz);

  const perDay = new Map();
  for (const r of rows) {
    const d = perDay.get(r.date) ?? { tracked: 0, billable: 0 };
    d.tracked += r.seconds;
    d.billable += r.billable;
    perDay.set(r.date, d);
  }
  const sums = await db.many(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, active_seconds, idle_seconds, break_seconds, paid_break_seconds, meeting_seconds
     FROM daily_summaries WHERE member_id = $1 AND date BETWEEN $2::date AND $3::date`,
    [memberId, start, end],
  );
  const sumMap = new Map(sums.map((s) => [s.date, s]));

  const expectedCache = new Map();
  const expectedFor = async (d) => {
    if (!expectedCache.has(d)) expectedCache.set(d, await expectedSecondsForDate(memberId, d));
    return expectedCache.get(d);
  };
  const dailyOt = async (d) => {
    if (!dailyMode) return 0;
    const tracked = Math.round(perDay.get(d)?.tracked ?? 0);
    return Math.max(0, tracked - (await expectedFor(d)));
  };

  const days = [];
  const totals = { trackedSeconds: 0, billableSeconds: 0, expectedSeconds: 0, activeSeconds: 0, idleSeconds: 0, breakSeconds: 0, paidBreakSeconds: 0, meetingSeconds: 0 };
  let dailyOvertime = 0;
  for (const d of datesBetween(start, end)) {
    const t = perDay.get(d) ?? { tracked: 0, billable: 0 };
    const s = sumMap.get(d) ?? {};
    const day = {
      date: d,
      trackedSeconds: Math.round(t.tracked),
      billableSeconds: Math.round(t.billable),
      expectedSeconds: await expectedFor(d),
      overtimeSeconds: await dailyOt(d),
      activeSeconds: s.active_seconds ?? 0,
      idleSeconds: s.idle_seconds ?? 0,
      breakSeconds: s.break_seconds ?? 0,
      paidBreakSeconds: s.paid_break_seconds ?? 0,
      meetingSeconds: s.meeting_seconds ?? 0,
    };
    days.push(day);
    for (const k of Object.keys(totals)) totals[k] += day[k];
    dailyOvertime += day.overtimeSeconds;
  }

  const weeklyHoursSec = Math.round(Number(info.weekly_hours ?? 40) * 3600);
  const weeks = [];
  let weeklyOvertime = 0;
  for (let ws = extStart; ws <= extEnd; ) {
    const we = weekBounds(ws, info.week_start).end;
    let tracked = 0;
    let wDaily = 0;
    for (const d of datesBetween(ws, we)) {
      tracked += Math.round(perDay.get(d)?.tracked ?? 0);
      wDaily += await dailyOt(d);
    }
    const ot = weeklyMode ? Math.max(0, tracked - (mode === 'both' ? wDaily : 0) - weeklyHoursSec) : 0;
    weeks.push({ weekStart: ws, weekEnd: we, trackedSeconds: tracked, expectedSeconds: weeklyHoursSec, dailyOvertimeSeconds: wDaily, overtimeSeconds: ot });
    weeklyOvertime += ot;
    const next = new Date(`${we}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    ws = next.toISOString().slice(0, 10);
  }

  const projAgg = new Map();
  for (const r of rows) {
    if (r.date < start || r.date > end) continue;
    const key = r.project_id ?? 'none';
    const p = projAgg.get(key) ?? { projectId: r.project_id, seconds: 0, billableSeconds: 0 };
    p.seconds += r.seconds;
    p.billableSeconds += r.billable;
    projAgg.set(key, p);
  }
  const pids = [...projAgg.values()].map((p) => p.projectId).filter(Boolean);
  const pinfo = pids.length
    ? new Map((await db.many('SELECT id, name, color FROM projects WHERE id = ANY($1::uuid[])', [pids])).map((p) => [p.id, p]))
    : new Map();
  const projects = [...projAgg.values()]
    .map((p) => ({
      projectId: p.projectId,
      name: p.projectId ? (pinfo.get(p.projectId)?.name ?? null) : null,
      color: p.projectId ? (pinfo.get(p.projectId)?.color ?? null) : null,
      seconds: Math.round(p.seconds),
      billableSeconds: Math.round(p.billableSeconds),
    }))
    .sort((a, b) => b.seconds - a.seconds);

  return {
    memberId,
    timezone: tz,
    from: start,
    to: end,
    overtimeMode: mode,
    totals: {
      ...totals,
      overtime: { dailySeconds: dailyOvertime, weeklySeconds: weeklyOvertime, totalSeconds: dailyOvertime + weeklyOvertime },
    },
    days,
    weeks,
    projects,
  };
}
