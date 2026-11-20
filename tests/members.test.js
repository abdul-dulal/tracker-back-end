import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { setupApp, registerOrg, addMember, request, db } from './helpers.js';

let t;
beforeAll(async () => {
  t = await setupApp();
});

const API = '/api/v1';
let n = 0;
const email = (p = 'emp') => `${p}-${Date.now().toString(36)}-${n++}@example.com`;

async function useFreePlan(orgId) {
  await db.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'free'), status = 'active' WHERE organization_id = $1`, [orgId]);
}

describe('Members — add / list / profile', () => {
  it('adds an employee with profile, teams, managers and invitation (EMP-01, EMP-05…EMP-16)', async () => {
    const o = await registerOrg(t);
    const dept = await o.api.post(`${API}/departments`).send({ name: 'Engineering' }).expect(201);
    const team = await o.api.post(`${API}/teams`).send({ name: 'Platform', departmentId: dept.body.data.id }).expect(201);
    const e = email();
    const res = await o.api
      .post(`${API}/members`)
      .send({
        email: e,
        firstName: 'Jane',
        lastName: 'Doe',
        roleId: o.roles.employee,
        designation: 'Engineer',
        departmentId: dept.body.data.id,
        teamIds: [team.body.data.id],
        managerIds: [o.memberId],
        employmentType: 'part_time',
        joinedOn: '2026-01-15',
        weeklyHours: 20,
        workMode: 'remote',
        hourlyRate: 30,
      })
      .expect(201);
    const m = res.body.data;
    expect(m.status).toBe('invited');
    expect(m.employeeCode).toMatch(/^EMP-\d{4}$/);
    expect(m.department.name).toBe('Engineering');
    expect(m.teams.map((x) => x.name)).toEqual(['Platform']);
    expect(m.managers[0].id).toBe(o.memberId);
    expect(m.weeklyHours).toBe(20);
    expect(m.hourlyRate).toEqual({ amount: 30, currency: 'USD', payType: 'hourly' });
    expect(m.invitationId).toBeTruthy();
    const inv = await db.one('SELECT member_id, status FROM invitations WHERE id = $1', [m.invitationId]);
    expect(inv).toEqual({ member_id: m.id, status: 'pending' });
    expect(t.outbox.some((x) => x.to === e)).toBe(true);
    const u = await db.one('SELECT password_hash, email_verified_at FROM users WHERE email = $1', [e]);
    expect(u).toEqual({ password_hash: null, email_verified_at: null });

    // duplicate email / employee code
    expect((await o.api.post(`${API}/members`).send({ email: e, firstName: 'X', roleId: o.roles.employee })).body.error.code).toBe('ALREADY_MEMBER');
    const dupCode = await o.api.post(`${API}/members`).send({ email: email(), firstName: 'X', roleId: o.roles.employee, employeeCode: m.employeeCode });
    expect(dupCode.status).toBe(409);
    // validation
    const bad = await o.api.post(`${API}/members`).send({ email: 'nope', firstName: '', roleId: 'x', weeklyHours: 500 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    // cannot self-manage via references to other orgs
    const other = await registerOrg(t);
    const cross = await o.api.post(`${API}/members`).send({ email: email(), firstName: 'X', roleId: o.roles.employee, managerIds: [other.memberId] });
    expect(cross.status).toBe(400);
  });

  it('invited member can activate via password reset + login + accept (existing-user flow)', async () => {
    const o = await registerOrg(t);
    const e = email();
    await o.api.post(`${API}/members`).send({ email: e, firstName: 'New', roleId: o.roles.employee }).expect(201);
    const invToken = [...t.outbox].reverse().find((x) => x.to === e).text.match(/invite\/(inv_[A-Za-z0-9_-]+)/)[1];
    await request(t.app).post(`${API}/auth/forgot-password`).send({ email: e }).expect(200);
    const reset = [...t.outbox].reverse().find((x) => x.to === e && /Reset/.test(x.subject)).text.match(/token=([\w-]+)/)[1];
    await request(t.app).post(`${API}/auth/reset-password`).send({ token: reset, password: 'Passw0rd!' }).expect(204);
    const login = await request(t.app).post(`${API}/auth/login`).send({ email: e, password: 'Passw0rd!' }).expect(200);
    const acc = await request(t.app).post(`${API}/invitations/token/${invToken}/accept`).set('Authorization', `Bearer ${login.body.data.accessToken}`).send({}).expect(200);
    const mem = await db.one('SELECT status, employee_code FROM organization_members WHERE id = $1', [acc.body.data.memberId]);
    expect(mem.status).toBe('active');
    expect(mem.employee_code).toMatch(/^EMP-/);
  });

  it('lists with search, filters, pagination and scope (EMP-21)', async () => {
    const o = await registerOrg(t);
    const team = (await o.api.post(`${API}/teams`).send({ name: 'Sales' }).expect(201)).body.data;
    const mgr = await addMember(t, o, { role: 'manager', firstName: 'Mona' });
    const e1 = await addMember(t, o, { role: 'employee', firstName: 'Eddie' });
    const e2 = await addMember(t, o, { role: 'employee', firstName: 'Zara' });
    await o.api.post(`${API}/teams/${team.id}/members`).send({ memberIds: [e1.memberId] }).expect(200);
    await o.api.put(`${API}/teams/${team.id}/managers`).send({ memberIds: [mgr.memberId] }).expect(200);

    const all = await o.api.get(`${API}/members?limit=2&page=1`).expect(200);
    expect(all.body.meta.total).toBe(4);
    expect(all.body.data).toHaveLength(2);
    const byTeam = await o.api.get(`${API}/members?teamId=${team.id}`).expect(200);
    expect(byTeam.body.data.map((x) => x.id)).toEqual([e1.memberId]);
    const search = await o.api.get(`${API}/members?search=zara`).expect(200);
    expect(search.body.data.map((x) => x.id)).toEqual([e2.memberId]);
    const byRole = await o.api.get(`${API}/members?roleId=${o.roles.manager}`).expect(200);
    expect(byRole.body.data.map((x) => x.id)).toEqual([mgr.memberId]);
    const sorted = await o.api.get(`${API}/members?sort=name&order=desc`).expect(200);
    expect(sorted.body.data[0].firstName).toBe('Zara');
    await o.api.get(`${API}/members?status=bogus`).expect(400);

    // employee sees only self; no rates without payroll perms
    const empList = await e2.api.get(`${API}/members`).expect(200);
    expect(empList.body.data.map((x) => x.id)).toEqual([e2.memberId]);
    expect(empList.body.data[0].hourlyRate).toBeUndefined();
    await e2.api.get(`${API}/members/${e1.memberId}`).expect(403);
    await e2.api.get(`${API}/members/${e2.memberId}`).expect(200);
    // manager sees own team (+ self)
    const mgrList = await mgr.api.get(`${API}/members`).expect(200);
    expect(mgrList.body.data.map((x) => x.id).sort()).toEqual([mgr.memberId, e1.memberId].sort());
    await mgr.api.get(`${API}/members/${e2.memberId}`).expect(403);
    // org isolation
    const other = await registerOrg(t);
    await other.api.get(`${API}/members/${e1.memberId}`).expect(404);
    const otherList = await other.api.get(`${API}/members`).expect(200);
    expect(otherList.body.data).toHaveLength(1);
  });

  it('profile and edit with scope (EMP-02, EMP-04)', async () => {
    const o = await registerOrg(t);
    const team = (await o.api.post(`${API}/teams`).send({ name: 'Ops' }).expect(201)).body.data;
    const team2 = (await o.api.post(`${API}/teams`).send({ name: 'Other' }).expect(201)).body.data;
    const mgr = await addMember(t, o, { role: 'manager' });
    const emp = await addMember(t, o, { role: 'employee' });
    await o.api.post(`${API}/teams/${team.id}/members`).send({ memberIds: [emp.memberId] }).expect(200);
    await o.api.put(`${API}/teams/${team.id}/managers`).send({ memberIds: [mgr.memberId] }).expect(200);

    const prof = await o.api.get(`${API}/members/${emp.memberId}`).expect(200);
    expect(prof.body.data.stats).toMatchObject({ todaySeconds: 0, timerRunning: false });
    expect(prof.body.data.hourlyRate).toBeNull();

    const upd = await mgr.api.patch(`${API}/members/${emp.memberId}`).send({ designation: 'Lead', weeklyLimitHours: 45, timezone: 'Europe/Berlin', restrictions: { manualTime: false } }).expect(200);
    expect(upd.body.data).toMatchObject({ designation: 'Lead', weeklyLimitHours: 45, timezone: 'Europe/Berlin', restrictions: { manualTime: false } });
    // manager cannot move member into a team they don't manage
    await mgr.api.patch(`${API}/members/${emp.memberId}`).send({ teamIds: [team.id, team2.id] }).expect(403);
    // employee cannot edit
    await emp.api.patch(`${API}/members/${emp.memberId}`).send({ designation: 'CEO' }).expect(403);
    // manager cannot edit admin (higher role)
    const admin = await addMember(t, o, { role: 'admin' });
    await mgr.api.patch(`${API}/members/${admin.memberId}`).send({ designation: 'x' }).expect(403);
    // bad timezone
    await o.api.patch(`${API}/members/${emp.memberId}`).send({ timezone: 'Mars/Base' }).expect(400);
    // employee code change + audit
    await o.api.patch(`${API}/members/${emp.memberId}`).send({ employeeCode: 'E-100' }).expect(200);
    const a = await db.one(`SELECT after FROM audit_logs WHERE action = 'member.updated' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`, [emp.memberId]);
    expect(a.after.employeeCode).toBe('E-100');
  });

  it('managers: multiple, no self (EMP-10)', async () => {
    const o = await registerOrg(t);
    const m1 = await addMember(t, o, { role: 'manager' });
    const m2 = await addMember(t, o, { role: 'manager' });
    const emp = await addMember(t, o, { role: 'employee' });
    const r = await o.api.put(`${API}/members/${emp.memberId}/managers`).send({ managerIds: [m1.memberId, m2.memberId] }).expect(200);
    expect(r.body.data.managers).toHaveLength(2);
    await o.api.put(`${API}/members/${emp.memberId}/managers`).send({ managerIds: [emp.memberId] }).expect(400);
    // direct manager now sees the employee
    await m1.api.get(`${API}/members/${emp.memberId}`).expect(200);
  });
});

describe('Members — role, rates, status', () => {
  it('role assignment guards and last-owner rule (RBAC-09)', async () => {
    const o = await registerOrg(t);
    const admin = await addMember(t, o, { role: 'admin' });
    const emp = await addMember(t, o, { role: 'employee' });
    const r = await o.api.patch(`${API}/members/${emp.memberId}/role`).send({ roleId: o.roles.manager }).expect(200);
    expect(r.body.data.role.slug).toBe('manager');
    // admin cannot grant owner, or change the owner
    await admin.api.patch(`${API}/members/${emp.memberId}/role`).send({ roleId: o.roles.owner }).expect(403);
    await admin.api.patch(`${API}/members/${o.memberId}/role`).send({ roleId: o.roles.employee }).expect(403);
    // last owner cannot be demoted
    const last = await o.api.patch(`${API}/members/${o.memberId}/role`).send({ roleId: o.roles.admin });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('LAST_OWNER');
    // with a second owner it works
    await o.api.patch(`${API}/members/${admin.memberId}/role`).send({ roleId: o.roles.owner }).expect(200);
    await o.api.patch(`${API}/members/${o.memberId}/role`).send({ roleId: o.roles.admin }).expect(200);
    // employee lacks roles.manage
    await emp.api.patch(`${API}/members/${emp.memberId}/role`).send({ roleId: o.roles.admin }).expect(403);
    const audit = await db.one(`SELECT count(*)::int n FROM audit_logs WHERE action = 'member.role_changed' AND organization_id = $1`, [o.orgId]);
    expect(audit.n).toBe(3);
  });

  it('effective-dated rates with history and visibility (EMP-16)', async () => {
    const o = await registerOrg(t);
    const emp = await addMember(t, o, { role: 'employee' });
    const mgr = await addMember(t, o, { role: 'manager' });
    await o.api.post(`${API}/members/${emp.memberId}/rates`).send({ amount: 20, effectiveFrom: '2026-01-01' }).expect(201);
    await o.api.post(`${API}/members/${emp.memberId}/rates`).send({ amount: 25.5, effectiveFrom: '2026-06-01', currency: 'EUR' }).expect(201);
    await o.api.post(`${API}/members/${emp.memberId}/rates`).send({ rateType: 'billable', amount: 80, effectiveFrom: '2026-01-01' }).expect(201);
    const overlap = await o.api.post(`${API}/members/${emp.memberId}/rates`).send({ amount: 22, effectiveFrom: '2026-03-01' });
    expect(overlap.body.error.code).toBe('RATE_OVERLAP');
    const list = await o.api.get(`${API}/members/${emp.memberId}/rates`).expect(200);
    const pay = list.body.data.history.filter((x) => x.rateType === 'pay');
    expect(pay).toHaveLength(2);
    expect(pay.find((x) => x.effectiveFrom === '2026-01-01').effectiveTo).toBe('2026-06-01');
    expect(list.body.data.current.pay).toMatchObject({ amount: 25.5, currency: 'EUR' });
    expect(list.body.data.current.billable.amount).toBe(80);
    await o.api.post(`${API}/members/${emp.memberId}/rates`).send({ amount: -1, effectiveFrom: '2026-07-01' }).expect(400);
    // no payroll/billing permission → hidden
    await mgr.api.get(`${API}/members/${emp.memberId}/rates`).expect(403);
    await emp.api.post(`${API}/members/${emp.memberId}/rates`).send({ amount: 999, effectiveFrom: '2027-01-01' }).expect(403);
    const prof = await o.api.get(`${API}/members/${emp.memberId}`).expect(200);
    expect(prof.body.data.hourlyRate.amount).toBe(25.5);
    const audits = await db.one(`SELECT count(*)::int n FROM audit_logs WHERE action = 'member.rate_added' AND entity_id = $1`, [emp.memberId]);
    expect(audits.n).toBe(3);
  });

  it('deactivate stops the timer, revokes sessions and devices; reactivate checks seats (EMP-24)', async () => {
    const o = await registerOrg(t);
    const emp = await addMember(t, o, { role: 'employee' });
    await db.query(`INSERT INTO time_entries (organization_id, member_id, started_at, status) VALUES ($1,$2, now() - interval '30 minutes', 'running')`, [o.orgId, emp.memberId]);
    const dev = await db.one(`INSERT INTO devices (organization_id, member_id, machine_id_hash, online) VALUES ($1,$2,'abc',true) RETURNING id`, [o.orgId, emp.memberId]);
    await db.query(`INSERT INTO device_tokens (device_id, user_id, token_hash, expires_at) VALUES ($1,$2,'h-${Date.now()}', now() + interval '30 days')`, [dev.id, emp.user.id]);

    await emp.api.post(`${API}/members/${emp.memberId}/deactivate`).send({}).expect(403);
    await o.api.post(`${API}/members/${o.memberId}/deactivate`).send({}).expect(400); // self
    const d = await o.api.post(`${API}/members/${emp.memberId}/deactivate`).send({ reason: 'Left company' }).expect(200);
    expect(d.body.data.status).toBe('inactive');
    expect(d.body.data.deactivatedAt).toBeTruthy();
    const entry = await db.one(`SELECT ended_at, status FROM time_entries WHERE member_id = $1`, [emp.memberId]);
    expect(entry.ended_at).toBeTruthy();
    expect(entry.status).toBe('completed');
    expect((await db.one(`SELECT revoked_at FROM device_tokens WHERE device_id = $1`, [dev.id])).revoked_at).toBeTruthy();
    expect((await emp.api.get(`${API}/me`)).status).toBe(401);
    await o.api.post(`${API}/members/${emp.memberId}/deactivate`).send({}).expect(409);
    expect((await db.one(`SELECT count(*)::int n FROM audit_logs WHERE action = 'member.deactivated' AND entity_id = $1`, [emp.memberId])).n).toBe(1);

    // seat limit on reactivate (free plan: 3 seats)
    await useFreePlan(o.orgId);
    await addMember(t, o, { role: 'employee' });
    await addMember(t, o, { role: 'employee' });
    const full = await o.api.post(`${API}/members/${emp.memberId}/reactivate`).send({});
    expect(full.status).toBe(403);
    expect(full.body.error.code).toBe('SEAT_LIMIT_REACHED');
    await db.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'professional') WHERE organization_id = $1`, [o.orgId]);
    const re = await o.api.post(`${API}/members/${emp.memberId}/reactivate`).send({}).expect(200);
    expect(re.body.data.status).toBe('active');
    expect(re.body.data.deactivatedAt).toBeNull();
  });

  it('suspend and last-owner protection (EMP-13)', async () => {
    const o = await registerOrg(t);
    const emp = await addMember(t, o, { role: 'employee' });
    const s = await o.api.post(`${API}/members/${emp.memberId}/suspend`).send({ reason: 'Investigation' }).expect(200);
    expect(s.body.data.status).toBe('suspended');
    expect(s.body.data.statusReason).toBe('Investigation');
    await o.api.post(`${API}/members/${emp.memberId}/suspend`).send({}).expect(409);
    await o.api.post(`${API}/members/${emp.memberId}/reactivate`).send({}).expect(200);
    const admin = await addMember(t, o, { role: 'admin' });
    await admin.api.post(`${API}/members/${o.memberId}/deactivate`).send({}).expect(403);
  });

  it('seat limit on add employee (SUB-17)', async () => {
    const o = await registerOrg(t);
    await useFreePlan(o.orgId);
    await o.api.post(`${API}/members`).send({ email: email(), firstName: 'A', roleId: o.roles.employee }).expect(201);
    await o.api.post(`${API}/members`).send({ email: email(), firstName: 'B', roleId: o.roles.employee }).expect(201);
    const r = await o.api.post(`${API}/members`).send({ email: email(), firstName: 'C', roleId: o.roles.employee });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SEAT_LIMIT_REACHED');
    // client role does not use seats
    await o.api.post(`${API}/members`).send({ email: email(), firstName: 'Cl', roleId: o.roles.client }).expect(201);
  });
});

