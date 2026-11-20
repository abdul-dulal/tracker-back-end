import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';
import { checkIn, checkOut, detectAbsences, autoCheckout } from '../src/modules/attendance/service.js';
import { resolveSchedule } from '../src/modules/attendance/schedule.js';
import { startTimer, stopTimer } from '../src/modules/time/timer-service.js';
import { runCron } from '../src/lib/jobs.js';

let t;
let owner;
let emp;
let emp2;
let manager;
let outsider; // manager of another team
let team;

const notifTypes = async (userId) => (await db.many('SELECT type FROM notifications WHERE recipient_user_id = $1', [userId])).map((r) => r.type);

beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  emp = await addMember(t, owner, { role: 'employee', firstName: 'Emma' });
  emp2 = await addMember(t, owner, { role: 'employee', firstName: 'Evan' });
  manager = await addMember(t, owner, { role: 'manager', firstName: 'Mia' });
  outsider = await addMember(t, owner, { role: 'manager', firstName: 'Otto' });
  team = await db.one(`INSERT INTO teams (organization_id, name) VALUES ($1, 'Alpha') RETURNING id`, [owner.orgId]);
  await db.query('INSERT INTO team_members (team_id, member_id) VALUES ($1,$2), ($1,$3)', [team.id, emp.memberId, emp2.memberId]);
  await db.query('INSERT INTO team_managers (team_id, member_id) VALUES ($1,$2)', [team.id, manager.memberId]);
  const other = await db.one(`INSERT INTO teams (organization_id, name) VALUES ($1, 'Beta') RETURNING id`, [owner.orgId]);
  await db.query('INSERT INTO team_managers (team_id, member_id) VALUES ($1,$2)', [other.id, outsider.memberId]);
});

describe('schedule resolver', () => {
  it('uses the org default 09:00–17:00 Mon–Fri schedule, holidays and shifts', async () => {
    const wed = await resolveSchedule(emp.memberId, '2026-11-18');
    expect(wed).toMatchObject({ working: true, scheduleType: 'fixed', start: '09:00', end: '17:00', expectedSeconds: 8 * 3600, shiftId: null });
    expect(new Date(wed.startAt).toISOString()).toBe('2026-11-18T09:00:00.000Z');
    const sat = await resolveSchedule(emp.memberId, '2026-11-21');
    expect(sat.working).toBe(false);
    await db.query(`INSERT INTO holidays (organization_id, name, date, recurring_yearly) VALUES ($1, 'Founders Day', '2020-11-26', true)`, [owner.orgId]);
    const hol = await resolveSchedule(emp.memberId, '2026-11-26');
    expect(hol.working).toBe(false);
    expect(hol.holiday.name).toBe('Founders Day');
    const team = await db.one(`INSERT INTO teams (organization_id, name) VALUES ($1, 'Gamma') RETURNING id`, [owner.orgId]);
    await db.query(`INSERT INTO holidays (organization_id, name, date, applies_to, scope_id) VALUES ($1, 'Team day', '2026-11-27', 'team', $2)`, [owner.orgId, team.id]);
    expect((await resolveSchedule(emp.memberId, '2026-11-27')).working).toBe(true);
    const shift = await db.one(`INSERT INTO shifts (organization_id, name, start_time, end_time, break_minutes) VALUES ($1,'Late','13:00','21:00',30) RETURNING id`, [owner.orgId]);
    await db.query(`INSERT INTO shift_assignments (organization_id, member_id, shift_id, start_date, end_date, weekdays) VALUES ($1,$2,$3,'2026-12-01','2026-12-31','{1,2,3,4,5,6}')`, [owner.orgId, emp2.memberId, shift.id]);
    const s = await resolveSchedule(emp2.memberId, '2026-12-05'); // Saturday covered by the shift
    expect(s).toMatchObject({ working: true, start: '13:00', end: '21:00', expectedSeconds: 7.5 * 3600, shiftId: shift.id });
  });
});

