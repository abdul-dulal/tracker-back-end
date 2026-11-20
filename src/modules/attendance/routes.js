import { z } from 'zod';
import { createRouter, zBool } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, dateStr, where } from '../../lib/http.js';
import { notFound, badRequest, conflict, forbidden } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { scopeMembers, assertMemberAccess, accessibleMemberIds, getOrgMember } from '../../rbac/scope.js';
import { notify, usersWithPermission } from '../notifications/service.js';
import {
  RECORD_SELECT,
  recordDto,
  checkIn,
  checkOut,
  recalcRecord,
  getRecord,
  trackableMembers,
  syntheticRow,
  localToday,
} from './service.js';
import { resolveSchedule, datesBetween, addDays } from './schedule.js';

const r = createRouter('/attendance', 'Attendance');

const STATUSES = ['present', 'late', 'absent', 'half_day', 'holiday', 'weekend', 'leave'];
const MAX_RANGE_DAYS = 93;
const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');

function resolveRange(q, today) {
  let from = q.from ?? q.date ?? today;
  let to = q.to ?? q.date ?? (q.from ? q.from : today);
  if (q.from && !q.to) to = from;
  if (to < from) throw badRequest('`to` must be on or after `from`');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days > MAX_RANGE_DAYS) throw badRequest(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

const periodKey = (date, groupBy) => {
  if (groupBy === 'month') return date.slice(0, 7);
  if (groupBy === 'week') {
    const d = new Date(`${date}T00:00:00Z`);
    const dow = d.getUTCDay() || 7;
    return addDays(date, 1 - dow); // ISO week (Monday) start
  }
  return date;
};

function counts(rows) {
  const c = { present: 0, late: 0, absent: 0, halfDay: 0, holiday: 0, weekend: 0, leave: 0, lateMinutes: 0, workedSeconds: 0, overtimeSeconds: 0 };
  for (const x of rows) {
    if (x.status === 'present') c.present++;
    else if (x.status === 'late') c.late++;
    else if (x.status === 'absent') c.absent++;
    else if (x.status === 'half_day') c.halfDay++;
    else if (x.status === 'holiday') c.holiday++;
    else if (x.status === 'weekend') c.weekend++;
    else if (x.status === 'leave') c.leave++;
    c.lateMinutes += x.lateMinutes ?? 0;
    c.workedSeconds += x.workedSeconds ?? 0;
    c.overtimeSeconds += x.overtimeSeconds ?? 0;
  }
  return c;
}

// ───────────────────────── Check-in / out ─────────────────────────
r.post(
  '/check-in',
  {
    summary: 'Check in (self)',
    ids: 'ATT-01, ATT-11',
    permission: 'timer.use',
    auth: 'org',
    body: z.object({ workMode: z.enum(['office', 'remote', 'hybrid']).optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const source = ctx.authType === 'agent' ? 'agent' : 'manual';
    const { record, created: isNew } = await checkIn(ctx.orgId, ctx.memberId, { source, workMode: req.body.workMode });
    const full = await getRecord(record.id, ctx.orgId);
    (isNew ? created : ok)(res, recordDto(full));
  },
);

r.post(
  '/check-out',
  { summary: 'Check out (self)', ids: 'ATT-02, ATT-07', permission: 'timer.use', body: z.object({}).optional() },
  async (req, res) => {
    const ctx = req.ctx;
    const out = await checkOut(ctx.orgId, ctx.memberId, { source: 'manual' });
    ok(res, recordDto(await getRecord(out.record.id, ctx.orgId)));
  },
);

// ───────────────────────── Lists ─────────────────────────
const listQuery = z.object({
  date: dateStr.optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  memberId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  status: z.enum([...STATUSES, 'not_checked_in']).optional(),
  includeMissing: zBool.optional(),
  groupBy: z.enum(['day', 'week', 'month']).optional(),
});

r.get(
  '/',
  { summary: 'Attendance records (daily / weekly / monthly)', ids: 'ATT-03, ATT-04, ATT-05, ATT-16, ATT-21', permission: 'attendance.view', query: listQuery },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const today = await localToday(ctx.timezone ?? 'UTC');
    const { from, to } = resolveRange(q, today);
    const w = where([ctx.orgId]);
    w.raw('a.organization_id = $1');
    w.add('a.date >= ?', from);
    w.add('a.date <= ?', to);
    w.add('a.member_id = ?', q.memberId);
    if (q.teamId) w.add('a.member_id IN (SELECT member_id FROM team_members WHERE team_id = ?)', q.teamId);
    const ids = await scopeMembers(ctx, 'attendance.view', w, 'a.member_id');
    const rows = await db.many(`${RECORD_SELECT} ${w.sql} ORDER BY a.date DESC, u.first_name`, w.params);
    let out = rows.map((x) => ({ ...x }));
    if (q.includeMissing) {
      const members = await trackableMembers(ctx.orgId, { memberIds: ids ?? undefined, teamId: q.teamId, memberId: q.memberId });
      const have = new Set(rows.map((x) => `${x.member_id}|${x.date}`));
      for (const m of members) {
        const mToday = await localToday(m.tz);
        for (const d of datesBetween(from, to)) {
          if (d >= mToday || d < m.since || have.has(`${m.id}|${d}`)) continue;
          out.push(await syntheticRow(m, d, mToday));
        }
      }
      out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }
    if (q.status) out = out.filter((x) => x.status === q.status);
    const dtos = out.map(recordDto);
    if (q.groupBy && q.groupBy !== 'day') {
      const groups = new Map();
      for (const d of dtos) {
        const k = periodKey(d.date, q.groupBy);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(d);
      }
      const data = [...groups.entries()].map(([period, records]) => ({ period, ...counts(records), records }));
      return ok(res, data, { from, to, groupBy: q.groupBy, total: dtos.length });
    }
    ok(res, dtos, { from, to, total: dtos.length, summary: counts(dtos) });
  },
);

r.get(
  '/today',
  {
    summary: "Today's attendance summary",
    ids: 'ATT-03',
    permission: 'attendance.view',
    query: z.object({ teamId: z.uuid().optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const ids = await accessibleMemberIds(ctx, 'attendance.view');
    const members = await trackableMembers(ctx.orgId, { memberIds: ids ?? undefined, teamId: req.v.query.teamId });
    const summary = { total: members.length, present: 0, late: 0, absent: 0, notCheckedIn: 0, off: 0, onLeave: 0, checkedOut: 0 };
    const list = [];
    for (const m of members) {
      const today = await localToday(m.tz);
      const rec = await db.one(`${RECORD_SELECT} WHERE a.member_id = $1 AND a.date = $2`, [m.id, today]);
      const row = rec ?? (await syntheticRow(m, today, today));
      const dto = recordDto(row);
      if (dto.status === 'present' || dto.status === 'half_day') summary.present++;
      else if (dto.status === 'late') summary.late++;
      else if (dto.status === 'absent') summary.absent++;
      else if (dto.status === 'not_checked_in') summary.notCheckedIn++;
      else if (dto.status === 'leave') summary.onLeave++;
      else summary.off++;
      if (dto.checkOutAt) summary.checkedOut++;
      list.push(dto);
    }
    ok(res, { summary, members: list });
  },
);

r.get(
  '/calendar',
  {
    summary: 'Monthly attendance calendar of a member',
    ids: 'ATT-05, ATT-15, ATT-16',
    permission: 'attendance.view',
    query: z.object({ memberId: z.uuid().optional(), month: zMonth.optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const memberId = req.v.query.memberId ?? ctx.memberId;
    await getOrgMember(ctx.orgId, memberId);
    await assertMemberAccess(ctx, 'attendance.view', memberId);
    const [m] = await trackableMembers(ctx.orgId, { memberId });
    if (!m) throw notFound('Member');
    const today = await localToday(m.tz);
    const month = req.v.query.month ?? today.slice(0, 7);
    const from = `${month}-01`;
    const [yy, mm] = month.split('-').map(Number);
    const to = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
    const recs = await db.many(`${RECORD_SELECT} WHERE a.member_id = $1 AND a.date BETWEEN $2 AND $3`, [memberId, from, to]);
    const byDate = new Map(recs.map((x) => [x.date, x]));
    const days = [];
    for (const d of datesBetween(from, to)) {
      const rec = byDate.get(d);
      if (rec) {
        days.push(recordDto(rec));
        continue;
      }
      const row = d < m.since && d < today ? { member_id: m.id, date: d, status: 'not_employed', synthetic: true } : await syntheticRow(m, d, today);
      days.push(recordDto(row));
    }
    ok(res, { memberId, month, days, summary: counts(days) });
  },
);

r.get(
  '/history',
  {
    summary: 'Attendance history of a member',
    ids: 'ATT-19',
    permission: 'attendance.view',
    query: z.object({ memberId: z.uuid().optional(), from: dateStr.optional(), to: dateStr.optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const memberId = q.memberId ?? ctx.memberId;
    await getOrgMember(ctx.orgId, memberId);
    await assertMemberAccess(ctx, 'attendance.view', memberId);
    const w = where([ctx.orgId, memberId]);
    w.raw('a.organization_id = $1 AND a.member_id = $2');
    w.add('a.date >= ?', q.from);
    w.add('a.date <= ?', q.to);
    const total = (await db.one(`SELECT count(*)::int AS n FROM attendance_records a ${w.sql}`, w.params)).n;
    const rows = await db.many(`${RECORD_SELECT} ${w.sql} ORDER BY a.date DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, w.params);
    const corrections = await db.many(
      `SELECT * FROM attendance_corrections WHERE organization_id = $1 AND member_id = $2
         AND ($3::date IS NULL OR date >= $3::date) AND ($4::date IS NULL OR date <= $4::date) ORDER BY created_at DESC`,
      [ctx.orgId, memberId, q.from ?? null, q.to ?? null],
    );
    ok(res, { records: rows.map(recordDto), corrections: corrections.map(correctionDto) }, { page: q.page, limit: q.limit, total });
  },
);

r.get(
  '/reports',
  {
    summary: 'Attendance report',
    ids: 'ATT-20, ATT-21',
    permission: 'attendance.view',
    query: z.object({
      from: dateStr,
      to: dateStr,
      groupBy: z.enum(['member', 'team', 'day']).default('member'),
      memberId: z.uuid().optional(),
      teamId: z.uuid().optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    if (q.to < q.from) throw badRequest('`to` must be on or after `from`');
    const w = where([ctx.orgId]);
    w.raw('a.organization_id = $1');
    w.add('a.date >= ?', q.from);
    w.add('a.date <= ?', q.to);
    w.add('a.member_id = ?', q.memberId);
    if (q.teamId) w.add('a.member_id IN (SELECT member_id FROM team_members WHERE team_id = ?)', q.teamId);
    await scopeMembers(ctx, 'attendance.view', w, 'a.member_id');
    const agg = `count(*) FILTER (WHERE a.status IN ('present','late','half_day'))::int AS present,
      count(*) FILTER (WHERE a.status = 'late')::int AS late,
      count(*) FILTER (WHERE a.status = 'absent')::int AS absent,
      count(*) FILTER (WHERE a.status = 'leave')::int AS leave,
      coalesce(sum(a.late_minutes), 0)::int AS late_minutes,
      coalesce(sum(a.early_leave_minutes), 0)::int AS early_leave_minutes,
      coalesce(sum(a.worked_seconds), 0)::int AS worked_seconds,
      coalesce(sum(a.overtime_seconds), 0)::int AS overtime_seconds`;
    let sql;
    if (q.groupBy === 'member')
      sql = `SELECT a.member_id AS key, max(u.first_name || ' ' || coalesce(u.last_name, '')) AS label, ${agg}
             FROM attendance_records a JOIN organization_members m ON m.id = a.member_id JOIN users u ON u.id = m.user_id
             ${w.sql} GROUP BY a.member_id ORDER BY label`;
    else if (q.groupBy === 'team')
      sql = `SELECT t.id AS key, t.name AS label, ${agg}
             FROM attendance_records a JOIN team_members tm ON tm.member_id = a.member_id JOIN teams t ON t.id = tm.team_id AND t.deleted_at IS NULL
             ${w.sql} GROUP BY t.id, t.name ORDER BY t.name`;
    else
      sql = `SELECT to_char(a.date, 'YYYY-MM-DD') AS key, to_char(a.date, 'YYYY-MM-DD') AS label, ${agg}
             FROM attendance_records a ${w.sql} GROUP BY a.date ORDER BY a.date`;
    const rows = await db.many(sql, w.params);
    const toRow = (x) => ({
      key: x.key,
      label: x.label?.trim(),
      present: x.present,
      late: x.late,
      absent: x.absent,
      leave: x.leave,
      lateMinutes: x.late_minutes,
      earlyLeaveMinutes: x.early_leave_minutes,
      workedHours: Math.round((x.worked_seconds / 3600) * 100) / 100,
      overtimeHours: Math.round((x.overtime_seconds / 3600) * 100) / 100,
    });
    const data = rows.map(toRow);
    const totals = data.reduce(
      (t, x) => ({
        present: t.present + x.present,
        late: t.late + x.late,
        absent: t.absent + x.absent,
        lateMinutes: t.lateMinutes + x.lateMinutes,
        workedHours: Math.round((t.workedHours + x.workedHours) * 100) / 100,
        overtimeHours: Math.round((t.overtimeHours + x.overtimeHours) * 100) / 100,
      }),
      { present: 0, late: 0, absent: 0, lateMinutes: 0, workedHours: 0, overtimeHours: 0 },
    );
    ok(res, { groupBy: q.groupBy, from: q.from, to: q.to, rows: data, totals });
  },
);

// ───────────────────────── Corrections ─────────────────────────
function correctionDto(c) {
  return {
    id: c.id,
    memberId: c.member_id,
    member: c.first_name !== undefined ? { id: c.member_id, name: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() } : undefined,
    attendanceRecordId: c.attendance_record_id,
    date: c.date,
    requestedCheckIn: c.requested_check_in,
    requestedCheckOut: c.requested_check_out,
    reason: c.reason,
    status: c.status,
    reviewedBy: c.reviewed_by,
    reviewedAt: c.reviewed_at,
    reviewNote: c.review_note,
    createdAt: c.created_at,
  };
}

const CORR_SELECT = `SELECT c.*, u.first_name, u.last_name FROM attendance_corrections c
  JOIN organization_members m ON m.id = c.member_id JOIN users u ON u.id = m.user_id`;

r.get(
  '/corrections',
  {
    summary: 'List attendance correction requests',
    ids: 'ATT-17, ATT-18',
    permission: ['attendance.approve', 'attendance.view', 'timer.use'],
    query: z.object({
      status: z.enum(['pending', 'approved', 'rejected']).optional(),
      memberId: z.uuid().optional(),
      mine: zBool.optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const w = where([ctx.orgId]);
    w.raw('c.organization_id = $1');
    w.add('c.status = ?', q.status);
    w.add('c.member_id = ?', q.memberId);
    if (q.mine || !ctx.can('attendance.approve')) w.add('c.member_id = ?', ctx.memberId);
    else {
      const ids = await accessibleMemberIds(ctx, 'attendance.approve');
      if (ids) w.add('c.member_id = ANY(?::uuid[])', [...new Set([...ids, ctx.memberId])]);
    }
    const total = (await db.one(`SELECT count(*)::int AS n FROM attendance_corrections c ${w.sql}`, w.params)).n;
    const rows = await db.many(`${CORR_SELECT} ${w.sql} ORDER BY c.created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, w.params);
    ok(res, rows.map(correctionDto), { page: q.page, limit: q.limit, total });
  },
);

r.post(
  '/corrections',
  {
    summary: 'Request an attendance correction',
    ids: 'ATT-17',
    permission: ['timer.use', 'attendance.view'],
    body: z
      .object({
        date: dateStr,
        requestedCheckIn: z.iso.datetime({ offset: true }).optional(),
        requestedCheckOut: z.iso.datetime({ offset: true }).optional(),
        reason: z.string().trim().min(3).max(2000),
      })
      .refine((b) => b.requestedCheckIn || b.requestedCheckOut, { message: 'requestedCheckIn or requestedCheckOut is required', path: ['requestedCheckIn'] })
      .refine((b) => !(b.requestedCheckIn && b.requestedCheckOut) || new Date(b.requestedCheckOut) > new Date(b.requestedCheckIn), {
        message: 'requestedCheckOut must be after requestedCheckIn',
        path: ['requestedCheckOut'],
      }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    const today = await localToday(ctx.timezone ?? 'UTC');
    if (b.date > today) throw badRequest('Corrections cannot be requested for future dates');
    const dup = await db.one(`SELECT 1 FROM attendance_corrections WHERE member_id = $1 AND date = $2 AND status = 'pending'`, [ctx.memberId, b.date]);
    if (dup) throw conflict('CORRECTION_PENDING', 'A correction request for this date is already pending');
    const rec = await db.one('SELECT id FROM attendance_records WHERE member_id = $1 AND date = $2', [ctx.memberId, b.date]);
    const c = await db.one(
      `INSERT INTO attendance_corrections (organization_id, attendance_record_id, member_id, date, requested_check_in, requested_check_out, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ctx.orgId, rec?.id ?? null, ctx.memberId, b.date, b.requestedCheckIn ?? null, b.requestedCheckOut ?? null, b.reason],
    );
    const approvers = await usersWithPermission(ctx.orgId, 'attendance.approve', { memberId: ctx.memberId });
    await notify({
      orgId: ctx.orgId,
      userIds: approvers,
      type: 'approval.requested',
      title: 'Attendance correction requested',
      body: `${ctx.user?.firstName ?? 'A member'} requested an attendance correction for ${b.date}.`,
      link: '/attendance/corrections',
      data: { kind: 'attendance_correction', correctionId: c.id, memberId: ctx.memberId, date: b.date },
    });
    created(res, correctionDto(c));
  },
);

async function loadPendingCorrection(ctx, id) {
  const c = await db.one('SELECT * FROM attendance_corrections WHERE id = $1 AND organization_id = $2', [id, ctx.orgId]);
  if (!c) throw notFound('Correction request');
  await assertMemberAccess(ctx, 'attendance.approve', c.member_id);
  if (c.member_id === ctx.memberId && !ctx.isOwner()) throw forbidden('You cannot review your own correction request', 'SELF_APPROVAL');
  if (c.status !== 'pending') throw conflict('ALREADY_REVIEWED', `Correction request is already ${c.status}`);
  return c;
}

const decisionBody = z.object({ note: z.string().trim().max(2000).optional() }).optional();

r.post(
  '/corrections/:id/approve',
  { summary: 'Approve an attendance correction', ids: 'ATT-18', permission: 'attendance.approve', params: z.object({ id: z.uuid() }), body: decisionBody },
  async (req, res) => {
    const ctx = req.ctx;
    const c = await loadPendingCorrection(ctx, req.v.params.id);
    const note = req.body?.note ?? null;
    const rec = await db.tx(async () => {
      const existing = await db.one('SELECT * FROM attendance_records WHERE member_id = $1 AND date = $2', [c.member_id, c.date]);
      let recId;
      if (existing) {
        const inAt = c.requested_check_in ?? existing.check_in_at;
        const outAt = c.requested_check_out ?? existing.check_out_at;
        await db.query(
          `UPDATE attendance_records SET check_in_at = $2, check_out_at = $3, check_in_source = 'correction',
             status = CASE WHEN $2::timestamptz IS NOT NULL AND status IN ('absent','weekend','holiday') THEN 'present' ELSE status END,
             updated_at = now() WHERE id = $1`,
          [existing.id, inAt, outAt],
        );
        recId = existing.id;
      } else {
        const sched = await resolveSchedule(c.member_id, c.date);
        const row = await db.one(
          `INSERT INTO attendance_records (organization_id, member_id, date, status, check_in_at, check_out_at, check_in_source, work_mode, shift_id)
           VALUES ($1,$2,$3,'present',$4,$5,'correction',$6,$7) RETURNING id`,
          [ctx.orgId, c.member_id, c.date, c.requested_check_in ?? c.requested_check_out, c.requested_check_out, sched.workMode, sched.shiftId],
        );
        recId = row.id;
      }
      await db.query(
        `UPDATE attendance_corrections SET status = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = $3, attendance_record_id = $4 WHERE id = $1`,
        [c.id, ctx.memberId, note, recId],
      );
      return recalcRecord(recId);
    });
    await audit(ctx, 'attendance.correction_approved', { entityType: 'attendance_correction', entityId: c.id, after: { recordId: rec.id, status: rec.status } });
    await notify({
      orgId: ctx.orgId,
      memberIds: [c.member_id],
      type: 'approval.resolved',
      title: 'Attendance correction approved',
      body: `Your attendance correction for ${c.date} was approved.${note ? ` Note: ${note}` : ''}`,
      link: '/attendance',
      data: { kind: 'attendance_correction', correctionId: c.id, decision: 'approved' },
    });
    const fresh = await db.one(`${CORR_SELECT} WHERE c.id = $1`, [c.id]);
    ok(res, { correction: correctionDto(fresh), record: recordDto(await getRecord(rec.id, ctx.orgId)) });
  },
);

r.post(
  '/corrections/:id/reject',
  { summary: 'Reject an attendance correction', ids: 'ATT-18', permission: 'attendance.approve', params: z.object({ id: z.uuid() }), body: decisionBody },
  async (req, res) => {
    const ctx = req.ctx;
    const c = await loadPendingCorrection(ctx, req.v.params.id);
    const note = req.body?.note ?? null;
    await db.query(`UPDATE attendance_corrections SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`, [c.id, ctx.memberId, note]);
    await audit(ctx, 'attendance.correction_rejected', { entityType: 'attendance_correction', entityId: c.id, after: { note } });
    await notify({
      orgId: ctx.orgId,
      memberIds: [c.member_id],
      type: 'approval.resolved',
      title: 'Attendance correction rejected',
      body: `Your attendance correction for ${c.date} was rejected.${note ? ` Note: ${note}` : ''}`,
      link: '/attendance',
      data: { kind: 'attendance_correction', correctionId: c.id, decision: 'rejected' },
    });
    ok(res, correctionDto(await db.one(`${CORR_SELECT} WHERE c.id = $1`, [c.id])));
  },
);

// ───────────────────────── Admin edit ─────────────────────────
r.patch(
  '/:id',
  {
    summary: 'Edit an attendance record',
    ids: 'ATT-06, ATT-07, ATT-21',
    permission: 'attendance.manage',
    params: z.object({ id: z.uuid() }),
    body: z
      .object({
        checkInAt: z.iso.datetime({ offset: true }).nullable().optional(),
        checkOutAt: z.iso.datetime({ offset: true }).nullable().optional(),
        status: z.enum(STATUSES).optional(),
        workMode: z.enum(['office', 'remote', 'hybrid']).optional(),
        note: z.string().trim().max(2000).nullable().optional(),
      })
      .refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    const before = await db.one('SELECT * FROM attendance_records WHERE id = $1 AND organization_id = $2', [req.v.params.id, ctx.orgId]);
    if (!before) throw notFound('Attendance record');
    await assertMemberAccess(ctx, 'attendance.manage', before.member_id);
    const inAt = b.checkInAt === undefined ? before.check_in_at : b.checkInAt;
    const outAt = b.checkOutAt === undefined ? before.check_out_at : b.checkOutAt;
    if (inAt && outAt && new Date(outAt) <= new Date(inAt)) throw badRequest('checkOutAt must be after checkInAt');
    await db.query(
      `UPDATE attendance_records SET check_in_at = $2, check_out_at = $3, status = coalesce($4, status), work_mode = coalesce($5, work_mode),
         note = CASE WHEN $6 THEN $7 ELSE note END,
         check_in_source = CASE WHEN $8 THEN coalesce(check_in_source, 'manual') ELSE check_in_source END, updated_at = now()
       WHERE id = $1`,
      [before.id, inAt, outAt, b.status ?? null, b.workMode ?? null, b.note !== undefined, b.note ?? null, b.checkInAt !== undefined],
    );
    if (b.checkInAt !== undefined || b.checkOutAt !== undefined) {
      // Times changed: re-derive late/early/overtime; an explicit status wins.
      if (!b.status && inAt && before.status === 'absent') await db.query(`UPDATE attendance_records SET status = 'present' WHERE id = $1`, [before.id]);
      await recalcRecord(before.id, { keepStatus: !!b.status });
    }
    const after = await db.one('SELECT * FROM attendance_records WHERE id = $1', [before.id]);
    await audit(ctx, 'attendance.updated', { entityType: 'attendance_record', entityId: before.id, before: recordDto(before), after: recordDto(after) });
    ok(res, recordDto(await getRecord(before.id, ctx.orgId)));
  },
);

export default r;
