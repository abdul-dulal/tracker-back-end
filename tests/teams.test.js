import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';

let t;
beforeAll(async () => {
  t = await setupApp();
});

const API = '/api/v1';

describe('Departments (TEAM-01)', () => {
  it('CRUD with head, parent, cycle protection and permissions', async () => {
    const o = await registerOrg(t);
    const emp = await addMember(t, o, { role: 'employee' });
    const eng = await o.api.post(`${API}/departments`).send({ name: 'Engineering', headMemberId: o.memberId }).expect(201);
    expect(eng.body.data.head.id).toBe(o.memberId);
    const be = await o.api.post(`${API}/departments`).send({ name: 'Backend', parentId: eng.body.data.id }).expect(201);
    expect(be.body.data.parentName).toBe('Engineering');
    await o.api.post(`${API}/departments`).send({ name: 'engineering' }).expect(409); // unique name (ci)
    await o.api.patch(`${API}/departments/${eng.body.data.id}`).send({ parentId: be.body.data.id }).expect(400); // cycle
    await o.api.patch(`${API}/departments/${eng.body.data.id}`).send({ parentId: eng.body.data.id }).expect(400);
    const upd = await o.api.patch(`${API}/departments/${eng.body.data.id}`).send({ description: 'Builders', headMemberId: null }).expect(200);
    expect(upd.body.data).toMatchObject({ description: 'Builders', head: null });

    await o.api.patch(`${API}/members/${emp.memberId}`).send({ departmentId: be.body.data.id }).expect(200);
    const list = await emp.api.get(`${API}/departments`).expect(200); // teams.view
    expect(list.body.data.find((d) => d.name === 'Backend').memberCount).toBe(1);
    await emp.api.post(`${API}/departments`).send({ name: 'Nope' }).expect(403);

    await o.api.delete(`${API}/departments/${be.body.data.id}`).expect(204);
    expect((await db.one('SELECT department_id FROM organization_members WHERE id = $1', [emp.memberId])).department_id).toBeNull();
    await o.api.get(`${API}/departments/${be.body.data.id}`).expect(404);
    const other = await registerOrg(t);
    await other.api.get(`${API}/departments/${eng.body.data.id}`).expect(404);
    await other.api.post(`${API}/departments`).send({ name: 'X', parentId: eng.body.data.id }).expect(400);
  });
});