describe('attendance check-in / out', () => {
  it('detects late arrival and early leave with the default schedule (ATT-06/07)', async () => {
    const { record } = await checkIn(owner.orgId, emp.memberId, { at: new Date('2026-11-18T09:30:00Z'), source: 'manual' });
    expect(record.status).toBe('late');
    expect(record.late_minutes).toBe(30);
    expect(await notifTypes(emp.user.id)).toContain('attendance.late');
    expect(await notifTypes(manager.user.id)).toContain('attendance.late');
    expect(await notifTypes(outsider.user.id)).not.toContain('attendance.late');
    // idempotent
    const again = await checkIn(owner.orgId, emp.memberId, { at: new Date('2026-11-18T10:00:00Z') });
    expect(again.created).toBe(false);
    const out = await checkOut(owner.orgId, emp.memberId, { at: new Date('2026-11-18T16:00:00Z') });
    expect(out.record.early_leave_minutes).toBe(60);
    expect(out.record.worked_seconds).toBe(6.5 * 3600);
    expect(out.record.status).toBe('late');
    // within grace → present
    const ok = await checkIn(owner.orgId, emp2.memberId, { at: new Date('2026-11-18T09:08:00Z') });
    expect(ok.record.status).toBe('present');
    expect(ok.record.late_minutes).toBe(0);
    const over = await checkOut(owner.orgId, emp2.memberId, { at: new Date('2026-11-18T18:08:00Z') });
    expect(over.record.overtime_seconds).toBe(3600);
  });

  it('flexible schedules are never late (ATT-12)', async () => {
    const flex = await db.one(
      `INSERT INTO work_schedules (organization_id, name, schedule_type, working_days, required_hours_per_day) VALUES ($1,'Flex','flexible','{1,2,3,4,5}',6) RETURNING id`,
      [owner.orgId],
    );
    const m = await addMember(t, owner, { role: 'employee' });
    await db.query('UPDATE organization_members SET work_schedule_id = $2 WHERE id = $1', [m.memberId, flex.id]);
    const { record } = await checkIn(owner.orgId, m.memberId, { at: new Date('2026-11-18T13:45:00Z') });
    expect(record.status).toBe('present');
    expect(record.late_minutes).toBe(0);
  });

  it('self check-in/out via API is idempotent per day', async () => {
    const m = await addMember(t, owner, { role: 'employee' });
    await m.api.post('/api/v1/attendance/check-out').expect(409);
    const a = await m.api.post('/api/v1/attendance/check-in').send({ workMode: 'remote' }).expect(201);
    expect(a.body.data.workMode).toBe('remote');
    expect(a.body.data.checkInSource).toBe('manual');
    const b = await m.api.post('/api/v1/attendance/check-in').send({}).expect(200);
    expect(b.body.data.id).toBe(a.body.data.id);
    await m.api.post('/api/v1/attendance/check-in').send({ workMode: 'moon' }).expect(400);
    const out = await m.api.post('/api/v1/attendance/check-out').expect(200);
    expect(out.body.data.checkOutAt).toBeTruthy();
    const today = await m.api.get('/api/v1/attendance/today').expect(200);
    expect(today.body.data.summary.total).toBe(1); // employee sees only self
  });

  it('admin edit recomputes lateness; employees cannot edit (PATCH /attendance/:id)', async () => {
    const rec = await db.one('SELECT id FROM attendance_records WHERE member_id = $1 AND date = $2', [emp2.memberId, '2026-11-18']);
    await emp.api.patch(`/api/v1/attendance/${rec.id}`).send({ note: 'x' }).expect(403);
    await manager.api.patch(`/api/v1/attendance/${rec.id}`).send({ note: 'x' }).expect(403); // no attendance.manage
    const r = await owner.api.patch(`/api/v1/attendance/${rec.id}`).send({ checkInAt: '2026-11-18T09:45:00Z' }).expect(200);
    expect(r.body.data.status).toBe('late');
    expect(r.body.data.lateMinutes).toBe(45);
    const log = await db.one(`SELECT 1 FROM audit_logs WHERE action = 'attendance.updated' AND entity_id = $1`, [rec.id]);
    expect(log).toBeTruthy();
    await owner.api.patch(`/api/v1/attendance/${rec.id}`).send({ checkOutAt: '2026-11-18T08:00:00Z' }).expect(400);
  });

  it('auto check-in on timer start and check-out on stop', async () => {
    const m = await addMember(t, owner, { role: 'employee' });
    const project = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Web') RETURNING id`, [owner.orgId]);
    await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2)', [project.id, m.memberId]);
    const ctx = { orgId: owner.orgId, memberId: m.memberId, cache: new Map() };
    const startedAt = new Date(Date.now() - 120_000);
    await startTimer(ctx, { projectId: project.id, startedAt });
    const rec = await db.one('SELECT * FROM attendance_records WHERE member_id = $1', [m.memberId]);
    expect(rec.check_in_source).toBe('timer');
    expect(new Date(rec.check_in_at).getTime()).toBe(startedAt.getTime());
    await stopTimer(ctx);
    const after = await db.one('SELECT * FROM attendance_records WHERE id = $1', [rec.id]);
    expect(after.check_out_at).toBeTruthy();
    expect(after.worked_seconds).toBeGreaterThanOrEqual(110);
    // disabled setting → no auto check-in
    await db.query('UPDATE organization_settings SET attendance_auto_checkin = false WHERE organization_id = $1', [owner.orgId]);
    const m2 = await addMember(t, owner, { role: 'employee' });
    await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2)', [project.id, m2.memberId]);
    const ctx2 = { orgId: owner.orgId, memberId: m2.memberId, cache: new Map() };
    await startTimer(ctx2, { projectId: project.id });
    await stopTimer(ctx2);
    expect(await db.one('SELECT 1 FROM attendance_records WHERE member_id = $1', [m2.memberId])).toBeNull();
    await db.query('UPDATE organization_settings SET attendance_auto_checkin = true WHERE organization_id = $1', [owner.orgId]);
  });
});