describe('Members — tabs', () => {
  it('activity, work history, devices, performance, attendance (EMP-17…EMP-20, ATT-19)', async () => {
    const o = await registerOrg(t);
    const emp = await addMember(t, o, { role: 'employee' });
    const other = await addMember(t, o, { role: 'employee' });
    await db.query(
      `INSERT INTO daily_summaries (organization_id, member_id, date, tracked_seconds, active_seconds, productive_seconds, unproductive_seconds)
       VALUES ($1,$2,'2026-03-02',28800,21600,14400,3600), ($1,$2,'2026-03-03',14400,7200,3600,3600)`,
      [o.orgId, emp.memberId],
    );
    await db.query(
      `INSERT INTO time_entries (organization_id, member_id, started_at, ended_at, duration_seconds, status) VALUES ($1,$2,'2026-03-02T09:00:00Z','2026-03-02T17:00:00Z',28800,'completed')`,
      [o.orgId, emp.memberId],
    );
    await db.query(
      `INSERT INTO attendance_records (organization_id, member_id, date, status, late_minutes, worked_seconds) VALUES ($1,$2,'2026-03-02','late',15,28800), ($1,$2,'2026-03-04','absent',0,0)`,
      [o.orgId, emp.memberId],
    );
    await db.query(`INSERT INTO devices (organization_id, member_id, machine_id_hash, os, app_version, pending_count) VALUES ($1,$2,'m1','windows','1.2.0',3)`, [o.orgId, emp.memberId]);
    const q = '?from=2026-03-01&to=2026-03-31';

    const act = await o.api.get(`${API}/members/${emp.memberId}/activity${q}`).expect(200);
    expect(act.body.data.totals.trackedSeconds).toBe(43200);
    expect(act.body.data.totals.activityPercent).toBe(67);
    expect(act.body.data.daily).toHaveLength(2);

    const wh = await o.api.get(`${API}/members/${emp.memberId}/work-history${q}`).expect(200);
    const d2 = wh.body.data.days.find((d) => d.date === '2026-03-02');
    expect(d2.entries).toHaveLength(1);
    expect(d2.attendance.status).toBe('late');
    expect(wh.body.data.totalTrackedSeconds).toBe(43200);

    const dev = await o.api.get(`${API}/members/${emp.memberId}/devices`).expect(200);
    expect(dev.body.data[0]).toMatchObject({ os: 'windows', appVersion: '1.2.0', syncStatus: 'pending' });

    const perf = await o.api.get(`${API}/members/${emp.memberId}/performance${q}`).expect(200);
    expect(perf.body.data.trackedSeconds).toBe(43200);
    expect(perf.body.data.attendance).toMatchObject({ lateDays: 1, absentDays: 1 });
    expect(typeof perf.body.data.score).toBe('number');

    const att = await o.api.get(`${API}/members/${emp.memberId}/attendance${q}`).expect(200);
    expect(att.body.data.summary).toMatchObject({ late: 1, absent: 1, lateMinutes: 15 });

    // scope: employee can see own tabs, not others'
    await emp.api.get(`${API}/members/${emp.memberId}/activity${q}`).expect(200);
    await other.api.get(`${API}/members/${emp.memberId}/activity${q}`).expect(403);
    await other.api.get(`${API}/members/${emp.memberId}/devices`).expect(403);
    await o.api.get(`${API}/members/${emp.memberId}/activity?from=2026-03-10&to=2026-03-01`).expect(400);
  });
});

