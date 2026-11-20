import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, request, db } from './helpers.js';
import { runCron } from '../src/lib/jobs.js';

let t;
let owner;
let manager;
let emp;
let emp2;
beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  manager = await addMember(t, owner, { role: 'manager', firstName: 'Mona' });
  emp = await addMember(t, owner, { role: 'employee', firstName: 'Eve' });
  emp2 = await addMember(t, owner, { role: 'employee', firstName: 'Ed' });
});

let n = 0;
const createProject = async (api, body = {}) => {
  const res = await api.post('/api/v1/projects').send({ name: `Project ${++n}-${Date.now()}`, ...body });
  if (res.status !== 201) throw new Error(`create project failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const notifs = (userId, type) => db.many('SELECT * FROM notifications WHERE recipient_user_id = $1 AND type = $2 ORDER BY created_at', [userId, type]);

async function insertEntry({ orgId, memberId, projectId, taskId = null, start, hours, status = 'completed', billable = true, active }) {
  const startedAt = new Date(start);
  const endedAt = new Date(startedAt.getTime() + hours * 3600_000);
  const secs = Math.round(hours * 3600);
  return db.one(
    `INSERT INTO time_entries (organization_id, member_id, project_id, task_id, started_at, ended_at, duration_seconds, active_seconds, status, is_billable, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual') RETURNING id`,
    [orgId, memberId, projectId, taskId, startedAt, endedAt, secs, active ?? Math.round(secs / 2), status, billable],
  );
}

describe('Projects (M09)', () => {
  it('creates a project with seeded columns, creator as manager and notifies members (PROJ-01, KAN-01..04)', async () => {
    const p = await createProject(owner.api, {
      description: 'Website',
      priority: 'high',
      startDate: '2026-01-01',
      deadline: '2026-12-31',
      budgetType: 'hours',
      budgetValue: 100,
      hourlyRate: 50,
      members: [{ memberId: emp.memberId, role: 'member' }],
    });
    expect(p.priority).toBe('high');
    expect(p.budgetValue).toBe(100);
    expect(p.members.find((m) => m.memberId === owner.memberId).role).toBe('manager');
    const cols = await owner.api.get(`/api/v1/projects/${p.id}/columns`).expect(200);
    expect(cols.body.data.map((c) => c.category)).toEqual(['todo', 'in_progress', 'in_review', 'done']);
    expect(cols.body.data.map((c) => c.name)).toEqual(['To Do', 'In Progress', 'In Review', 'Completed']);
    expect((await notifs(emp.user.id, 'project.created')).some((x) => x.data.projectId === p.id)).toBe(true);
    // unique name per org (PROJ-05)
    const dup = await owner.api.post('/api/v1/projects').send({ name: p.name.toUpperCase() });
    expect(dup.status).toBe(409);
    // validation
    const bad = await owner.api.post('/api/v1/projects').send({ name: '', status: 'nope' });
    expect(bad.status).toBe(400);
    const badDates = await owner.api.post('/api/v1/projects').send({ name: 'Dates', startDate: '2026-05-01', deadline: '2026-04-01' });
    expect(badDates.status).toBe(400);
  });

  it('scopes project visibility: employees only see assigned projects (PROJ-28)', async () => {
    const mine = await createProject(owner.api, { members: [{ memberId: emp2.memberId }] });
    const other = await createProject(owner.api);
    const list = await emp2.api.get('/api/v1/projects?limit=100').expect(200);
    const ids = list.body.data.map((p) => p.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
    await emp2.api.get(`/api/v1/projects/${other.id}`).expect(403);
    await emp2.api.get(`/api/v1/projects/${mine.id}`).expect(200);
    const all = await owner.api.get('/api/v1/projects?limit=100').expect(200);
    expect(all.body.data.map((p) => p.id)).toEqual(expect.arrayContaining([mine.id, other.id]));
    // filters
    const f = await owner.api.get(`/api/v1/projects?memberId=${emp2.memberId}&limit=100`).expect(200);
    expect(f.body.data.map((p) => p.id)).toEqual([mine.id]);
    const s = await owner.api.get(`/api/v1/projects?search=${encodeURIComponent(other.name)}`).expect(200);
    expect(s.body.data.map((p) => p.id)).toEqual([other.id]);
  });

  it('lets a project manager edit; non-member managers and employees cannot (PROJ-02, PROJ-27)', async () => {
    const p = await createProject(owner.api, { members: [{ memberId: manager.memberId, role: 'manager' }, { memberId: emp.memberId }] });
    const upd = await manager.api.patch(`/api/v1/projects/${p.id}`).send({ status: 'on_hold', description: 'Paused' }).expect(200);
    expect(upd.body.data.status).toBe('on_hold');
    await emp.api.patch(`/api/v1/projects/${p.id}`).send({ description: 'x' }).expect(403);
    const other = await createProject(owner.api);
    await manager.api.patch(`/api/v1/projects/${other.id}`).send({ description: 'x' }).expect(403);
    // status change → activity + notification
    const act = await owner.api.get(`/api/v1/projects/${p.id}/activity`).expect(200);
    expect(act.body.data.some((a) => a.action === 'status_changed' && a.changes.to === 'on_hold')).toBe(true);
    expect((await notifs(emp.user.id, 'project.status')).some((x) => x.data.projectId === p.id)).toBe(true);
    // employee cannot delete
    await emp.api.delete(`/api/v1/projects/${p.id}`).expect(403);
  });

  it('archives/unarchives and soft-deletes; blocks delete with approved time unless owner forces (PROJ-03/04)', async () => {
    const p = await createProject(owner.api, { members: [{ memberId: emp.memberId }] });
    await owner.api.post(`/api/v1/projects/${p.id}/archive`).expect(200);
    const archived = await owner.api.get('/api/v1/projects?archived=true&limit=100').expect(200);
    expect(archived.body.data.map((x) => x.id)).toContain(p.id);
    const active = await owner.api.get('/api/v1/projects?limit=100').expect(200);
    expect(active.body.data.map((x) => x.id)).not.toContain(p.id);
    await owner.api.post(`/api/v1/projects/${p.id}/unarchive`).expect(200);

    await insertEntry({ orgId: owner.orgId, memberId: emp.memberId, projectId: p.id, start: '2026-03-02T09:00:00Z', hours: 2, status: 'approved' });
    const blocked = await owner.api.delete(`/api/v1/projects/${p.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PROJECT_HAS_BILLED_TIME');
    const admin = await addMember(t, owner, { role: 'admin' });
    await admin.api.delete(`/api/v1/projects/${p.id}?force=true`).expect(403);
    await owner.api.delete(`/api/v1/projects/${p.id}?force=true`).expect(204);
    await owner.api.get(`/api/v1/projects/${p.id}`).expect(404);
  });

  it('replaces members and teams (PROJ-12/13/14)', async () => {
    const p = await createProject(owner.api);
    const res = await owner.api
      .put(`/api/v1/projects/${p.id}/members`)
      .send([{ memberId: owner.memberId, role: 'manager' }, { memberId: emp2.memberId, role: 'member', billableRate: 80 }])
      .expect(200);
    expect(res.body.data.find((m) => m.memberId === emp2.memberId).billableRate).toBe(80);
    expect((await notifs(emp2.user.id, 'project.created')).some((x) => x.data.projectId === p.id)).toBe(true);
    await owner.api.put(`/api/v1/projects/${p.id}/members`).send({ members: [{ memberId: '00000000-0000-0000-0000-000000000000' }] }).expect(400);
    const team = await db.one(`INSERT INTO teams (organization_id, name) VALUES ($1, $2) RETURNING id`, [owner.orgId, `Team ${Date.now()}`]);
    await db.query('INSERT INTO team_members (team_id, member_id) VALUES ($1,$2)', [team.id, emp.memberId]);
    await owner.api.put(`/api/v1/projects/${p.id}/teams`).send({ teamIds: [team.id] }).expect(200);
    // emp gets access through the team
    await emp.api.get(`/api/v1/projects/${p.id}`).expect(200);
    const byTeam = await owner.api.get(`/api/v1/projects?teamId=${team.id}`).expect(200);
    expect(byTeam.body.data.map((x) => x.id)).toEqual([p.id]);
  });

  it('computes stats: hours, cost, revenue, budget, per member/task and progress (PROJ-10/16/17/18)', async () => {
    const p = await createProject(owner.api, {
      budgetType: 'amount',
      budgetValue: 1000,
      hourlyRate: 50,
      members: [{ memberId: emp.memberId, role: 'member', billableRate: 100 }, { memberId: emp2.memberId }],
    });
    await db.query(`INSERT INTO member_rates (organization_id, member_id, rate_type, amount, currency, effective_from) VALUES ($1,$2,'cost',20,'USD','2026-01-01')`, [owner.orgId, emp.memberId]);
    await db.query(`INSERT INTO member_rates (organization_id, member_id, rate_type, amount, currency, effective_from, effective_to) VALUES ($1,$2,'pay',10,'USD','2025-01-01','2026-04-01')`, [owner.orgId, emp2.memberId]);
    await db.query(`INSERT INTO member_rates (organization_id, member_id, rate_type, amount, currency, effective_from) VALUES ($1,$2,'pay',30,'USD','2026-04-01')`, [owner.orgId, emp2.memberId]);
    const task = (await owner.api.post('/api/v1/tasks').send({ projectId: p.id, title: 'T1' }).expect(201)).body.data;
    await owner.api.post('/api/v1/tasks').send({ projectId: p.id, title: 'T2', status: 'done' }).expect(201);
    await insertEntry({ orgId: owner.orgId, memberId: emp.memberId, projectId: p.id, taskId: task.id, start: '2026-03-10T09:00:00Z', hours: 2 });
    await insertEntry({ orgId: owner.orgId, memberId: emp2.memberId, projectId: p.id, start: '2026-03-10T09:00:00Z', hours: 1 });
    await insertEntry({ orgId: owner.orgId, memberId: emp2.memberId, projectId: p.id, start: '2026-04-10T09:00:00Z', hours: 1, billable: false });
    await insertEntry({ orgId: owner.orgId, memberId: emp2.memberId, projectId: p.id, start: '2026-04-11T09:00:00Z', hours: 5, status: 'rejected' });

    const s = (await owner.api.get(`/api/v1/projects/${p.id}/stats`).expect(200)).body.data;
    expect(s.totalHours).toBe(4);
    expect(s.billableHours).toBe(3);
    // cost: emp 2h×20 + emp2 1h×10 (old pay) + 1h×30 (new pay) = 80
    expect(s.cost).toBe(80);
    // revenue: emp 2h×100 (member rate) + emp2 1h×50 (project rate) = 250
    expect(s.revenue).toBe(250);
    expect(s.budget).toMatchObject({ type: 'amount', value: 1000, used: 250, remaining: 750, percent: 25 });
    expect(s.progress).toBe(50);
    expect(s.perMember.find((m) => m.memberId === emp.memberId).hours).toBe(2);
    expect(s.perTask[0]).toMatchObject({ taskId: task.id, hours: 2 });
    const ranged = (await owner.api.get(`/api/v1/projects/${p.id}/stats?from=2026-04-01&to=2026-04-30`).expect(200)).body.data;
    expect(ranged.totalHours).toBe(1);
    expect(ranged.budget.used).toBe(250); // budget is all-time

    // manual progress override
    await owner.api.patch(`/api/v1/projects/${p.id}`).send({ progressMode: 'manual', progressManual: 90 }).expect(200);
    const d = (await owner.api.get(`/api/v1/projects/${p.id}`).expect(200)).body.data;
    expect(d.progress).toBe(90);
    expect(d.completionPercent).toBe(90);
    expect(d.totalHours).toBe(4);

    const perf = (await owner.api.get(`/api/v1/projects/${p.id}/members/performance`).expect(200)).body.data;
    const ep = perf.find((m) => m.memberId === emp.memberId);
    expect(ep.hours).toBe(2);
    expect(ep.avgActivity).toBe(50);
    // employees see stats without money
    const es = (await emp.api.get(`/api/v1/projects/${p.id}/stats`).expect(200)).body.data;
    expect(es.cost).toBeNull();
  });

  it('sends budget alerts once per threshold via cron (PROJ-10)', async () => {
    const p = await createProject(owner.api, { budgetType: 'hours', budgetValue: 10, members: [{ memberId: manager.memberId, role: 'manager' }, { memberId: emp.memberId }] });
    await insertEntry({ orgId: owner.orgId, memberId: emp.memberId, projectId: p.id, start: '2026-05-04T08:00:00Z', hours: 8.5 });
    await runCron('projects.budget_alerts');
    let mgr = (await notifs(manager.user.id, 'project.budget')).filter((x) => x.data.projectId === p.id);
    expect(mgr.length).toBe(1);
    expect(mgr[0].data.threshold).toBe(80);
    expect((await notifs(owner.user.id, 'project.budget')).filter((x) => x.data.projectId === p.id).length).toBe(1);
    expect((await notifs(emp.user.id, 'project.budget')).length).toBe(0);
    await runCron('projects.budget_alerts');
    mgr = (await notifs(manager.user.id, 'project.budget')).filter((x) => x.data.projectId === p.id);
    expect(mgr.length).toBe(1);
    await insertEntry({ orgId: owner.orgId, memberId: emp.memberId, projectId: p.id, start: '2026-05-05T08:00:00Z', hours: 2 });
    await runCron('projects.budget_alerts');
    mgr = (await notifs(manager.user.id, 'project.budget')).filter((x) => x.data.projectId === p.id);
    expect(mgr.map((x) => x.data.threshold)).toEqual([80, 100]);
    const row = await db.one('SELECT budget_alerts_sent FROM projects WHERE id = $1', [p.id]);
    expect(row.budget_alerts_sent.map(Number)).toEqual([80, 100]);
  });

  it('sends project deadline alerts (PROJ-26)', async () => {
    const soon = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    const past = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    const a = await createProject(owner.api, { deadline: soon, members: [{ memberId: emp.memberId }] });
    const b = await createProject(owner.api, { startDate: '2026-01-01', deadline: past, members: [{ memberId: manager.memberId, role: 'manager' }] });
    await runCron('projects.deadline_alerts');
    await runCron('projects.deadline_alerts');
    expect((await notifs(emp.user.id, 'project.deadline')).filter((x) => x.data.projectId === a.id && x.data.kind === 'upcoming').length).toBe(1);
    expect((await notifs(manager.user.id, 'project.deadline')).filter((x) => x.data.projectId === b.id && x.data.kind === 'overdue').length).toBe(1);
  });

  it('manages notes (PROJ-22)', async () => {
    const p = await createProject(owner.api, { members: [{ memberId: emp.memberId }] });
    const n1 = (await owner.api.post(`/api/v1/projects/${p.id}/notes`).send({ title: 'Kickoff', body: 'Agenda' }).expect(201)).body.data;
    const n2 = (await owner.api.post(`/api/v1/projects/${p.id}/notes`).send({ body: 'Pinned', isPinned: true }).expect(201)).body.data;
    const list = (await emp.api.get(`/api/v1/projects/${p.id}/notes`).expect(200)).body.data;
    expect(list[0].id).toBe(n2.id);
    await emp.api.post(`/api/v1/projects/${p.id}/notes`).send({ body: 'x' }).expect(403);
    const u = await owner.api.patch(`/api/v1/projects/${p.id}/notes/${n1.id}`).send({ isPinned: true, body: 'Agenda v2' }).expect(200);
    expect(u.body.data).toMatchObject({ isPinned: true, body: 'Agenda v2' });
    await owner.api.delete(`/api/v1/projects/${p.id}/notes/${n1.id}`).expect(204);
    await owner.api.patch(`/api/v1/projects/${p.id}/notes/${n1.id}`).send({ body: 'x' }).expect(404);
  });

  it('comments with mentions notify mentioned members and task assignees (PROJ-21, TASK-19)', async () => {
    const p = await createProject(owner.api, { members: [{ memberId: emp.memberId }, { memberId: emp2.memberId }] });
    const c = (await emp.api.post('/api/v1/comments').send({ entityType: 'project', entityId: p.id, body: 'Hi @Ed', mentions: [emp2.memberId] }).expect(201)).body.data;
    expect(c.author.memberId).toBe(emp.memberId);
    expect((await notifs(emp2.user.id, 'task.comment')).some((x) => x.data.commentId === c.id && x.data.mention)).toBe(true);

    const task = (await owner.api.post('/api/v1/tasks').send({ projectId: p.id, title: 'Design', assigneeIds: [emp.memberId] }).expect(201)).body.data;
    const tc = (await owner.api.post('/api/v1/comments').send({ entityType: 'task', entityId: task.id, body: 'Looks good', mentions: [emp2.memberId] }).expect(201)).body.data;
    expect((await notifs(emp.user.id, 'task.comment')).some((x) => x.data.commentId === tc.id)).toBe(true);
    expect((await notifs(emp2.user.id, 'task.comment')).some((x) => x.data.commentId === tc.id)).toBe(true);

    const list = (await emp2.api.get(`/api/v1/comments?entityType=task&entityId=${task.id}`).expect(200)).body.data;
    expect(list.map((x) => x.id)).toEqual([tc.id]);
    // only author/admin can edit/delete
    await emp2.api.patch(`/api/v1/comments/${tc.id}`).send({ body: 'hacked' }).expect(403);
    await emp.api.patch(`/api/v1/comments/${c.id}`).send({ body: 'Hi Ed!' }).expect(200);
    await owner.api.delete(`/api/v1/comments/${c.id}`).expect(204);
    // card comment count (KAN-14)
    const card = (await owner.api.get(`/api/v1/tasks/${task.id}`).expect(200)).body.data;
    expect(card.commentCount).toBe(1);
    // outsider employee cannot comment
    const outsider = await addMember(t, owner, { role: 'employee' });
    await outsider.api.post('/api/v1/comments').send({ entityType: 'project', entityId: p.id, body: 'x' }).expect(403);
  });

  it('uploads, lists, downloads and deletes attachments (PROJ-20, TASK-20)', async () => {
    const p = await createProject(owner.api, { members: [{ memberId: emp.memberId }] });
    const up = (await owner.api.post('/api/v1/attachments/upload-url').send({ entityType: 'project', entityId: p.id, fileName: 'spec.pdf', contentType: 'application/pdf', size: 11 }).expect(200)).body.data;
    const u = new URL(up.uploadUrl);
    await request(t.app).put(`${u.pathname}${u.search}`).set('Content-Type', 'application/pdf').send(Buffer.from('hello world')).expect(200);
    const a = (await owner.api.post('/api/v1/attachments').send({ key: up.key, entityType: 'project', entityId: p.id, fileName: 'spec.pdf' }).expect(201)).body.data;
    expect(a).toMatchObject({ fileName: 'spec.pdf', size: 11, contentType: 'application/pdf' });
    // not-uploaded key
    const up2 = (await owner.api.post('/api/v1/attachments/upload-url').send({ entityType: 'project', entityId: p.id, fileName: 'x.pdf', contentType: 'application/pdf', size: 5 }).expect(200)).body.data;
    const bad = await owner.api.post('/api/v1/attachments').send({ key: up2.key, entityType: 'project', entityId: p.id, fileName: 'x.pdf' });
    expect(bad.body.error.code).toBe('FILE_NOT_UPLOADED');
    // employee can view but not attach to the project (needs projects.update)
    const list = (await emp.api.get(`/api/v1/attachments?entityType=project&entityId=${p.id}`).expect(200)).body.data;
    expect(list.map((x) => x.id)).toEqual([a.id]);
    await emp.api.post('/api/v1/attachments/upload-url').send({ entityType: 'project', entityId: p.id, fileName: 'a.pdf', contentType: 'application/pdf', size: 5 }).expect(403);
    const dl = (await emp.api.get(`/api/v1/attachments/${a.id}/download`).expect(200)).body.data;
    const du = new URL(dl.url);
    const file = await request(t.app).get(`${du.pathname}${du.search}`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(file.body.toString()).toBe('hello world');
    await emp.api.delete(`/api/v1/attachments/${a.id}`).expect(403);
    await owner.api.delete(`/api/v1/attachments/${a.id}`).expect(204);
    expect((await owner.api.get(`/api/v1/attachments?entityType=project&entityId=${p.id}`).expect(200)).body.data).toEqual([]);
  });

  it('isolates organizations', async () => {
    const p = await createProject(owner.api);
    const other = await registerOrg(t);
    await other.api.get(`/api/v1/projects/${p.id}`).expect(404);
    await other.api.patch(`/api/v1/projects/${p.id}`).send({ name: 'x' }).expect(404);
    await other.api.get(`/api/v1/projects/${p.id}/stats`).expect(404);
    await other.api.get(`/api/v1/comments?entityType=project&entityId=${p.id}`).expect(404);
    const list = await other.api.get('/api/v1/projects').expect(200);
    expect(list.body.data.map((x) => x.id)).not.toContain(p.id);
  });
});