describe('absence detection', () => {
  it('marks absent once, skips holidays and weekends (ATT-08/15/16)', async () => {
    const o = await registerOrg(t);
    const e = await addMember(t, o, { role: 'employee' });
    await db.query(`UPDATE organization_members SET joined_on = '2026-11-01' WHERE organization_id = $1`, [o.orgId]);
    await db.query(`INSERT INTO holidays (organization_id, name, date) VALUES ($1, 'Holiday', '2026-11-18')`, [o.orgId]);
    // Wednesday 18 is a holiday; Tuesday 17 is a normal working day.
    const n = await detectAbsences({ now: new Date('2026-11-18T20:00:00Z'), orgId: o.orgId });
    expect(n).toBe(2);
    const rows = await db.many(`SELECT member_id, to_char(date,'YYYY-MM-DD') AS d, status FROM attendance_records WHERE organization_id = $1`, [o.orgId]);
    expect(rows.every((r) => r.d === '2026-11-17' && r.status === 'absent')).toBe(true);
    expect(await notifTypes(e.user.id)).toContain('attendance.alert');
    expect(await detectAbsences({ now: new Date('2026-11-18T23:00:00Z'), orgId: o.orgId })).toBe(0);
    // before schedule end + 2h → not yet absent
    expect(await detectAbsences({ now: new Date('2026-11-19T18:00:00Z'), orgId: o.orgId })).toBe(0);
    expect(await detectAbsences({ now: new Date('2026-11-19T19:30:00Z'), orgId: o.orgId })).toBe(2);
    // weekend
    expect(await detectAbsences({ now: new Date('2026-11-22T20:00:00Z'), orgId: o.orgId })).toBe(0);

    // includeMissing synthesizes absent / holiday / weekend rows for past days
    const list = await o.api.get(`/api/v1/attendance?from=2026-11-14&to=2026-11-18&memberId=${e.memberId}&includeMissing=true`).expect(200);
    const byDate = Object.fromEntries(list.body.data.map((r) => [r.date, r]));
    expect(byDate['2026-11-14'].status).toBe('weekend');
    expect(byDate['2026-11-16']).toMatchObject({ status: 'absent', synthetic: true });
    expect(byDate['2026-11-17']).toMatchObject({ status: 'absent', synthetic: false });
    expect(byDate['2026-11-18'].status).toBe('holiday');
    // a late timer start converts the absence placeholder
    const { record } = await checkIn(o.orgId, e.memberId, { at: new Date('2026-11-17T10:00:00Z'), source: 'timer' });
    expect(record.status).toBe('late');
  });

  it('auto check-out closes open check-ins at local day end', async () => {
    const m = await addMember(t, owner, { role: 'employee' });
    await checkIn(owner.orgId, m.memberId, { at: new Date('2026-11-16T09:00:00Z') });
    await db.query(
      `INSERT INTO time_entries (organization_id, member_id, started_at, ended_at, duration_seconds, status) VALUES ($1,$2,'2026-11-16T09:00:00Z','2026-11-16T15:30:00Z',23400,'completed')`,
      [owner.orgId, m.memberId],
    );
    expect(await autoCheckout({ now: new Date('2026-11-17T01:00:00Z') })).toBeGreaterThanOrEqual(1);
    const r = await db.one('SELECT * FROM attendance_records WHERE member_id = $1', [m.memberId]);
    expect(new Date(r.check_out_at).toISOString()).toBe('2026-11-16T15:30:00.000Z');
    expect(r.early_leave_minutes).toBe(90);
  });
});