describe('Teams (TEAM-02…TEAM-13)', () => {
  it('create, members (bulk), leaders, managers, edit, delete', async () => {
    const o = await registerOrg(t);
    const e1 = await addMember(t, o, { role: 'employee' });
    const e2 = await addMember(t, o, { role: 'employee' });
    const sched = (await db.one(`SELECT id FROM work_schedules WHERE organization_id = $1`, [o.orgId])).id;
    const team = await o.api.post(`${API}/teams`).send({ name: 'Alpha', description: 'First', color: '#123456', workScheduleId: sched, memberIds: [e1.memberId], leaderIds: [e1.memberId] }).expect(201);
    const id = team.body.data.id;
    expect(team.body.data).toMatchObject({ memberCount: 1, workScheduleId: sched });
    expect(team.body.data.leaders[0].id).toBe(e1.memberId);

    const add = await o.api.post(`${API}/teams/${id}/members`).send({ memberIds: [e1.memberId, e2.memberId] }).expect(200);
    expect(add.body.data.added).toBe(1);
    await o.api.post(`${API}/teams/${id}/members`).send({ memberIds: ['00000000-0000-0000-0000-000000000000'] }).expect(400);
    const lead = await o.api.patch(`${API}/teams/${id}/members/${e2.memberId}`).send({ isLeader: true }).expect(200);
    expect(lead.body.data.isLeader).toBe(true);

    const detail = await e1.api.get(`${API}/teams/${id}`).expect(200);
    expect(detail.body.data.members).toHaveLength(2);
    expect(detail.body.data.canManage).toBe(false);

    // team leader (employee role) sees team member via managedMemberIds
    await e1.api.get(`${API}/members/${e2.memberId}`).expect(403); // employee role has members.view own only

    const ren = await o.api.patch(`${API}/teams/${id}`).send({ name: 'Alpha Squad', departmentId: null }).expect(200);
    expect(ren.body.data.name).toBe('Alpha Squad');
    await o.api.delete(`${API}/teams/${id}/members/${e2.memberId}`).expect(204);
    await o.api.delete(`${API}/teams/${id}/members/${e2.memberId}`).expect(400);
    const bulk = await o.api.delete(`${API}/teams/${id}/members`).send({ memberIds: [e1.memberId] }).expect(200);
    expect(bulk.body.data.removed).toBe(1);

    const list = await o.api.get(`${API}/teams?search=alpha`).expect(200);
    expect(list.body.meta.total).toBe(1);
    await o.api.delete(`${API}/teams/${id}`).expect(204);
    await o.api.get(`${API}/teams/${id}`).expect(404);
    await o.api.post(`${API}/teams`).send({ name: '' }).expect(400);
  });

  it('manager scope: only manages teams they manage', async () => {
    const o = await registerOrg(t);
    const mgr = await addMember(t, o, { role: 'manager' });
    const emp = await addMember(t, o, { role: 'employee' });
    const mine = (await o.api.post(`${API}/teams`).send({ name: 'Mine', managerIds: [mgr.memberId] }).expect(201)).body.data;
    const theirs = (await o.api.post(`${API}/teams`).send({ name: 'Theirs' }).expect(201)).body.data;

    await mgr.api.post(`${API}/teams/${mine.id}/members`).send({ memberIds: [emp.memberId] }).expect(200);
    await mgr.api.patch(`${API}/teams/${mine.id}`).send({ description: 'ok' }).expect(200);
    await mgr.api.post(`${API}/teams/${theirs.id}/members`).send({ memberIds: [emp.memberId] }).expect(403);
    await mgr.api.patch(`${API}/teams/${theirs.id}`).send({ description: 'no' }).expect(403);
    await mgr.api.post(`${API}/teams`).send({ name: 'New' }).expect(403); // creation needs org scope
    await mgr.api.delete(`${API}/teams/${mine.id}`).expect(403);
    const managed = await mgr.api.get(`${API}/teams?managed=true`).expect(200);
    expect(managed.body.data.map((x) => x.id)).toEqual([mine.id]);
    // employee: view only
    await emp.api.get(`${API}/teams`).expect(200);
    await emp.api.post(`${API}/teams/${mine.id}/members`).send({ memberIds: [emp.memberId] }).expect(403);
    // manager now sees the member through the team
    await mgr.api.get(`${API}/members/${emp.memberId}`).expect(200);
    // org isolation
    const other = await registerOrg(t);
    await other.api.get(`${API}/teams/${mine.id}`).expect(404);
    await other.api.post(`${API}/teams/${mine.id}/members`).send({ memberIds: [other.memberId] }).expect(404);
  });

  it('team-wise project assignment (TEAM-13)', async () => {
    const o = await registerOrg(t);
    const team = (await o.api.post(`${API}/teams`).send({ name: 'Proj team' }).expect(201)).body.data;
    const p1 = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1,'P1') RETURNING id`, [o.orgId]);
    const p2 = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1,'P2') RETURNING id`, [o.orgId]);
    const r = await o.api.put(`${API}/teams/${team.id}/projects`).send({ projectIds: [p1.id, p2.id] }).expect(200);
    expect(r.body.data.projects.map((p) => p.name)).toEqual(['P1', 'P2']);
    const r2 = await o.api.put(`${API}/teams/${team.id}/projects`).send({ projectIds: [p2.id] }).expect(200);
    expect(r2.body.data.projects.map((p) => p.name)).toEqual(['P2']);
    const other = await registerOrg(t);
    const foreign = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1,'F') RETURNING id`, [other.orgId]);
    await o.api.put(`${API}/teams/${team.id}/projects`).send({ projectIds: [foreign.id] }).expect(400);
    const emp = await addMember(t, o, { role: 'employee' });
    await emp.api.put(`${API}/teams/${team.id}/projects`).send({ projectIds: [] }).expect(403);
  });

  it('stats and comparison from daily summaries (TEAM-07, TEAM-08, TEAM-10)', async () => {
    const o = await registerOrg(t);
    const e1 = await addMember(t, o, { role: 'employee' });
    const e2 = await addMember(t, o, { role: 'employee' });
    const e3 = await addMember(t, o, { role: 'employee' });
    const a = (await o.api.post(`${API}/teams`).send({ name: 'A', memberIds: [e1.memberId, e2.memberId] }).expect(201)).body.data;
    const b = (await o.api.post(`${API}/teams`).send({ name: 'B', memberIds: [e3.memberId] }).expect(201)).body.data;
    const ins = (m, date, tracked, active, prod, unprod) =>
      db.query(
        `INSERT INTO daily_summaries (organization_id, member_id, date, tracked_seconds, active_seconds, productive_seconds, unproductive_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [o.orgId, m, date, tracked, active, prod, unprod],
      );
    await ins(e1.memberId, '2026-04-01', 3600, 1800, 3000, 600);
    await ins(e2.memberId, '2026-04-01', 7200, 7200, 3600, 3600);
    await ins(e2.memberId, '2026-04-02', 3600, 3600, 0, 0);
    await ins(e3.memberId, '2026-04-01', 1800, 900, 0, 0);
    await ins(e1.memberId, '2026-05-15', 99999, 0, 0, 0); // outside range

    const s = await o.api.get(`${API}/teams/${a.id}/stats?from=2026-04-01&to=2026-04-30`).expect(200);
    expect(s.body.data.totals.trackedSeconds).toBe(14400);
    expect(s.body.data.totals.activityPercent).toBe(88);
    expect(s.body.data.members[0].member.id).toBe(e2.memberId);
    expect(s.body.data.members[0].daysWorked).toBe(2);
    expect(s.body.data.daily.map((d) => d.date)).toEqual(['2026-04-01', '2026-04-02']);
    await o.api.get(`${API}/teams/${a.id}/stats/hours?from=2026-04-01&to=2026-04-30`).expect(200);

    // employee in team sees only own row
    const es = await e1.api.get(`${API}/teams/${a.id}/stats?from=2026-04-01&to=2026-04-30`).expect(200);
    expect(es.body.data.members.map((m) => m.member.id)).toEqual([e1.memberId]);
    expect(es.body.data.totals.trackedSeconds).toBe(3600);

    const cmp = await o.api.get(`${API}/teams/compare?teamIds=${a.id},${b.id}&from=2026-04-01&to=2026-04-30`).expect(200);
    expect(cmp.body.data.teams.map((x) => [x.team.name, x.trackedSeconds, x.memberCount])).toEqual([
      ['A', 14400, 2],
      ['B', 1800, 1],
    ]);
    await o.api.get(`${API}/teams/compare?teamIds=nope`).expect(400);
    await o.api.get(`${API}/teams/${a.id}/stats?from=2026-05-01&to=2026-04-01`).expect(400);
  });
});

