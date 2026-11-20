import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';
import { expectedSecondsForDate } from '../src/modules/time/summary-service.js';

let t;
beforeAll(async () => {
  t = await setupApp();
});

const API = '/api/v1';

describe('Work schedules (ATT-09…ATT-12, ATT-16)', () => {
  it('CRUD, default flag, fixed/flexible validation and permissions', async () => {
    const o = await registerOrg(t);
    const emp = await addMember(t, o, { role: 'employee' });
    const list = await emp.api.get(`${API}/work-schedules`).expect(200); // attendance.view
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].isDefault).toBe(true);
    const origDefault = list.body.data[0].id;

    await o.api.post(`${API}/work-schedules`).send({ name: 'Bad', scheduleType: 'fixed' }).expect(400);
    await o.api.post(`${API}/work-schedules`).send({ name: 'Bad', startTime: '17:00', endTime: '09:00' }).expect(400);
    await o.api.post(`${API}/work-schedules`).send({ name: 'Bad', startTime: '09:00', endTime: '17:00', workingDays: [9] }).expect(400);
    const flex = await o.api.post(`${API}/work-schedules`).send({ name: 'Flexible remote', scheduleType: 'flexible', requiredHoursPerDay: 6, workMode: 'remote', workingDays: [1, 2, 3, 4] }).expect(201);
    expect(flex.body.data).toMatchObject({ scheduleType: 'flexible', startTime: null, requiredHoursPerDay: 6, workMode: 'remote', workingDays: [1, 2, 3, 4] });
    const fixed = await o.api.post(`${API}/work-schedules`).send({ name: 'Early', startTime: '07:00', endTime: '15:00', isDefault: true }).expect(201);
    expect(fixed.body.data.isDefault).toBe(true);
    const after = await o.api.get(`${API}/work-schedules`).expect(200);
    expect(after.body.data.filter((s) => s.isDefault).map((s) => s.id)).toEqual([fixed.body.data.id]);

    await o.api.patch(`${API}/work-schedules/${flex.body.data.id}`).send({ scheduleType: 'fixed' }).expect(400); // no times
    const upd = await o.api.patch(`${API}/work-schedules/${flex.body.data.id}`).send({ name: 'Flex 4d', requiredHoursPerDay: 7.5 }).expect(200);
    expect(upd.body.data.requiredHoursPerDay).toBe(7.5);

    await o.api.delete(`${API}/work-schedules/${fixed.body.data.id}`).expect(409); // default
    await o.api.patch(`${API}/members/${emp.memberId}`).send({ workScheduleId: flex.body.data.id }).expect(200);
    expect(await expectedSecondsForDate(emp.memberId, '2026-11-16')).toBe(27000); // Monday, 7.5h
    expect(await expectedSecondsForDate(emp.memberId, '2026-11-20')).toBe(0); // Friday not a working day
    await o.api.delete(`${API}/work-schedules/${origDefault}`).expect(204);

    await emp.api.post(`${API}/work-schedules`).send({ name: 'X', scheduleType: 'flexible' }).expect(403);
    const other = await registerOrg(t);
    await other.api.get(`${API}/work-schedules/${flex.body.data.id}`).expect(404);
    await other.api.patch(`${API}/members/${other.memberId}`).send({ workScheduleId: flex.body.data.id }).expect(400);
  });
});

