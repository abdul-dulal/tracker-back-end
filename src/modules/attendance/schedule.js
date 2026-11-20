import { db } from '../../lib/db.js';

/**
 * Work schedule resolution (guide §M12): for a member and a member-local date returns the effective
 * schedule. Order: shift assignment for the date → member schedule → team schedule → org default
 * schedule → organization_settings working hours. Holidays (org / team / department, incl. recurring
 * yearly) make the day non-working. All times are member-local.
 */

/** 'YYYY-MM-DD' + n days. */
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday 1=Mon..7=Sun of a 'YYYY-MM-DD' string. */
export function isoDow(date) {
  const w = new Date(`${date}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

/** Inclusive list of dates between from and to. */
export function datesBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Weekday arrays may store Sunday as 7 (ISO) or 0. */
const hasDay = (days, iso) => (days ?? []).map(Number).some((d) => d === iso || (iso === 7 && d === 0));

const hhmm = (t) => (t ? String(t).slice(0, 5) : null);
const minutesOf = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};

/** Load the member facts needed by the resolver (cache per call site with a Map). */
async function memberFacts(memberId) {
  return db.one(
    `SELECT m.id, m.organization_id, m.work_schedule_id, m.department_id, m.work_mode, m.joined_on, m.created_at,
            coalesce(m.timezone, o.timezone, 'UTC') AS tz
     FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.id = $1`,
    [memberId],
  );
}

/** Holiday applying to a member on a date (or null). */
export async function holidayFor(member, date) {
  return db.one(
    `SELECT h.id, h.name, h.is_paid FROM holidays h
     WHERE h.organization_id = $1
       AND (h.date = $2::date OR (h.recurring_yearly AND to_char(h.date,'MM-DD') = to_char($2::date,'MM-DD') AND h.date <= $2::date))
       AND (h.applies_to = 'org'
            OR (h.applies_to = 'team' AND h.scope_id IN (SELECT team_id FROM team_members WHERE member_id = $3))
            OR (h.applies_to = 'department' AND h.scope_id IS NOT DISTINCT FROM $4::uuid))
     ORDER BY h.date DESC LIMIT 1`,
    [member.organization_id, date, member.id, member.department_id ?? null],
  );
}

/**
 * Resolve the schedule of a member for a local date.
 * @returns {Promise<{date:string, timezone:string, working:boolean, holiday:{id,name}|null, scheduleType:'fixed'|'flexible',
 *   start:string|null, end:string|null, startAt:Date|null, endAt:Date|null, expectedSeconds:number, shiftId:string|null,
 *   scheduleId:string|null, workMode:string, source:string}>}
 */
export async function resolveSchedule(memberId, date, { member } = {}) {
  const m = member ?? (await memberFacts(memberId));
  if (!m) return null;
  const dow = isoDow(date);
  const holiday = await holidayFor(m, date);

  let result;
  const shift = await db.one(
    `SELECT s.id, s.start_time, s.end_time, s.crosses_midnight, s.break_minutes, a.weekdays
     FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
     WHERE a.member_id = $1 AND a.start_date <= $2::date AND (a.end_date IS NULL OR a.end_date >= $2::date)
       AND ($3 = ANY(a.weekdays) OR ($3 = 7 AND 0 = ANY(a.weekdays)))
     ORDER BY a.start_date DESC, a.created_at DESC LIMIT 1`,
    [m.id, date, dow],
  );
  if (shift) {
    let mins = minutesOf(shift.end_time) - minutesOf(shift.start_time);
    if (mins <= 0 || shift.crosses_midnight) mins += 24 * 60;
    result = {
      working: true,
      scheduleType: 'fixed',
      start: hhmm(shift.start_time),
      end: hhmm(shift.end_time),
      crossesMidnight: shift.crosses_midnight || minutesOf(shift.end_time) <= minutesOf(shift.start_time),
      expectedSeconds: Math.max(0, (mins - shift.break_minutes) * 60),
      shiftId: shift.id,
      scheduleId: null,
      scheduleWorkMode: null,
      source: 'shift',
    };
  } else {
    let sched = null;
    let source = 'member';
    if (m.work_schedule_id) sched = await db.one('SELECT * FROM work_schedules WHERE id = $1', [m.work_schedule_id]);
    if (!sched) {
      source = 'team';
      sched = await db.one(
        `SELECT ws.* FROM team_members tm JOIN teams t ON t.id = tm.team_id AND t.deleted_at IS NULL
         JOIN work_schedules ws ON ws.id = t.work_schedule_id WHERE tm.member_id = $1 ORDER BY tm.joined_at LIMIT 1`,
        [m.id],
      );
    }
    if (!sched) {
      source = 'default';
      sched = await db.one('SELECT * FROM work_schedules WHERE organization_id = $1 AND is_default', [m.organization_id]);
    }
    if (sched) {
      const flexible = sched.schedule_type === 'flexible';
      const start = flexible ? null : hhmm(sched.start_time);
      const end = flexible ? null : hhmm(sched.end_time);
      result = {
        working: hasDay(sched.working_days, dow),
        scheduleType: flexible || !start ? 'flexible' : 'fixed',
        start,
        end,
        crossesMidnight: !!(start && end && minutesOf(end) <= minutesOf(start)),
        expectedSeconds: Math.round(Number(sched.required_hours_per_day) * 3600),
        shiftId: null,
        scheduleId: sched.id,
        scheduleWorkMode: sched.work_mode,
        source,
      };
    } else {
      const s = await db.one('SELECT working_days, work_start, work_end FROM organization_settings WHERE organization_id = $1', [m.organization_id]);
      const start = hhmm(s?.work_start ?? '09:00');
      const end = hhmm(s?.work_end ?? '17:00');
      let mins = minutesOf(end) - minutesOf(start);
      if (mins <= 0) mins += 24 * 60;
      result = {
        working: hasDay(s?.working_days ?? [1, 2, 3, 4, 5], dow),
        scheduleType: 'fixed',
        start,
        end,
        crossesMidnight: minutesOf(end) <= minutesOf(start),
        expectedSeconds: mins * 60,
        shiftId: null,
        scheduleId: null,
        scheduleWorkMode: null,
        source: 'organization',
      };
    }
  }

  const working = result.working && !holiday;
  let startAt = null;
  let endAt = null;
  if (result.start && result.end) {
    const ts = await db.one(
      `SELECT (($1::date + $2::time)::timestamp AT TIME ZONE $4) AS s,
              (($1::date + $5::int + $3::time)::timestamp AT TIME ZONE $4) AS e`,
      [date, result.start, result.end, m.tz, result.crossesMidnight ? 1 : 0],
    );
    startAt = ts.s;
    endAt = ts.e;
  }
  const workMode = m.work_mode && m.work_mode !== 'office' ? m.work_mode : (result.scheduleWorkMode ?? m.work_mode ?? 'office');
  return {
    date,
    timezone: m.tz,
    weekday: dow,
    working,
    holiday: holiday ? { id: holiday.id, name: holiday.name } : null,
    scheduleType: result.scheduleType,
    start: result.start,
    end: result.end,
    startAt,
    endAt,
    expectedSeconds: working ? result.expectedSeconds : 0,
    shiftId: result.shiftId,
    scheduleId: result.scheduleId,
    workMode,
    source: result.source,
  };
}

export { memberFacts };