describe('Clients (CLI-01, CLI-18)', () => {
  it('CRUD, portal permissions, invite client user and detail', async () => {
    const o = await registerOrg(t);
    const c = await o.api.post(`${API}/clients`).send({ name: 'Acme', email: 'ap@acme.test', currency: 'EUR', hourlyRate: 120, portalPermissions: { showScreenshots: true } }).expect(201);
    const id = c.body.data.id;
    expect(c.body.data).toMatchObject({ hourlyRate: 120, currency: 'EUR', portalPermissions: { showScreenshots: true, showActivity: false, showMemberNames: true, showRates: false } });
    await o.api.post(`${API}/clients`).send({ name: 'acme' }).expect(409);
    await o.api.post(`${API}/clients`).send({ name: 'Bad', currency: 'euro' }).expect(400);
    await o.api.post(`${API}/clients`).send({ name: 'Bad2', portalPermissions: { stealth: true } }).expect(400);

    const p = await o.api.patch(`${API}/clients/${id}`).send({ portalPermissions: { showRates: true }, hourlyRate: null }).expect(200);
    expect(p.body.data.portalPermissions).toMatchObject({ showScreenshots: true, showRates: true });
    expect(p.body.data.hourlyRate).toBeNull();

    await db.query(`INSERT INTO projects (organization_id, name, client_id) VALUES ($1,'Website',$2)`, [o.orgId, id]);
    const inv = await o.api.post(`${API}/clients/${id}/invite`).send({ email: 'boss@acme.test' }).expect(201);
    const row = await db.one('SELECT i.client_id, r.slug FROM invitations i JOIN roles r ON r.id = i.role_id WHERE i.id = $1', [inv.body.data.id]);
    expect(row).toEqual({ client_id: id, slug: 'client' });
    // accept → contact listed
    const token = [...t.outbox].reverse().find((m) => m.to === 'boss@acme.test').text.match(/invite\/(inv_[A-Za-z0-9_-]+)/)[1];
    const { request } = await import('./helpers.js');
    await request(t.app).post(`${API}/invitations/token/${token}/accept`).send({ firstName: 'Boss', password: 'Passw0rd!' }).expect(200);
    const d = await o.api.get(`${API}/clients/${id}`).expect(200);
    expect(d.body.data.projectCount).toBe(1);
    expect(d.body.data.projects[0].name).toBe('Website');
    expect(d.body.data.contacts.map((x) => x.email)).toEqual(['boss@acme.test']);

    const list = await o.api.get(`${API}/clients?search=acm`).expect(200);
    expect(list.body.data).toHaveLength(1);
    // manager: view only
    const mgr = await addMember(t, o, { role: 'manager' });
    await mgr.api.get(`${API}/clients`).expect(200);
    await mgr.api.post(`${API}/clients`).send({ name: 'X' }).expect(403);
    const emp = await addMember(t, o, { role: 'employee' });
    await emp.api.get(`${API}/clients`).expect(403);
    const other = await registerOrg(t);
    await other.api.get(`${API}/clients/${id}`).expect(404);

    await o.api.delete(`${API}/clients/${id}`).expect(204);
    await o.api.get(`${API}/clients/${id}`).expect(404);
  });
});