describe('attendance corrections', () => {
  it('request → scoped approval → record upserted (ATT-17/18)', async () => {
    const res = await emp.api
      .post('/api/v1/attendance/corrections')
      .send({ date: '2026-11-17', requestedCheckIn: '2026-11-17T09:00:00Z', requestedCheckOut: '2026-11-17T17:00:00Z', reason: 'Forgot to check in' })
      .expect(201);
    const id = res.body.data.id;
    expect(await notifTypes(manager.user.id)).toContain('approval.requested');
    await emp.api.post('/api/v1/attendance/corrections').send({ date: '2026-11-17', requestedCheckIn: '2026-11-17T09:00:00Z', reason: 'again' }).expect(409);
    await emp.api.post('/api/v1/attendance/corrections').send({ date: '2026-11-17', reason: 'nothing requested' }).expect(400);
    await emp.api.post('/api/v1/attendance/corrections').send({ date: '2099-01-01', requestedCheckIn: '2099-01-01T09:00:00Z', reason: 'future' }).expect(400);

    await emp.api.post(`/api/v1/attendance/corrections/${id}/approve`).send({}).expect(403);
    await outsider.api.post(`/api/v1/attendance/corrections/${id}/approve`).send({}).expect(403);
    const mine = await emp.api.get('/api/v1/attendance/corrections').expect(200);
    expect(mine.body.data).toHaveLength(1);
    const queue = await manager.api.get('/api/v1/attendance/corrections?status=pending').expect(200);
    expect(queue.body.data.map((c) => c.id)).toContain(id);
    const outsiderQueue = await outsider.api.get('/api/v1/attendance/corrections?status=pending').expect(200);
    expect(outsiderQueue.body.data.map((c) => c.id)).not.toContain(id);

    const ap = await manager.api.post(`/api/v1/attendance/corrections/${id}/approve`).send({ note: 'ok' }).expect(200);
    expect(ap.body.data.correction.status).toBe('approved');
    expect(ap.body.data.record).toMatchObject({ status: 'present', checkInSource: 'correction', lateMinutes: 0, workedSeconds: 8 * 3600 });
    expect(await notifTypes(emp.user.id)).toContain('approval.resolved');
    await manager.api.post(`/api/v1/attendance/corrections/${id}/approve`).send({}).expect(409);

    // correcting an existing late record recomputes lateness
    const c2 = await emp.api.post('/api/v1/attendance/corrections').send({ date: '2026-11-18', requestedCheckIn: '2026-11-18T09:02:00Z', reason: 'Badge reader failed' }).expect(201);
    const ap2 = await owner.api.post(`/api/v1/attendance/corrections/${c2.body.data.id}/approve`).send({}).expect(200);
    expect(ap2.body.data.record.status).toBe('present');
    const c3 = await emp.api.post('/api/v1/attendance/corrections').send({ date: '2026-11-16', requestedCheckIn: '2026-11-16T09:00:00Z', reason: 'please' }).expect(201);
    const rj = await manager.api.post(`/api/v1/attendance/corrections/${c3.body.data.id}/reject`).send({ note: 'no proof' }).expect(200);
    expect(rj.body.data.status).toBe('rejected');
  });
});