describe('Shifts & assignments (ATT-13, ATT-14)', () => {
  it('creates shifts, assigns members, filters and scope', async () => {
    const o = await registerOrg(t);
    const mgr = await addMember(t, o, { role: 'manager' });
    const e1 = await addMember(t, o, { role: 'employee' });
    const e2 = await addMember(t, o, { role: 'employee' });
    await o.api.post(`${API}/teams`).send({ name: 'Night crew', memberIds: [e1.memberId], managerIds: [mgr.memberId] }).expect(201);

    const night = await o.api.post(`${API}/shifts`).send({ name: 'Night', startTime: '22:00', endTime: '06:00', breakMinutes: 30, color: '#000000' }).expect(201);
    expect(night.body.data).toMatchObject({ crossesMidnight: true, durationMinutes: 450 });
    await o.api.post(`${API}/shifts`).send({ name: 'Night', startTime: '20:00', endTime: '04:00' }).expect(409);
    await o.api.post(`${API}/shifts`).send({ name: 'Zero', startTime: '08:00', endTime: '08:00' }).expect(400);
    await o.api.post(`${API}/shifts`).send({ name: 'Long break', startTime: '08:00', endTime: '09:00', breakMinutes: 60 }).expect(400);
    const day = await o.api.post(`${API}/shifts`).send({ name: 'Day', startTime: '08:00', endTime: '16:00' }).expect(201);
    const pd = await o.api.patch(`${API}/shifts/${day.body.data.id}`).send({ endTime: '17:00', breakMinutes: 60 }).expect(200);
    expect(pd.body.data).toMatchObject({ endTime: '17:00', durationMinutes: 480, crossesMidnight: false });

    await o.api.post(`${API}/shift-assignments`).send({ memberIds: [e1.memberId], shiftId: night.body.data.id, startDate: '2026-11-10', endDate: '2026-11-01' }).expect(400);
    const as = await o.api.post(`${API}/shift-assignments`).send({ memberIds: [e1.memberId, e2.memberId], shiftId: night.body.data.id, startDate: '2026-11-01', endDate: '2026-11-30', weekdays: [1, 2, 3] }).expect(201);
    expect(as.body.data).toHaveLength(2);
    expect(as.body.data[0].weekdays).toEqual([1, 2, 3]);
    expect(await expectedSecondsForDate(e1.memberId, '2026-11-16')).toBe(450 * 60); // Monday on the night shift

    const all = await o.api.get(`${API}/shift-assignments?shiftId=${night.body.data.id}`).expect(200);
    expect(all.body.meta.total).toBe(2);
    const range = await o.api.get(`${API}/shift-assignments?from=2026-12-01`).expect(200);
    expect(range.body.meta.total).toBe(0);
    // manager (attendance.view team) sees only own team; employee only self
    const mg = await mgr.api.get(`${API}/shift-assignments`).expect(200);
    expect(mg.body.data.map((a) => a.member.id)).toEqual([e1.memberId]);
    const ev = await e2.api.get(`${API}/shift-assignments`).expect(200);
    expect(ev.body.data.map((a) => a.member.id)).toEqual([e2.memberId]);
    await mgr.api.post(`${API}/shift-assignments`).send({ memberIds: [e1.memberId], shiftId: day.body.data.id, startDate: '2026-12-01' }).expect(403);

    // replaceOverlapping
    await o.api.post(`${API}/shift-assignments`).send({ memberIds: [e1.memberId], shiftId: day.body.data.id, startDate: '2026-11-15', weekdays: [1], replaceOverlapping: true }).expect(201);
    const e1a = await o.api.get(`${API}/shift-assignments?memberId=${e1.memberId}`).expect(200);
    expect(e1a.body.data.map((a) => a.shift.name)).toEqual(['Day']);

    await o.api.delete(`${API}/shift-assignments/${e1a.body.data[0].id}`).expect(204);
    await o.api.delete(`${API}/shift-assignments/${e1a.body.data[0].id}`).expect(404);
    await o.api.delete(`${API}/shifts/${night.body.data.id}`).expect(204);
    expect((await db.one('SELECT count(*)::int n FROM shift_assignments WHERE organization_id = $1', [o.orgId])).n).toBe(0);
    const other = await registerOrg(t);
    await other.api.post(`${API}/shift-assignments`).send({ memberIds: [other.memberId], shiftId: day.body.data.id, startDate: '2026-11-01' }).expect(404);
  });
});

