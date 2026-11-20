import { db } from '../../lib/db.js';
import { conflict } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { notify, usersWithPermission } from '../notifications/service.js';
import { resolveSchedule, memberFacts, addDays } from './schedule.js';

/**
 * Attendance business logic (guide §M12): check-in/out (manual, timer, correction, system), late /
 * early-leave / overtime computation, absence detection and auto check-out.
 */

export const RECORD_SELECT = `
  SELECT a.*, u.first_name, u.last_name, m.employee_code
  FROM attendance_records a
  JOIN organization_members m ON m.id = a.member_id
  JOIN users u ON u.id = m.user_id`;

export function recordDto(r) {
  return {
    id: r.id ?? null,
    memberId: r.member_id,
    member: r.first_name !== undefined ? { id: r.member_id, name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(), employeeCode: r.employee_code ?? null } : undefined,
    date: r.date,
    status: r.status,
    checkInAt: r.check_in_at ?? null,
    checkOutAt: r.check_out_at ?? null,
    checkInSource: r.check_in_source ?? null,
    lateMinutes: r.late_minutes ?? 0,
    earlyLeaveMinutes: r.early_leave_minutes ?? 0,
    workedSeconds: r.worked_seconds ?? 0,
    overtimeSeconds: r.overtime_seconds ?? 0,
    workMode: r.work_mode ?? null,
    shiftId: r.shift_id ?? null,
    note: r.note ?? null,
    synthetic: !!r.synthetic,
    holiday: r.holiday ?? undefined,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

export async function orgSettings(orgId) {
  return (
    (await db.one('SELECT * FROM organization_settings WHERE organization_id = $1', [orgId])) ?? {
      attendance_auto_checkin: true,
      late_grace_minutes: 10,
      early_leave_grace_minutes: 10,
    }
  );
}

/** Local date of a timestamp in a time zone. */
export async function localDate(at, tz) {
  return (await db.one(`SELECT to_char(($1::timestamptz AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS d`, [at, tz])).d;
}

/** Member-local today. */
export async function localToday(tz, now = new Date()) {
  return localDate(now, tz);
}

/**
 * Compute status / late / early leave / overtime for a record.
 * @param {object} sched resolveSchedule() result
 */
export function computeMetrics(sched, { checkInAt, checkOutAt, workedSeconds }, settings) {
  let status = 'present';
  let lateMinutes = 0;
  let earlyLeaveMinutes = 0;
  if (sched.working && sched.scheduleType === 'fixed' && sched.startAt && checkInAt) {
    const late = Math.floor((new Date(checkInAt) - new Date(sched.startAt)) / 60000);
    if (late > Number(settings.late_grace_minutes ?? 10)) {
      status = 'late';
      lateMinutes = late;
    }
  }
  if (sched.working && sched.scheduleType === 'fixed' && sched.endAt && checkOutAt) {
    const early = Math.floor((new Date(sched.endAt) - new Date(checkOutAt)) / 60000);
    if (early > Number(settings.early_leave_grace_minutes ?? 10)) earlyLeaveMinutes = early;
  }
  const overtimeSeconds = Math.max(0, (workedSeconds ?? 0) - (sched.expectedSeconds ?? 0));
  return { status, lateMinutes, earlyLeaveMinutes, overtimeSeconds };
}

/** Worked seconds for a member-local date: tracked time if any, else the check-in → check-out span. */
export async function workedSecondsFor(memberId, date, checkInAt, checkOutAt) {
  const ds = await db.one('SELECT tracked_seconds FROM daily_summaries WHERE member_id = $1 AND date = $2', [memberId, date]);
  if (ds?.tracked_seconds > 0) return ds.tracked_seconds;
  if (checkInAt && checkOutAt) return Math.max(0, Math.floor((new Date(checkOutAt) - new Date(checkInAt)) / 1000));
  return 0;
}

export async function getRecord(id, orgId) {
  return db.one(`${RECORD_SELECT} WHERE a.id = $1 AND a.organization_id = $2`, [id, orgId]);
}

/**
 * Recompute derived fields of a record from its check-in/out (after edit, correction, check-out).
 * Keeps explicit non-attendance statuses (absent without check-in, holiday, leave…) untouched.
 */
export async function recalcRecord(recordId, { keepStatus = false } = {}) {
  const r = await db.one('SELECT * FROM attendance_records WHERE id = $1', [recordId]);
  if (!r) return null;
  const settings = await orgSettings(r.organization_id);
  const sched = await resolveSchedule(r.member_id, r.date);
  const worked = await workedSecondsFor(r.member_id, r.date, r.check_in_at, r.check_out_at);
  const mtx = computeMetrics(sched, { checkInAt: r.check_in_at, checkOutAt: r.check_out_at, workedSeconds: worked }, settings);
  let status = r.status;
  if (!keepStatus && r.check_in_at && !['leave', 'half_day'].includes(r.status)) status = mtx.status;
  await db.query(
    `UPDATE attendance_records SET status = $2, late_minutes = $3, early_leave_minutes = $4, worked_seconds = $5,
       overtime_seconds = $6, shift_id = coalesce(shift_id, $7), updated_at = now() WHERE id = $1`,
    [recordId, status, r.check_in_at ? mtx.lateMinutes : 0, mtx.earlyLeaveMinutes, worked, mtx.overtimeSeconds, sched.shiftId],
  );
  return db.one('SELECT * FROM attendance_records WHERE id = $1', [recordId]);
}

async function notifyLate(orgId, memberId, rec) {
  const managers = await usersWithPermission(orgId, 'attendance.view', { memberId });
  await notify({
    orgId,
    memberIds: [memberId],
    userIds: managers,
    type: 'attendance.late',
    title: 'Late arrival',
    body: `Checked in ${rec.late_minutes} minute(s) late on ${rec.date}.`,
    link: '/attendance',
    data: { memberId, date: rec.date, lateMinutes: rec.late_minutes, recordId: rec.id },
    email: false,
  });
}

/**
 * Check in a member. Idempotent per member-local day: an existing check-in is returned unchanged.
 * An 'absent' placeholder (from the absence job) without check-in is converted.
 * @returns {Promise<{record:object, created:boolean}>}
 */
export async function checkIn(orgId, memberId, { at = new Date(), source = 'manual', workMode } = {}) {
  const m = await memberFacts(memberId);
  const date = await localDate(at, m.tz);
  const existing = await db.one('SELECT * FROM attendance_records WHERE member_id = $1 AND date = $2', [memberId, date]);
  if (existing?.check_in_at) return { record: existing, created: false };
  const sched = await resolveSchedule(memberId, date, { member: m });
  const settings = await orgSettings(orgId);
  const mtx = computeMetrics(sched, { checkInAt: at, checkOutAt: null, workedSeconds: 0 }, settings);
  const rec = await db.one(
    `INSERT INTO attendance_records (organization_id, member_id, date, status, check_in_at, check_in_source, late_minutes, work_mode, shift_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (member_id, date) DO UPDATE SET status = EXCLUDED.status, check_in_at = EXCLUDED.check_in_at,
       check_in_source = EXCLUDED.check_in_source, late_minutes = EXCLUDED.late_minutes, work_mode = EXCLUDED.work_mode,
       shift_id = EXCLUDED.shift_id, updated_at = now()
       WHERE attendance_records.check_in_at IS NULL
     RETURNING *`,
    [orgId, memberId, date, mtx.status, at, source, mtx.lateMinutes, workMode ?? sched.workMode, sched.shiftId],
  );
  if (!rec) return { record: await db.one('SELECT * FROM attendance_records WHERE member_id = $1 AND date = $2', [memberId, date]), created: false };
  if (rec.status === 'late') await notifyLate(orgId, memberId, rec);
  await publish('attendance.checked_in', { orgId, memberId, record: recordDto(rec) });
  return { record: rec, created: true };
}

/** Open record to close for a check-out at `at`: the local-day record, else yesterday's open one (night shifts). */
async function openRecordFor(memberId, at, tz) {
  const date = await localDate(at, tz);
  const today = await db.one('SELECT * FROM attendance_records WHERE member_id = $1 AND date = $2 AND check_in_at IS NOT NULL', [memberId, date]);
  if (today) return today;
  return db.one(
    `SELECT * FROM attendance_records WHERE member_id = $1 AND date = $2 AND check_in_at IS NOT NULL AND check_out_at IS NULL`,
    [memberId, addDays(date, -1)],
  );
}

/**
 * Check out. Manual check-out is idempotent (an existing check-out is returned unchanged);
 * timer/system check-outs extend the check-out to the latest stop.
 */
export async function checkOut(orgId, memberId, { at = new Date(), source = 'manual' } = {}) {
  const m = await memberFacts(memberId);
  const rec = await openRecordFor(memberId, at, m.tz);
  if (!rec) {
    if (source === 'manual') throw conflict('NOT_CHECKED_IN', 'You have not checked in today');
    return null;
  }
  if (rec.check_out_at && source === 'manual') return { record: rec, changed: false };
  if (rec.check_out_at && new Date(rec.check_out_at) >= new Date(at)) {
    const fresh = await recalcRecord(rec.id);
    return { record: fresh, changed: false };
  }
  if (new Date(at) < new Date(rec.check_in_at)) return { record: rec, changed: false };
  await db.query('UPDATE attendance_records SET check_out_at = $2, updated_at = now() WHERE id = $1', [rec.id, at]);
  const fresh = await recalcRecord(rec.id);
  await publish('attendance.checked_out', { orgId, memberId, record: recordDto(fresh) });
  return { record: fresh, changed: true };
}

/** Active, trackable (non-client) members of an org (optionally restricted). */
export async function trackableMembers(orgId, { memberIds, teamId, memberId } = {}) {
  const params = [orgId];
  let extra = '';
  if (memberIds) {
    params.push(memberIds);
    extra += ` AND m.id = ANY($${params.length}::uuid[])`;
  }
  if (memberId) {
    params.push(memberId);
    extra += ` AND m.id = $${params.length}`;
  }
  if (teamId) {
    params.push(teamId);
    extra += ` AND m.id IN (SELECT member_id FROM team_members WHERE team_id = $${params.length})`;
  }
  return db.many(
    `SELECT m.id, m.organization_id, m.work_schedule_id, m.department_id, m.work_mode, m.joined_on, m.created_at, m.employee_code,
            coalesce(m.timezone, o.timezone, 'UTC') AS tz, u.first_name, u.last_name,
            to_char(coalesce(m.joined_on, (m.created_at AT TIME ZONE coalesce(m.timezone, o.timezone, 'UTC'))::date), 'YYYY-MM-DD') AS since
     FROM organization_members m JOIN organizations o ON o.id = m.organization_id
     JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
     WHERE m.organization_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL AND r.base_role <> 'client' ${extra}
     ORDER BY u.first_name, u.last_name`,
    params,
  );
}

/** Synthesized row for a day without a record: holiday / weekend / absent (past) or scheduled/not_checked_in. */
export async function syntheticRow(member, date, today) {
  const sched = await resolveSchedule(member.id, date, { member });
  let status;
  if (sched.holiday) status = 'holiday';
  else if (!sched.working) status = 'weekend';
  else if (date < today) status = 'absent';
  else if (date === today) status = 'not_checked_in';
  else status = 'scheduled';
  return {
    id: null,
    member_id: member.id,
    first_name: member.first_name,
    last_name: member.last_name,
    employee_code: member.employee_code,
    date,
    status,
    synthetic: true,
    holiday: sched.holiday ?? undefined,
    work_mode: sched.workMode,
    shift_id: sched.shiftId,
  };
}

/**
 * Absence detection (ATT-08): for each trackable member and each of local yesterday/today, when the day is a
 * working day (not holiday), the schedule end + 2h (or the local day end for flexible schedules) has passed and
 * there is no record → insert 'absent' once and notify.
 */
export async function detectAbsences({ now = new Date(), orgId } = {}) {
  const orgs = orgId
    ? [{ id: orgId }]
    : await db.many(`SELECT id FROM organizations WHERE status = 'active' AND deleted_at IS NULL`);
  let created = 0;
  for (const org of orgs) {
    const members = await trackableMembers(org.id);
    for (const m of members) {
      const today = await localDate(now, m.tz);
      for (const date of [addDays(today, -1), today]) {
        if (date < m.since) continue;
        const has = await db.one('SELECT 1 FROM attendance_records WHERE member_id = $1 AND date = $2', [m.id, date]);
        if (has) continue;
        const sched = await resolveSchedule(m.id, date, { member: m });
        if (!sched.working || sched.holiday) continue;
        let deadline;
        if (sched.scheduleType === 'fixed' && sched.endAt) deadline = new Date(new Date(sched.endAt).getTime() + 2 * 3600_000);
        else deadline = (await db.one(`SELECT (($1::date + 1)::timestamp AT TIME ZONE $2) AS e`, [date, m.tz])).e;
        if (new Date(now) < new Date(deadline)) continue;
        const rec = await db.one(
          `INSERT INTO attendance_records (organization_id, member_id, date, status, check_in_source, work_mode, shift_id, note)
           VALUES ($1,$2,$3,'absent','system',$4,$5,'Auto-detected absence') ON CONFLICT (member_id, date) DO NOTHING RETURNING *`,
          [org.id, m.id, date, sched.workMode, sched.shiftId],
        );
        if (!rec) continue;
        created++;
        const managers = await usersWithPermission(org.id, 'attendance.view', { memberId: m.id });
        await notify({
          orgId: org.id,
          memberIds: [m.id],
          userIds: managers,
          type: 'attendance.alert',
          title: 'Absence recorded',
          body: `${m.first_name} ${m.last_name ?? ''}`.trim() + ` has no check-in for ${date}.`,
          link: '/attendance',
          data: { memberId: m.id, date, recordId: rec.id, kind: 'absent' },
          email: false,
        });
      }
    }
  }
  return created;
}

/**
 * Auto check-out (ATT-02): open check-ins whose local day has ended are closed at the end of the last time
 * entry of that day (or the check-in time when nothing was tracked).
 */
export async function autoCheckout({ now = new Date() } = {}) {
  const open = await db.many(
    `SELECT a.id, a.organization_id, a.member_id, a.date, a.check_in_at, coalesce(m.timezone, o.timezone, 'UTC') AS tz
     FROM attendance_records a JOIN organization_members m ON m.id = a.member_id JOIN organizations o ON o.id = a.organization_id
     WHERE a.check_in_at IS NOT NULL AND a.check_out_at IS NULL
       AND (($1::timestamptz AT TIME ZONE coalesce(m.timezone, o.timezone, 'UTC'))::date) > a.date`,
    [now],
  );
  let closed = 0;
  for (const r of open) {
    const last = await db.one(
      `SELECT max(ended_at) AS e FROM time_entries
       WHERE member_id = $1 AND deleted_at IS NULL AND ended_at IS NOT NULL AND ended_at >= $2
         AND started_at < (($3::date + 1)::timestamp AT TIME ZONE $4)`,
      [r.member_id, r.check_in_at, r.date, r.tz],
    );
    const at = last?.e ?? r.check_in_at;
    await db.query('UPDATE attendance_records SET check_out_at = $2, updated_at = now() WHERE id = $1', [r.id, at]);
    const fresh = await recalcRecord(r.id);
    await publish('attendance.checked_out', { orgId: r.organization_id, memberId: r.member_id, record: recordDto(fresh), auto: true });
    closed++;
  }
  return closed;
}