describe('attendance views & scope', () => {
  it('lists, calendar, history and reports with scope enforcement (ATT-03/04/05/19/20)', async () => {
    const all = await owner.api.get('/api/v1/attendance?from=2026-11-16&to=2026-11-18').expect(200);
    expect(all.body.data.length).toBeGreaterThanOrEqual(3);
    const own = await emp.api.get('/api/v1/attendance?from=2026-11-16&to=2026-11-18').expect(200);
    expect(own.body.data.every((r) => r.memberId === emp.memberId)).toBe(true);
    const mgr = await manager.api.get(`/api/v1/attendance?from=2026-11-16&to=2026-11-18&teamId=${team.id}`).expect(200);
    expect(new Set(mgr.body.data.map((r) => r.memberId))).toEqual(new Set([emp.memberId, emp2.memberId]));
    const weekly = await owner.api.get('/api/v1/attendance?from=2026-11-01&to=2026-11-30&groupBy=week').expect(200);
    expect(weekly.body.data[0]).toHaveProperty('period');
    await owner.api.get('/api/v1/attendance?from=2026-01-01&to=2026-12-31').expect(400);

    const cal = await emp.api.get('/api/v1/attendance/calendar?month=2026-11').expect(200);
    expect(cal.body.data.days).toHaveLength(30);
    expect(cal.body.data.days.find((d) => d.date === '2026-11-26').status).toBe('holiday');
    await emp.api.get(`/api/v1/attendance/calendar?memberId=${emp2.memberId}&month=2026-11`).expect(403);
    await outsider.api.get(`/api/v1/attendance/calendar?memberId=${emp.memberId}`).expect(403);
    await manager.api.get(`/api/v1/attendance/calendar?memberId=${emp.memberId}&month=2026-11`).expect(200);

    const hist = await manager.api.get(`/api/v1/attendance/history?memberId=${emp.memberId}`).expect(200);
    expect(hist.body.data.records.length).toBeGreaterThanOrEqual(2);
    expect(hist.body.data.corrections.length).toBe(3);
    await outsider.api.get(`/api/v1/attendance/history?memberId=${emp.memberId}`).expect(403);

    const rep = await owner.api.get('/api/v1/attendance/reports?from=2026-11-16&to=2026-11-18&groupBy=member').expect(200);
    const row = rep.body.data.rows.find((r) => r.key === emp.memberId);
    expect(row.present).toBeGreaterThanOrEqual(2);
    const byTeam = await owner.api.get('/api/v1/attendance/reports?from=2026-11-16&to=2026-11-18&groupBy=team').expect(200);
    expect(byTeam.body.data.rows.find((r) => r.key === team.id)).toBeTruthy();
    const empRep = await emp.api.get('/api/v1/attendance/reports?from=2026-11-16&to=2026-11-18&groupBy=member').expect(200);
    expect(empRep.body.data.rows.every((r) => r.key === emp.memberId)).toBe(true);
    await owner.api.get('/api/v1/attendance/reports?from=2026-11-18').expect(400);

    const today = await manager.api.get('/api/v1/attendance/today').expect(200);
    expect(today.body.data.summary.total).toBe(3); // manager + two team members
  });

  it('organization isolation', async () => {
    const o2 = await registerOrg(t);
    const rec = await db.one('SELECT id FROM attendance_records WHERE member_id = $1 LIMIT 1', [emp.memberId]);
    await o2.api.patch(`/api/v1/attendance/${rec.id}`).send({ note: 'hack' }).expect(404);
    const list = await o2.api.get('/api/v1/attendance?from=2026-11-16&to=2026-11-18').expect(200);
    expect(list.body.data).toHaveLength(0);
    await o2.api.get(`/api/v1/attendance/calendar?memberId=${emp.memberId}`).expect(404);
  });

  it('crons run without errors', async () => {
    await runCron('attendance.absent');
    await runCron('attendance.auto_checkout');
  });
});