describe('Members — bulk import (EMP-22)', () => {
  it('validates CSV with per-row errors, previews and commits', async () => {
    const o = await registerOrg(t);
    const existing = await addMember(t, o, { role: 'employee' });
    const a = email('imp');
    const b = email('imp');
    const csv = [
      'Email,First Name,Last Name,Employee Code,Designation,Department,Team,Role,Employment Type,Joined On,Weekly Hours,Hourly Rate',
      `${a},Alice,Smith,IMP-1,Dev,Engineering,Core,employee,Full-time,2026-02-01,40,25`,
      `${b},Bob,,,QA,Engineering,Core,manager,part_time,,20,`,
      `not-an-email,Carl,,,,,,,,,,`,
      `${existing.email},Dup,,,,,,,,,,`,
      `${a},Again,,,,,,,,,,`,
      `${email('imp')},Zed,,,,,,superhero,weird,2026-13-45,500,`,
    ].join('\n');
    const up = await o.api.post(`${API}/members/import`).attach('file', Buffer.from(csv), 'people.csv').expect(201);
    const job = up.body.data;
    expect(job.rowsTotal).toBe(6);
    expect(job.rowsValid).toBe(2);
    expect(job.errors.some((e) => e.row === 4 && e.field === 'email')).toBe(true);
    expect(job.errors.some((e) => e.row === 5 && /Already a member/.test(e.message))).toBe(true);
    expect(job.errors.some((e) => e.row === 6 && /Duplicate/.test(e.message))).toBe(true);
    expect(job.errors.filter((e) => e.row === 7).map((e) => e.field).sort()).toEqual(['employmentType', 'joinedOn', 'role', 'weeklyHours']);

    const prev = await o.api.get(`${API}/members/import/${job.id}`).expect(200);
    expect(prev.body.data.status).toBe('validated');

    const commit = await o.api.post(`${API}/members/import/${job.id}/commit`).expect(200);
    expect(commit.body.data.status).toBe('committed');
    expect(commit.body.data.result.created).toBe(2);
    const alice = await db.one(
      `SELECT m.*, d.name AS dept FROM organization_members m JOIN users u ON u.id = m.user_id LEFT JOIN departments d ON d.id = m.department_id WHERE u.email = $1 AND m.organization_id = $2`,
      [a, o.orgId],
    );
    expect(alice).toMatchObject({ status: 'invited', employee_code: 'IMP-1', dept: 'Engineering', employment_type: 'full_time', joined_on: '2026-02-01' });
    const teams = await db.many(`SELECT name FROM teams WHERE organization_id = $1`, [o.orgId]);
    expect(teams.map((x) => x.name)).toEqual(['Core']);
    const core = await db.one(`SELECT count(*)::int n FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.name = 'Core' AND t.organization_id = $1`, [o.orgId]);
    expect(core.n).toBe(2);
    expect((await db.one(`SELECT count(*)::int n FROM member_rates WHERE member_id = $1`, [alice.id])).n).toBe(1);
    expect((await db.one(`SELECT count(*)::int n FROM invitations WHERE member_id = $1 AND status = 'pending'`, [alice.id])).n).toBe(1);
    await o.api.post(`${API}/members/import/${job.id}/commit`).expect(409);
  });

  it('accepts XLSX, enforces seat limit for the batch, template download and permissions', async () => {
    const o = await registerOrg(t);
    const tpl = await o.api.get(`${API}/members/import/template?format=csv`).expect(200);
    expect(tpl.headers['content-type']).toMatch(/text\/csv/);
    expect(tpl.text.split('\n')[0]).toMatch(/^email,firstName,lastName/);
    const x = await o.api.get(`${API}/members/import/template?format=xlsx`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['email', 'firstName', 'lastName', 'joinedOn']);
    for (let i = 0; i < 3; i++) ws.addRow([email('xl'), `X${i}`, 'L', new Date(Date.UTC(2026, 0, 10))]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const up = await o.api.post(`${API}/members/import`).attach('file', buf, 'people.xlsx').expect(201);
    expect(up.body.data.rowsValid).toBe(3);
    expect(up.body.data.rows[0].data.joinedOn).toBe('2026-01-10');

    await useFreePlan(o.orgId); // 3 seats, owner uses 1
    const fail = await o.api.post(`${API}/members/import/${up.body.data.id}/commit`);
    expect(fail.status).toBe(403);
    expect(fail.body.error.code).toBe('SEAT_LIMIT_REACHED');

    await o.api.post(`${API}/members/import`).attach('file', Buffer.from('foo'), 'x.pdf').expect(400);
    await o.api.post(`${API}/members/import`).attach('file', Buffer.from('name\nx'), 'x.csv').expect(400);
    await o.api.post(`${API}/members/import`).expect(400);
    const emp = await addMember(t, o, { role: 'employee' });
    await emp.api.get(`${API}/members/import/template`).expect(403);
    const other = await registerOrg(t);
    await other.api.get(`${API}/members/import/${up.body.data.id}`).expect(404);
  });
});

