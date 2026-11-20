import { db } from '../../lib/db.js';
import { publish } from '../../lib/events.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { notify, usersWithPermission } from '../notifications/service.js';
import { assertMemberAccess } from '../../rbac/scope.js';
import { expectedSecondsForDate, memberTimezone } from '../time/summary-service.js';

/**
 * Timesheets (guide §M14): one timesheet per member per period (organization_settings.timesheet_period,
 * weeks aligned to organizations.week_start). Totals come from time entries whose member-local start date
 * falls in the period. State machine: draft → submitted → (level n)… → approved(locked); submitted → rejected
 * → submitted (revision+1). Every transition writes timesheet_events and publishes timesheet.*.
 */

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dow0 = (date) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
const daysDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** Start of the week containing date (weekStart: 0=Sun..6=Sat). */
export function weekStartOf(date, weekStart = 1) {
  return addDays(date, -((dow0(date) - weekStart + 7) % 7));
}

/** Compute the period containing a date. */
export function periodFor(date, type = 'week', weekStart = 1) {
  if (type === 'month') {
    const [y, m] = date.split('-').map(Number);
    return { type, start: `${date.slice(0, 7)}-01`, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
  }
  if (type === 'day') return { type, start: date, end: date };
  let start = weekStartOf(date, weekStart);
  if (type === 'biweek') {
    const anchor = weekStartOf('2024-01-01', weekStart);
    const weeks = Math.floor(daysDiff(anchor, start) / 7);
    if (((weeks % 2) + 2) % 2 === 1) start = addDays(start, -7);
    return { type, start, end: addDays(start, 13) };
  }
  return { type: 'week', start, end: addDays(start, 6) };
}

export async function orgTimesheetSettings(orgId) {
  return db.one(
    `SELECT o.week_start, coalesce(s.timesheet_period, 'week') AS timesheet_period, coalesce(s.timesheet_approval_levels, 1) AS approval_levels,
            s.timesheet_lock_after_days, coalesce(s.overtime_mode, 'weekly') AS overtime_mode
     FROM organizations o LEFT JOIN organization_settings s ON s.organization_id = o.id WHERE o.id = $1`,
    [orgId],
  );
}

export async function memberLocalToday(memberId) {
  const tz = await memberTimezone(memberId);
  return (await db.one(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [tz])).d;
}

/** Shared SQL predicate: time entry e of member in period ($tz param, $start/$end params). */
export const entryInPeriodSql = (tzP, startP, endP) =>
  `e.deleted_at IS NULL AND e.status <> 'rejected' AND (e.started_at AT TIME ZONE ${tzP})::date BETWEEN ${startP}::date AND ${endP}::date`;

/** Recompute total / billable / overtime seconds of a timesheet. */
export async function refreshTotals(ts) {
  const tz = await memberTimezone(ts.member_id);
  const t = await db.one(
    `SELECT coalesce(sum(e.duration_seconds), 0)::int AS total,
            coalesce(sum(e.duration_seconds) FILTER (WHERE e.is_billable), 0)::int AS billable
     FROM time_entries e WHERE e.member_id = $1 AND e.ended_at IS NOT NULL AND ${entryInPeriodSql('$2', '$3', '$4')}`,
    [ts.member_id, tz, ts.period_start, ts.period_end],
  );
  const settings = await orgTimesheetSettings(ts.organization_id);
  let overtime = 0;
  if (settings.overtime_mode !== 'none') {
    const ds = await db.one(
      `SELECT coalesce(sum(overtime_seconds), 0)::int AS s FROM daily_summaries WHERE member_id = $1 AND date BETWEEN $2 AND $3`,
      [ts.member_id, ts.period_start, ts.period_end],
    );
    overtime = ds.s;
    if (['weekly', 'both'].includes(settings.overtime_mode)) {
      let expected = 0;
      for (let d = ts.period_start; d <= ts.period_end; d = addDays(d, 1)) expected += await expectedSecondsForDate(ts.member_id, d);
      overtime = Math.max(overtime, t.total - expected);
    }
  }
  return db.one(
    `UPDATE timesheets SET total_seconds = $2, billable_seconds = $3, overtime_seconds = $4, updated_at = now() WHERE id = $1 RETURNING *`,
    [ts.id, t.total, t.billable, Math.max(0, overtime)],
  );
}

export async function writeEvent(ts, actorMemberId, fromStatus, toStatus, comment) {
  await db.query(
    `INSERT INTO timesheet_events (organization_id, timesheet_id, actor_member_id, from_status, to_status, comment) VALUES ($1,$2,$3,$4,$5,$6)`,
    [ts.organization_id, ts.id, actorMemberId ?? null, fromStatus ?? null, toStatus, comment ?? null],
  );
}

/** Get (or create) the member's timesheet for the period containing `date` (member-local). */
export async function getOrCreateTimesheet(orgId, memberId, date) {
  const s = await orgTimesheetSettings(orgId);
  const p = periodFor(date ?? (await memberLocalToday(memberId)), s.timesheet_period, s.week_start);
  let ts = await db.one(
    `INSERT INTO timesheets (organization_id, member_id, period_type, period_start, period_end)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (member_id, period_type, period_start) DO NOTHING RETURNING *`,
    [orgId, memberId, p.type, p.start, p.end],
  );
  if (ts) await writeEvent(ts, null, null, 'draft', 'Timesheet generated');
  else ts = await db.one(`SELECT * FROM timesheets WHERE member_id = $1 AND period_type = $2 AND period_start = $3`, [memberId, p.type, p.start]);
  if (!ts.locked_at && ts.status !== 'approved') ts = await refreshTotals(ts);
  return ts;
}

export const TS_SELECT = `
  SELECT ts.*, u.first_name, u.last_name, m.employee_code
  FROM timesheets ts JOIN organization_members m ON m.id = ts.member_id JOIN users u ON u.id = m.user_id`;

export async function loadTimesheet(orgId, id) {
  const ts = await db.one(`${TS_SELECT} WHERE ts.id = $1 AND ts.organization_id = $2`, [id, orgId]);
  if (!ts) throw notFound('Timesheet');
  return ts;
}

export function timesheetDto(ts, levels) {
  return {
    id: ts.id,
    memberId: ts.member_id,
    member: ts.first_name !== undefined ? { id: ts.member_id, name: `${ts.first_name ?? ''} ${ts.last_name ?? ''}`.trim(), employeeCode: ts.employee_code ?? null } : undefined,
    periodType: ts.period_type,
    periodStart: ts.period_start,
    periodEnd: ts.period_end,
    status: ts.status,
    currentLevel: ts.current_level,
    approvalLevels: levels,
    revision: ts.revision,
    totalSeconds: ts.total_seconds,
    billableSeconds: ts.billable_seconds,
    overtimeSeconds: ts.overtime_seconds,
    totalHours: Math.round((ts.total_seconds / 3600) * 100) / 100,
    submittedAt: ts.submitted_at,
    approvedAt: ts.approved_at,
    locked: !!ts.locked_at || ['submitted', 'approved'].includes(ts.status),
    lockedAt: ts.locked_at,
    lockedBy: ts.locked_by,
    editable: !ts.locked_at && ['draft', 'rejected'].includes(ts.status),
    createdAt: ts.created_at,
    updatedAt: ts.updated_at,
  };
}

const name = (ts) => `${ts.first_name ?? ''} ${ts.last_name ?? ''}`.trim();
const periodLabel = (ts) => `${ts.period_start} – ${ts.period_end}`;

/** Submit (TS-11, TS-14). */
export async function submitTimesheet(ctx, id) {
  const ts = await loadTimesheet(ctx.orgId, id);
  if (ts.member_id !== ctx.memberId) throw forbidden('You can only submit your own timesheet');
  if (ts.locked_at) throw conflict('TIMESHEET_LOCKED', 'Timesheet is locked');
  if (!['draft', 'rejected'].includes(ts.status)) throw conflict('INVALID_STATUS', `Cannot submit a ${ts.status} timesheet`);
  await refreshTotals(ts);
  const fresh = await db.one(
    `UPDATE timesheets SET status = 'submitted', current_level = 1, submitted_at = now(),
       revision = CASE WHEN status = 'rejected' THEN revision + 1 ELSE revision END, updated_at = now()
     WHERE id = $1 AND status IN ('draft','rejected') RETURNING *`,
    [ts.id],
  );
  if (!fresh) throw conflict('INVALID_STATUS', 'Timesheet changed concurrently');
  await writeEvent(ts, ctx.memberId, ts.status, 'submitted', ts.status === 'rejected' ? `Resubmitted (revision ${fresh.revision})` : null);
  await publish('timesheet.submitted', { orgId: ctx.orgId, memberId: ts.member_id, timesheetId: ts.id, revision: fresh.revision });
  const approvers = await usersWithPermission(ctx.orgId, 'timesheets.approve', { memberId: ts.member_id });
  await notify({
    orgId: ctx.orgId,
    userIds: approvers,
    type: 'timesheet.submitted',
    title: 'Timesheet submitted',
    body: `${name(ts)} submitted the timesheet for ${periodLabel(ts)}.`,
    link: `/timesheets/${ts.id}`,
    data: { timesheetId: ts.id, memberId: ts.member_id },
  });
  return loadTimesheet(ctx.orgId, ts.id);
}

async function assertCanDecide(ctx, ts) {
  await assertMemberAccess(ctx, 'timesheets.approve', ts.member_id);
  if (ts.member_id === ctx.memberId && !ctx.isOwner()) throw forbidden('You cannot approve your own timesheet', 'SELF_APPROVAL');
  if (ts.status !== 'submitted') throw conflict('INVALID_STATUS', `Timesheet is ${ts.status}, not submitted`);
}

/** Approve the current level; final level approves + locks and marks entries approved (TS-12, TS-15, TS-16). */
export async function approveTimesheet(ctx, id, comment) {
  const ts = await loadTimesheet(ctx.orgId, id);
  await assertCanDecide(ctx, ts);
  const s = await orgTimesheetSettings(ctx.orgId);
  const levels = Number(s.approval_levels);
  const already = await db.one(
    `SELECT 1 FROM timesheet_approvals WHERE timesheet_id = $1 AND revision = $2 AND approver_member_id = $3 AND decision = 'approved'`,
    [ts.id, ts.revision, ctx.memberId],
  );
  if (already && !ctx.isOwner()) throw conflict('ALREADY_APPROVED', 'You already approved a level of this timesheet; another approver must approve the next level');
  const isFinal = ts.current_level >= levels;
  const tz = await memberTimezone(ts.member_id);
  await db.tx(async () => {
    await db.query(
      `INSERT INTO timesheet_approvals (timesheet_id, level, revision, approver_member_id, decision, comment) VALUES ($1,$2,$3,$4,'approved',$5)`,
      [ts.id, ts.current_level, ts.revision, ctx.memberId, comment ?? null],
    );
    if (isFinal) {
      await db.query(
        `UPDATE timesheets SET status = 'approved', approved_at = now(), locked_at = now(), locked_by = $2, updated_at = now() WHERE id = $1`,
        [ts.id, ctx.memberId],
      );
      await db.query(
        `UPDATE time_entries e SET status = 'approved', approved_by = $2, approved_at = now(), timesheet_id = $1, updated_at = now()
         WHERE e.member_id = $3 AND e.status IN ('completed','pending') AND ${entryInPeriodSql('$4', '$5', '$6')}`,
        [ts.id, ctx.memberId, ts.member_id, tz, ts.period_start, ts.period_end],
      );
      await db.query(
        `UPDATE time_entries e SET timesheet_id = $1 WHERE e.member_id = $2 AND e.timesheet_id IS NULL AND ${entryInPeriodSql('$3', '$4', '$5')}`,
        [ts.id, ts.member_id, tz, ts.period_start, ts.period_end],
      );
      await writeEvent(ts, ctx.memberId, 'submitted', 'approved', comment ?? `Level ${ts.current_level} approved (final)`);
    } else {
      await db.query(`UPDATE timesheets SET current_level = current_level + 1, updated_at = now() WHERE id = $1`, [ts.id]);
      await writeEvent(ts, ctx.memberId, 'submitted', 'submitted', comment ? `Level ${ts.current_level} approved: ${comment}` : `Level ${ts.current_level} approved`);
    }
  });
  if (isFinal) {
    await publish('timesheet.approved', { orgId: ctx.orgId, memberId: ts.member_id, timesheetId: ts.id, approvedBy: ctx.memberId });
    await notify({
      orgId: ctx.orgId,
      memberIds: [ts.member_id],
      type: 'timesheet.approved',
      title: 'Timesheet approved',
      body: `Your timesheet for ${periodLabel(ts)} was approved.${comment ? ` Comment: ${comment}` : ''}`,
      link: `/timesheets/${ts.id}`,
      data: { timesheetId: ts.id },
    });
  } else {
    await publish('timesheet.level_approved', { orgId: ctx.orgId, memberId: ts.member_id, timesheetId: ts.id, level: ts.current_level });
    const approvers = (await usersWithPermission(ctx.orgId, 'timesheets.approve', { memberId: ts.member_id })).filter((u) => u !== ctx.userId);
    await notify({
      orgId: ctx.orgId,
      userIds: approvers,
      type: 'timesheet.submitted',
      title: `Timesheet awaiting level ${ts.current_level + 1} approval`,
      body: `${name(ts)}'s timesheet for ${periodLabel(ts)} passed level ${ts.current_level}.`,
      link: `/timesheets/${ts.id}`,
      data: { timesheetId: ts.id, level: ts.current_level + 1 },
    });
  }
  return loadTimesheet(ctx.orgId, ts.id);
}

/** Reject (TS-13). */
export async function rejectTimesheet(ctx, id, comment) {
  const ts = await loadTimesheet(ctx.orgId, id);
  await assertCanDecide(ctx, ts);
  await db.tx(async () => {
    await db.query(
      `INSERT INTO timesheet_approvals (timesheet_id, level, revision, approver_member_id, decision, comment) VALUES ($1,$2,$3,$4,'rejected',$5)`,
      [ts.id, ts.current_level, ts.revision, ctx.memberId, comment],
    );
    await db.query(`UPDATE timesheets SET status = 'rejected', current_level = 1, updated_at = now() WHERE id = $1`, [ts.id]);
    await writeEvent(ts, ctx.memberId, 'submitted', 'rejected', comment);
  });
  await publish('timesheet.rejected', { orgId: ctx.orgId, memberId: ts.member_id, timesheetId: ts.id, comment });
  await notify({
    orgId: ctx.orgId,
    memberIds: [ts.member_id],
    type: 'timesheet.rejected',
    title: 'Timesheet rejected',
    body: `Your timesheet for ${periodLabel(ts)} was rejected: ${comment}`,
    link: `/timesheets/${ts.id}`,
    data: { timesheetId: ts.id },
  });
  return loadTimesheet(ctx.orgId, ts.id);
}

/** Lock (TS-16). */
export async function lockTimesheet(ts, actorMemberId, comment = 'Locked') {
  const fresh = await db.one(
    `UPDATE timesheets SET locked_at = now(), locked_by = $2, updated_at = now() WHERE id = $1 AND locked_at IS NULL RETURNING *`,
    [ts.id, actorMemberId ?? null],
  );
  if (!fresh) return null;
  await writeEvent(ts, actorMemberId, ts.status, ts.status, comment);
  await publish('timesheet.locked', { orgId: ts.organization_id, memberId: ts.member_id, timesheetId: ts.id });
  return fresh;
}

/** Unlock → draft (TS-16): entries approved through this timesheet go back to completed. */
export async function unlockTimesheet(ctx, ts) {
  await db.tx(async () => {
    await db.query(
      `UPDATE timesheets SET status = 'draft', locked_at = NULL, locked_by = NULL, approved_at = NULL, current_level = 1, updated_at = now() WHERE id = $1`,
      [ts.id],
    );
    await db.query(
      `UPDATE time_entries SET status = 'completed', approved_by = NULL, approved_at = NULL, updated_at = now()
       WHERE timesheet_id = $1 AND status = 'approved' AND invoice_id IS NULL`,
      [ts.id],
    );
    await db.query(`UPDATE time_entries SET timesheet_id = NULL WHERE timesheet_id = $1 AND invoice_id IS NULL`, [ts.id]);
    await writeEvent(ts, ctx.memberId, ts.status, 'draft', 'Unlocked');
  });
  await publish('timesheet.unlocked', { orgId: ctx.orgId, memberId: ts.member_id, timesheetId: ts.id });
}
