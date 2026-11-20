import { z } from 'zod';
import { createRouter, zTime, zTimezone, zColor, zCsvUuids, zBool } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { accessibleMemberIds } from '../../rbac/scope.js';
import { assertOrgMembers, assertOrgRows, realDate } from '../teams/service.js';

/** M12 schedules: work schedules, shifts, shift assignments, holidays (ATT-09…ATT-16). */
const schedules = createRouter('/work-schedules', 'Schedules');
const shifts = createRouter('/shifts', 'Schedules');
const assignments = createRouter('/shift-assignments', 'Schedules');
const holidays = createRouter('/holidays', 'Schedules');

const weekdays = z.array(z.number().int().min(0).max(6)).max(7).transform((a) => [...new Set(a)].sort());
const toMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const hhmm = (t) => (t ? t.slice(0, 5) : null);
const idParam = z.object({ id: z.uuid() });

// ─── Work schedules (ATT-09…ATT-12, ATT-16, EMP-14, TEAM-11) ───────────────
const scheduleDto = (s) => ({
  id: s.id,
  name: s.name,
  scheduleType: s.schedule_type,
  workingDays: s.working_days,
  startTime: hhmm(s.start_time),
  endTime: hhmm(s.end_time),
  requiredHoursPerDay: Number(s.required_hours_per_day),
  workMode: s.work_mode,
  timezone: s.timezone,
  isDefault: s.is_default,
  memberCount: s.member_count ?? 0,
  teamCount: s.team_count ?? 0,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

const SCHED_SELECT = `
  SELECT ws.*,
    (SELECT count(*)::int FROM organization_members m WHERE m.work_schedule_id = ws.id AND m.deleted_at IS NULL) AS member_count,
    (SELECT count(*)::int FROM teams t WHERE t.work_schedule_id = ws.id AND t.deleted_at IS NULL) AS team_count
  FROM work_schedules ws`;

async function loadSchedule(orgId, id) {
  const s = await db.one(`${SCHED_SELECT} WHERE ws.id = $1 AND ws.organization_id = $2`, [id, orgId]);
  if (!s) throw notFound('Work schedule');
  return s;
}

const scheduleBody = z.object({
  name: z.string().trim().min(1).max(120),
  scheduleType: z.enum(['fixed', 'flexible']).default('fixed'),
  workingDays: weekdays.default([1, 2, 3, 4, 5]),
  startTime: zTime.nullable().optional(),
  endTime: zTime.nullable().optional(),
  requiredHoursPerDay: z.number().min(0).max(24).default(8),
  workMode: z.enum(['office', 'remote', 'hybrid']).default('office'),
  timezone: zTimezone.nullable().optional(),
  isDefault: z.boolean().default(false),
});

function checkScheduleTimes(s) {
  if (s.scheduleType === 'fixed') {
    if (!s.startTime || !s.endTime) throw badRequest('Fixed schedules need startTime and endTime', [{ path: 'body.startTime', message: 'Required for fixed schedules' }], 'VALIDATION_ERROR');
    if (toMin(s.endTime) <= toMin(s.startTime)) throw badRequest('endTime must be after startTime', [{ path: 'body.endTime', message: 'Must be after startTime' }], 'VALIDATION_ERROR');
  }
}

schedules.get('/', { summary: 'List work schedules', ids: 'ATT-09, ATT-10, ATT-12', permission: ['attendance.view', 'schedules.manage'] }, async (req, res) => {
  const rows = await db.many(`${SCHED_SELECT} WHERE ws.organization_id = $1 ORDER BY ws.is_default DESC, lower(ws.name)`, [req.ctx.orgId]);
  ok(res, rows.map(scheduleDto));
});

schedules.get('/:id', { summary: 'Work schedule detail', ids: 'ATT-09', permission: ['attendance.view', 'schedules.manage'], params: idParam }, async (req, res) => {
  ok(res, scheduleDto(await loadSchedule(req.ctx.orgId, req.v.params.id)));
});

schedules.post('/', { summary: 'Create work schedule (fixed / flexible, remote)', ids: 'ATT-09, ATT-10, ATT-11, ATT-12, ATT-16', permission: 'schedules.manage', body: scheduleBody }, async (req, res) => {
  const b = req.body;
  checkScheduleTimes(b);
  const flexible = b.scheduleType === 'flexible';
  const s = await db.tx(async () => {
    if (b.isDefault) await db.query('UPDATE work_schedules SET is_default = false, updated_at = now() WHERE organization_id = $1 AND is_default', [req.ctx.orgId]);
    return db.one(
      `INSERT INTO work_schedules (organization_id, name, schedule_type, working_days, start_time, end_time, required_hours_per_day, work_mode, timezone, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.ctx.orgId, b.name, b.scheduleType, b.workingDays, flexible ? (b.startTime ?? null) : b.startTime, flexible ? (b.endTime ?? null) : b.endTime, b.requiredHoursPerDay, b.workMode, b.timezone ?? null, b.isDefault],
    );
  });
  await audit(req.ctx, 'work_schedule.created', { entityType: 'work_schedule', entityId: s.id, after: b });
  created(res, scheduleDto(await loadSchedule(req.ctx.orgId, s.id)));
});

schedules.patch(
  '/:id',
  {
    summary: 'Update work schedule',
    ids: 'ATT-09…ATT-12',
    permission: 'schedules.manage',
    params: idParam,
    body: z.object({
      name: z.string().trim().min(1).max(120),
      scheduleType: z.enum(['fixed', 'flexible']),
      workingDays: weekdays,
      startTime: zTime.nullable(),
      endTime: zTime.nullable(),
      requiredHoursPerDay: z.number().min(0).max(24),
      workMode: z.enum(['office', 'remote', 'hybrid']),
      timezone: zTimezone.nullable(),
      isDefault: z.literal(true),
    }).partial(),
  },
  async (req, res) => {
    const before = await loadSchedule(req.ctx.orgId, req.v.params.id);
    const b = req.body;
    const merged = {
      scheduleType: b.scheduleType ?? before.schedule_type,
      startTime: b.startTime !== undefined ? b.startTime : hhmm(before.start_time),
      endTime: b.endTime !== undefined ? b.endTime : hhmm(before.end_time),
    };
    checkScheduleTimes(merged);
    const map = { name: 'name', scheduleType: 'schedule_type', workingDays: 'working_days', startTime: 'start_time', endTime: 'end_time', requiredHoursPerDay: 'required_hours_per_day', workMode: 'work_mode', timezone: 'timezone', isDefault: 'is_default' };
    const sets = [];
    const params = [before.id];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      params.push(b[k]);
      sets.push(`${col} = $${params.length}`);
    }
    await db.tx(async () => {
      if (b.isDefault) await db.query('UPDATE work_schedules SET is_default = false WHERE organization_id = $1 AND is_default AND id <> $2', [req.ctx.orgId, before.id]);
      if (sets.length) await db.query(`UPDATE work_schedules SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    });
    await audit(req.ctx, 'work_schedule.updated', { entityType: 'work_schedule', entityId: before.id, before: scheduleDto(before), after: b });
    ok(res, scheduleDto(await loadSchedule(req.ctx.orgId, before.id)));
  },
);

schedules.delete('/:id', { summary: 'Delete work schedule (not the default)', ids: 'ATT-09', permission: 'schedules.manage', params: idParam }, async (req, res) => {
  const s = await loadSchedule(req.ctx.orgId, req.v.params.id);
  if (s.is_default) throw conflict('DEFAULT_SCHEDULE', 'The default schedule cannot be deleted. Make another schedule the default first.');
  await db.query('DELETE FROM work_schedules WHERE id = $1', [s.id]); // members/teams fall back (ON DELETE SET NULL → default)
  await audit(req.ctx, 'work_schedule.deleted', { entityType: 'work_schedule', entityId: s.id, before: scheduleDto(s) });
  noContent(res);
});

// ─── Shifts (ATT-13) ────────────────────────────────────────────────────────
const shiftDto = (s) => ({
  id: s.id,
  name: s.name,
  startTime: hhmm(s.start_time),
  endTime: hhmm(s.end_time),
  crossesMidnight: s.crosses_midnight,
  breakMinutes: s.break_minutes,
  color: s.color,
  durationMinutes: (() => {
    let m = toMin(hhmm(s.end_time)) - toMin(hhmm(s.start_time));
    if (m <= 0) m += 1440;
    return m - s.break_minutes;
  })(),
  assignmentCount: s.assignment_count ?? 0,
  createdAt: s.created_at,
});

const SHIFT_SELECT = `SELECT s.*, (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND (a.end_date IS NULL OR a.end_date >= current_date)) AS assignment_count FROM shifts s`;

async function loadShift(orgId, id) {
  const s = await db.one(`${SHIFT_SELECT} WHERE s.id = $1 AND s.organization_id = $2`, [id, orgId]);
  if (!s) throw notFound('Shift');
  return s;
}

const shiftBody = z.object({
  name: z.string().trim().min(1).max(80),
  startTime: zTime,
  endTime: zTime,
  breakMinutes: z.number().int().min(0).max(600).default(0),
  color: zColor.nullable().optional(),
});

function shiftSpan(startTime, endTime, breakMinutes) {
  if (startTime.slice(0, 5) === endTime.slice(0, 5)) throw badRequest('Shift start and end cannot be equal', [{ path: 'body.endTime', message: 'Equal to startTime' }], 'VALIDATION_ERROR');
  const crosses = toMin(endTime) < toMin(startTime);
  let len = toMin(endTime) - toMin(startTime);
  if (len <= 0) len += 1440;
  if (breakMinutes >= len) throw badRequest('Break is longer than the shift', [{ path: 'body.breakMinutes', message: 'Too long' }], 'VALIDATION_ERROR');
  return crosses;
}

shifts.get('/', { summary: 'List shifts', ids: 'ATT-13', permission: ['attendance.view', 'schedules.manage'] }, async (req, res) => {
  const rows = await db.many(`${SHIFT_SELECT} WHERE s.organization_id = $1 ORDER BY s.start_time, lower(s.name)`, [req.ctx.orgId]);
  ok(res, rows.map(shiftDto));
});

shifts.get('/:id', { summary: 'Shift detail', ids: 'ATT-13', permission: ['attendance.view', 'schedules.manage'], params: idParam }, async (req, res) => {
  ok(res, shiftDto(await loadShift(req.ctx.orgId, req.v.params.id)));
});

shifts.post('/', { summary: 'Create shift', ids: 'ATT-13', permission: 'schedules.manage', body: shiftBody }, async (req, res) => {
  const b = req.body;
  const crosses = shiftSpan(b.startTime, b.endTime, b.breakMinutes);
  const s = await db.one(
    `INSERT INTO shifts (organization_id, name, start_time, end_time, crosses_midnight, break_minutes, color) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [req.ctx.orgId, b.name, b.startTime, b.endTime, crosses, b.breakMinutes, b.color ?? null],
  );
  await audit(req.ctx, 'shift.created', { entityType: 'shift', entityId: s.id, after: b });
  created(res, shiftDto(await loadShift(req.ctx.orgId, s.id)));
});

shifts.patch('/:id', { summary: 'Update shift', ids: 'ATT-13', permission: 'schedules.manage', params: idParam, body: shiftBody.partial() }, async (req, res) => {
  const before = await loadShift(req.ctx.orgId, req.v.params.id);
  const b = req.body;
  const start = b.startTime ?? hhmm(before.start_time);
  const end = b.endTime ?? hhmm(before.end_time);
  const crosses = shiftSpan(start, end, b.breakMinutes ?? before.break_minutes);
  await db.query(
    `UPDATE shifts SET name = coalesce($2, name), start_time = $3, end_time = $4, crosses_midnight = $5, break_minutes = coalesce($6, break_minutes),
       color = CASE WHEN $7::boolean THEN $8 ELSE color END WHERE id = $1`,
    [before.id, b.name ?? null, start, end, crosses, b.breakMinutes ?? null, b.color !== undefined, b.color ?? null],
  );
  await audit(req.ctx, 'shift.updated', { entityType: 'shift', entityId: before.id, before: shiftDto(before), after: b });
  ok(res, shiftDto(await loadShift(req.ctx.orgId, before.id)));
});

shifts.delete('/:id', { summary: 'Delete shift (and its assignments)', ids: 'ATT-13', permission: 'schedules.manage', params: idParam }, async (req, res) => {
  const s = await loadShift(req.ctx.orgId, req.v.params.id);
  await db.query('DELETE FROM shifts WHERE id = $1', [s.id]);
  await audit(req.ctx, 'shift.deleted', { entityType: 'shift', entityId: s.id, before: shiftDto(s) });
  noContent(res);
});

// ─── Shift assignments (ATT-14) ─────────────────────────────────────────────
const assignmentDto = (a) => ({
  id: a.id,
  member: { id: a.member_id, name: a.member_name },
  shift: { id: a.shift_id, name: a.shift_name, startTime: hhmm(a.start_time), endTime: hhmm(a.end_time), color: a.color },
  startDate: a.start_date,
  endDate: a.end_date,
  weekdays: a.weekdays,
  createdAt: a.created_at,
});

assignments.get(
  '/',
  {
    summary: 'List shift assignments',
    ids: 'ATT-14',
    permission: ['attendance.view', 'schedules.manage'],
    query: paginationQuery.extend({ memberId: z.uuid().optional(), memberIds: zCsvUuids.optional(), shiftId: z.uuid().optional(), teamId: z.uuid().optional(), from: realDate.optional(), to: realDate.optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    const ctx = req.ctx;
    const w = where([ctx.orgId]).raw('a.organization_id = $1');
    const perm = ctx.can('schedules.manage') === 'org' ? null : 'attendance.view';
    if (perm) {
      const ids = await accessibleMemberIds(ctx, perm);
      if (ids) w.add('a.member_id = ANY(?::uuid[])', ids);
    }
    w.add('a.member_id = ?', q.memberId);
    if (q.memberIds?.length) w.add('a.member_id = ANY(?::uuid[])', q.memberIds);
    w.add('a.shift_id = ?', q.shiftId);
    if (q.teamId) w.add('a.member_id IN (SELECT member_id FROM team_members WHERE team_id = ?)', q.teamId);
    if (q.to) w.add('a.start_date <= ?::date', q.to);
    if (q.from) w.add('(a.end_date IS NULL OR a.end_date >= ?::date)', q.from);
    const base = `FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN organization_members m ON m.id = a.member_id JOIN users u ON u.id = m.user_id ${w.sql}`;
    const total = (await db.one(`SELECT count(*)::int AS n ${base}`, w.params)).n;
    const rows = await db.many(
      `SELECT a.*, to_char(a.start_date,'YYYY-MM-DD') AS start_date, to_char(a.end_date,'YYYY-MM-DD') AS end_date,
              s.name AS shift_name, s.start_time, s.end_time, s.color, trim(u.first_name || ' ' || u.last_name) AS member_name
       ${base} ORDER BY a.start_date DESC, member_name LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      w.params,
    );
    ok(res, rows.map(assignmentDto), pageMeta(q, total));
  },
);

assignments.post(
  '/',
  {
    summary: 'Assign members to a shift (date range + weekdays)',
    ids: 'ATT-14',
    permission: 'schedules.manage',
    body: z.object({
      memberIds: z.array(z.uuid()).min(1).max(500),
      shiftId: z.uuid(),
      startDate: realDate,
      endDate: realDate.nullable().optional(),
      weekdays: weekdays.default([1, 2, 3, 4, 5]),
      replaceOverlapping: z.boolean().default(false),
    }),
  },
  async (req, res) => {
    const b = req.body;
    if (b.endDate && b.endDate < b.startDate) throw badRequest('endDate must be on or after startDate', [{ path: 'body.endDate', message: 'Before startDate' }], 'VALIDATION_ERROR');
    if (!b.weekdays.length) throw badRequest('Select at least one weekday', [{ path: 'body.weekdays', message: 'Empty' }], 'VALIDATION_ERROR');
    await loadShift(req.ctx.orgId, b.shiftId);
    const ids = await assertOrgMembers(req.ctx.orgId, b.memberIds);
    const rows = await db.tx(async () => {
      const out = [];
      for (const memberId of ids) {
        if (b.replaceOverlapping)
          await db.query(
            `DELETE FROM shift_assignments WHERE member_id = $1 AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]') AND weekdays && $4::smallint[]`,
            [memberId, b.startDate, b.endDate ?? null, b.weekdays],
          );
        out.push(
          await db.one(
            `INSERT INTO shift_assignments (organization_id, member_id, shift_id, start_date, end_date, weekdays) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [req.ctx.orgId, memberId, b.shiftId, b.startDate, b.endDate ?? null, b.weekdays],
          ),
        );
      }
      return out;
    });
    await audit(req.ctx, 'shift_assignment.created', { entityType: 'shift', entityId: b.shiftId, after: { memberIds: ids, startDate: b.startDate, endDate: b.endDate ?? null, weekdays: b.weekdays } });
    const full = await db.many(
      `SELECT a.*, to_char(a.start_date,'YYYY-MM-DD') AS start_date, to_char(a.end_date,'YYYY-MM-DD') AS end_date,
              s.name AS shift_name, s.start_time, s.end_time, s.color, trim(u.first_name || ' ' || u.last_name) AS member_name
       FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN organization_members m ON m.id = a.member_id JOIN users u ON u.id = m.user_id
       WHERE a.id = ANY($1::uuid[])`,
      [rows.map((x) => x.id)],
    );
    created(res, full.map(assignmentDto));
  },
);

assignments.delete('/:id', { summary: 'Remove a shift assignment', ids: 'ATT-14', permission: 'schedules.manage', params: idParam }, async (req, res) => {
  const a = await db.one('DELETE FROM shift_assignments WHERE id = $1 AND organization_id = $2 RETURNING *', [req.v.params.id, req.ctx.orgId]);
  if (!a) throw notFound('Shift assignment');
  await audit(req.ctx, 'shift_assignment.deleted', { entityType: 'shift', entityId: a.shift_id, before: { memberId: a.member_id, startDate: a.start_date } });
  noContent(res);
});

// ─── Holidays (ATT-15) ──────────────────────────────────────────────────────
const holidayDto = (h) => ({
  id: h.id,
  name: h.name,
  date: h.date,
  recurringYearly: h.recurring_yearly,
  appliesTo: h.applies_to,
  scopeId: h.scope_id,
  scopeName: h.scope_name ?? null,
  isPaid: h.is_paid,
  createdAt: h.created_at,
});

const HOLIDAY_SELECT = `
  SELECT h.*, to_char(h.date,'YYYY-MM-DD') AS date,
    CASE h.applies_to WHEN 'team' THEN (SELECT name FROM teams WHERE id = h.scope_id)
                      WHEN 'department' THEN (SELECT name FROM departments WHERE id = h.scope_id) END AS scope_name
  FROM holidays h`;

async function loadHoliday(orgId, id) {
  const h = await db.one(`${HOLIDAY_SELECT} WHERE h.id = $1 AND h.organization_id = $2`, [id, orgId]);
  if (!h) throw notFound('Holiday');
  return h;
}

async function checkHolidayScope(orgId, appliesTo, scopeId) {
  if (appliesTo === 'org') {
    if (scopeId) throw badRequest('scopeId must be empty for organization-wide holidays', [{ path: 'body.scopeId', message: 'Must be null' }], 'VALIDATION_ERROR');
    return;
  }
  if (!scopeId) throw badRequest(`scopeId is required for ${appliesTo} holidays`, [{ path: 'body.scopeId', message: 'Required' }], 'VALIDATION_ERROR');
  await assertOrgRows(appliesTo === 'team' ? 'teams' : 'departments', orgId, [scopeId], 'scopeId');
}

holidays.get(
  '/',
  {
    summary: 'List holidays',
    ids: 'ATT-15',
    permission: ['attendance.view', 'holidays.manage'],
    query: z.object({ from: realDate.optional(), to: realDate.optional(), year: z.coerce.number().int().min(1970).max(2100).optional(), appliesTo: z.enum(['org', 'team', 'department']).optional(), scopeId: z.uuid().optional(), includeRecurring: zBool.default(true) }),
  },
  async (req, res) => {
    const q = req.v.query;
    const w = where([req.ctx.orgId]).raw('h.organization_id = $1');
    w.add('h.applies_to = ?', q.appliesTo);
    w.add('h.scope_id = ?', q.scopeId);
    const from = q.from ?? (q.year ? `${q.year}-01-01` : undefined);
    const to = q.to ?? (q.year ? `${q.year}-12-31` : undefined);
    if (from && to && from > to) throw badRequest('`from` must be on or before `to`', [{ path: 'query.from', message: 'from > to' }], 'VALIDATION_ERROR');
    // Recurring holidays are pre-filtered loosely in SQL (started before the window ends) and resolved below.
    const recurring = q.includeRecurring ? 'h.recurring_yearly' : 'false';
    if (from) w.add(`(h.date >= ?::date OR ${recurring})`, from);
    if (to) w.add('h.date <= ?::date', to);
    const rows = await db.many(`${HOLIDAY_SELECT} ${w.sql} ORDER BY h.date, h.name`, w.params);
    const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const data = [];
    for (const h of rows) {
      const dto = holidayDto(h);
      dto.occursOn = h.date;
      if (h.recurring_yearly && from && h.date < from) {
        const md = h.date.slice(5);
        const lastYear = Number((to ?? `${Number(from.slice(0, 4)) + 1}-12-31`).slice(0, 4));
        dto.occursOn = null;
        for (let y = Number(from.slice(0, 4)); y <= lastYear; y++) {
          const occ = md === '02-29' && !isLeap(y) ? `${y}-02-28` : `${y}-${md}`;
          if (occ >= from && (!to || occ <= to)) {
            dto.occursOn = occ;
            break;
          }
        }
        if (!dto.occursOn) continue;
      }
      data.push(dto);
    }
    data.sort((a, b) => (a.occursOn < b.occursOn ? -1 : a.occursOn > b.occursOn ? 1 : 0));
    ok(res, data);
  },
);

holidays.get('/:id', { summary: 'Holiday detail', ids: 'ATT-15', permission: ['attendance.view', 'holidays.manage'], params: idParam }, async (req, res) => {
  ok(res, holidayDto(await loadHoliday(req.ctx.orgId, req.v.params.id)));
});

const holidayBody = z.object({
  name: z.string().trim().min(1).max(120),
  date: realDate,
  recurringYearly: z.boolean().default(false),
  appliesTo: z.enum(['org', 'team', 'department']).default('org'),
  scopeId: z.uuid().nullable().optional(),
  isPaid: z.boolean().default(true),
});

holidays.post('/', { summary: 'Create holiday', ids: 'ATT-15', permission: 'holidays.manage', body: holidayBody }, async (req, res) => {
  const b = req.body;
  await checkHolidayScope(req.ctx.orgId, b.appliesTo, b.scopeId ?? null);
  const h = await db.one(
    `INSERT INTO holidays (organization_id, name, date, recurring_yearly, applies_to, scope_id, is_paid) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [req.ctx.orgId, b.name, b.date, b.recurringYearly, b.appliesTo, b.scopeId ?? null, b.isPaid],
  );
  await audit(req.ctx, 'holiday.created', { entityType: 'holiday', entityId: h.id, after: b });
  created(res, holidayDto(await loadHoliday(req.ctx.orgId, h.id)));
});

holidays.patch(
  '/:id',
  {
    summary: 'Update holiday',
    ids: 'ATT-15',
    permission: 'holidays.manage',
    params: idParam,
    body: z.object({ name: z.string().trim().min(1).max(120), date: realDate, recurringYearly: z.boolean(), appliesTo: z.enum(['org', 'team', 'department']), scopeId: z.uuid().nullable(), isPaid: z.boolean() }).partial(),
  },
  async (req, res) => {
    const before = await loadHoliday(req.ctx.orgId, req.v.params.id);
    const b = req.body;
    const appliesTo = b.appliesTo ?? before.applies_to;
    const scopeId = b.scopeId !== undefined ? b.scopeId : b.appliesTo === 'org' ? null : before.scope_id;
    await checkHolidayScope(req.ctx.orgId, appliesTo, scopeId);
    await db.query(
      `UPDATE holidays SET name = coalesce($2, name), date = coalesce($3::date, date), recurring_yearly = coalesce($4, recurring_yearly),
         applies_to = $5, scope_id = $6, is_paid = coalesce($7, is_paid) WHERE id = $1`,
      [before.id, b.name ?? null, b.date ?? null, b.recurringYearly ?? null, appliesTo, scopeId, b.isPaid ?? null],
    );
    await audit(req.ctx, 'holiday.updated', { entityType: 'holiday', entityId: before.id, before: holidayDto(before), after: b });
    ok(res, holidayDto(await loadHoliday(req.ctx.orgId, before.id)));
  },
);

holidays.delete('/:id', { summary: 'Delete holiday', ids: 'ATT-15', permission: 'holidays.manage', params: idParam }, async (req, res) => {
  const h = await loadHoliday(req.ctx.orgId, req.v.params.id);
  await db.query('DELETE FROM holidays WHERE id = $1', [h.id]);
  await audit(req.ctx, 'holiday.deleted', { entityType: 'holiday', entityId: h.id, before: holidayDto(h) });
  noContent(res);
});

export default [schedules, shifts, assignments, holidays];