describe('Holidays (ATT-15)', () => {
  it('CRUD, recurring resolution, scope validation and permissions', async () => {
    const o = await registerOrg(t);
    const emp = await addMember(t, o, { role: 'employee' });
    const team = (await o.api.post(`${API}/teams`).send({ name: 'HQ', memberIds: [emp.memberId] }).expect(201)).body.data;
    const ny = await o.api.post(`${API}/holidays`).send({ name: 'New Year', date: '2020-01-01', recurringYearly: true }).expect(201);
    await o.api.post(`${API}/holidays`).send({ name: 'Offsite', date: '2026-11-18', appliesTo: 'team', scopeId: team.id }).expect(201);
    await o.api.post(`${API}/holidays`).send({ name: 'Bad', date: '2026-11-18', appliesTo: 'team' }).expect(400);
    await o.api.post(`${API}/holidays`).send({ name: 'Bad', date: '2026-11-18', appliesTo: 'org', scopeId: team.id }).expect(400);
    await o.api.post(`${API}/holidays`).send({ name: 'Bad', date: '2026-02-30' }).expect(400);
    const year = await emp.api.get(`${API}/holidays?year=2027`).expect(200);
    expect(year.body.data.map((h) => [h.name, h.occursOn])).toEqual([['New Year', '2027-01-01']]);
    const nov = await o.api.get(`${API}/holidays?from=2026-11-01&to=2026-11-30`).expect(200);
    expect(nov.body.data.map((h) => h.name)).toEqual(['Offsite']);
    expect(nov.body.data[0].scopeName).toBe('HQ');
    expect(await expectedSecondsForDate(emp.memberId, '2026-11-18')).toBe(0);
    expect(await expectedSecondsForDate(emp.memberId, '2027-01-01')).toBe(0);

    const upd = await o.api.patch(`${API}/holidays/${ny.body.data.id}`).send({ name: "New Year's Day", isPaid: false }).expect(200);
    expect(upd.body.data).toMatchObject({ name: "New Year's Day", isPaid: false, recurringYearly: true });
    await emp.api.post(`${API}/holidays`).send({ name: 'Mine', date: '2026-12-24' }).expect(403);
    await emp.api.delete(`${API}/holidays/${ny.body.data.id}`).expect(403);
    await o.api.delete(`${API}/holidays/${ny.body.data.id}`).expect(204);
    const other = await registerOrg(t);
    await other.api.get(`${API}/holidays/${ny.body.data.id}`).expect(404);
  });
});

describe('Break types (BRK-01)', () => {
  it('lists, creates, renames system types, protects and archives', async () => {
    const o = await registerOrg(t);
    const emp = await addMember(t, o, { role: 'employee' });
    const list = await emp.api.get(`${API}/break-types`).expect(200);
    expect(list.body.data.map((b) => b.name).sort()).toEqual(['Lunch Break', 'Tea Break']);
    const lunch = list.body.data.find((b) => b.name === 'Lunch Break');
    expect(lunch.isSystem).toBe(true);

    const ren = await o.api.patch(`${API}/break-types/${lunch.id}`).send({ name: 'Lunch', maxMinutes: 45 }).expect(200);
    expect(ren.body.data).toMatchObject({ name: 'Lunch', maxMinutes: 45, isSystem: true });
    await o.api.delete(`${API}/break-types/${lunch.id}`).expect(409);
    await o.api.patch(`${API}/break-types/${lunch.id}`).send({ archived: true }).expect(409);

    const pray = await o.api.post(`${API}/break-types`).send({ name: 'Prayer', isPaid: true, maxMinutes: 20, color: '#00ff00' }).expect(201);
    await o.api.post(`${API}/break-types`).send({ name: 'prayer' }).expect(409);
    await o.api.post(`${API}/break-types`).send({ name: 'X', maxMinutes: 0 }).expect(400);
    await emp.api.post(`${API}/break-types`).send({ name: 'Nap' }).expect(403);

    // in use → archived instead of deleted
    await db.query(`INSERT INTO breaks (organization_id, member_id, break_type_id, started_at, ended_at) VALUES ($1,$2,$3, now() - interval '10 minutes', now())`, [o.orgId, emp.memberId, pray.body.data.id]);
    const del = await o.api.delete(`${API}/break-types/${pray.body.data.id}`).expect(200);
    expect(del.body.data).toMatchObject({ archived: true, deleted: false });
    const after = await emp.api.get(`${API}/break-types`).expect(200);
    expect(after.body.data.some((b) => b.id === pray.body.data.id)).toBe(false);
    const withArch = await o.api.get(`${API}/break-types?includeArchived=true`).expect(200);
    expect(withArch.body.data.some((b) => b.id === pray.body.data.id)).toBe(true);
    await o.api.patch(`${API}/break-types/${pray.body.data.id}`).send({ archived: false }).expect(200);

    const temp = await o.api.post(`${API}/break-types`).send({ name: 'Temp' }).expect(201);
    await o.api.delete(`${API}/break-types/${temp.body.data.id}`).expect(204);
    const other = await registerOrg(t);
    await other.api.patch(`${API}/break-types/${lunch.id}`).send({ name: 'Hack' }).expect(404);
  });
});
