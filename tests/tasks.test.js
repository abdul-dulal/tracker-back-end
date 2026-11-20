import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';
import { runCron } from '../src/lib/jobs.js';

let t;
let owner;
let manager;
let emp;
let emp2;
let project;
beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  manager = await addMember(t, owner, { role: 'manager' });
  emp = await addMember(t, owner, { role: 'employee', firstName: 'Eve' });
  emp2 = await addMember(t, owner, { role: 'employee', firstName: 'Ed' });
  project = await newProject();
});

let n = 0;
async function newProject(extra = {}) {
  const res = await owner.api.post('/api/v1/projects').send({
    name: `Tasks project ${++n}-${Date.now()}`,
    members: [{ memberId: manager.memberId, role: 'manager' }, { memberId: emp.memberId }, { memberId: emp2.memberId }],
    ...extra,
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data;
}
const mkTask = async (api, body) => {
  const res = await api.post('/api/v1/tasks').send({ projectId: project.id, ...body });
  if (res.status !== 201) throw new Error(`create task ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const columns = async (projectId = project.id) => (await owner.api.get(`/api/v1/projects/${projectId}/columns`).expect(200)).body.data;
const col = async (cat, projectId) => (await columns(projectId)).find((c) => c.category === cat);
const notifs = (userId, type) => db.many('SELECT * FROM notifications WHERE recipient_user_id = $1 AND type = $2', [userId, type]);
const today = (d = 0) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);

describe('Tasks (M10)', () => {
  it('creates, reads, updates and deletes tasks with assignees and labels (TASK-01..15)', async () => {
    const task = await mkTask(manager.api, {
      title: 'Build login',
      description: '<p>Hi</p><script>alert(1)</script><a href="#" onclick="x()">l</a>',
      priority: 'urgent',
      startDate: '2026-02-01',
      dueDate: '2026-02-10',
      estimatedHours: 5,
      assigneeIds: [emp.memberId, emp2.memberId],
      newLabels: [{ name: 'Frontend', color: '#ff0000' }],
    });
    expect(task.status).toBe('todo');
    expect(task.assignees.map((a) => a.memberId).sort()).toEqual([emp.memberId, emp2.memberId].sort());
    expect(task.labels.map((l) => l.name)).toEqual(['Frontend']);
    expect((await notifs(emp.user.id, 'task.assigned')).some((x) => x.data.taskId === task.id)).toBe(true);

    const d = (await emp.api.get(`/api/v1/tasks/${task.id}`).expect(200)).body.data;
    expect(d.description).not.toMatch(/script|onclick/);
    expect(d.estimatedHours).toBe(5);
    expect(d.actualHours).toBe(0);

    const u = await manager.api.patch(`/api/v1/tasks/${task.id}`).send({ title: 'Build login page', priority: 'high', assigneeIds: [emp.memberId] }).expect(200);
    expect(u.body.data.title).toBe('Build login page');
    expect(u.body.data.assignees.map((a) => a.memberId)).toEqual([emp.memberId]);

    // assignee must have project access
    const outsider = await addMember(t, owner, { role: 'employee' });
    const bad = await manager.api.put(`/api/v1/tasks/${task.id}/assignees`).send({ memberIds: [outsider.memberId] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('ASSIGNEE_NO_ACCESS');

    // validation
    await manager.api.post('/api/v1/tasks').send({ projectId: project.id, title: '' }).expect(400);
    await manager.api.post('/api/v1/tasks').send({ title: 'no project' }).expect(400);
    await manager.api.patch(`/api/v1/tasks/${task.id}`).send({ dueDate: '2026-01-01' }).expect(400);

    const act = (await owner.api.get(`/api/v1/tasks/${task.id}/activity`).expect(200)).body.data;
    expect(act.map((a) => a.action)).toEqual(expect.arrayContaining(['created', 'updated', 'assignees_changed']));

    await manager.api.delete(`/api/v1/tasks/${task.id}`).expect(204);
    await manager.api.get(`/api/v1/tasks/${task.id}`).expect(404);
  });

  it('employees update only their own tasks (status/progress) and cannot delete', async () => {
    const mine = await mkTask(owner.api, { title: 'Mine', assigneeIds: [emp.memberId] });
    const theirs = await mkTask(owner.api, { title: 'Theirs', assigneeIds: [emp2.memberId] });
    const inProgress = await col('in_progress');
    const r1 = await emp.api.patch(`/api/v1/tasks/${mine.id}`).send({ progress: 40, columnId: inProgress.id }).expect(200);
    expect(r1.body.data).toMatchObject({ progress: 40, status: 'in_progress' });
    const r2 = await emp.api.patch(`/api/v1/tasks/${mine.id}`).send({ title: 'Renamed' });
    expect(r2.status).toBe(403);
    expect(r2.body.error.code).toBe('TASK_FIELDS_RESTRICTED');
    await emp.api.patch(`/api/v1/tasks/${theirs.id}`).send({ progress: 10 }).expect(403);
    await emp.api.patch(`/api/v1/tasks/${theirs.id}/move`).send({ columnId: inProgress.id }).expect(403);
    await emp.api.delete(`/api/v1/tasks/${mine.id}`).expect(403);
    // employee can create tasks in their project, but not in other projects
    await mkTask(emp.api, { title: 'Self-created', assigneeIds: [emp.memberId] });
    const other = await (await owner.api.post('/api/v1/projects').send({ name: `Hidden ${Date.now()}` })).body.data;
    await emp.api.post('/api/v1/tasks').send({ projectId: other.id, title: 'x' }).expect(403);
    await emp.api.get(`/api/v1/tasks?projectId=${other.id}`).expect(200).then((r) => expect(r.body.data).toEqual([]));
    // project manager can edit any task in the project
    await manager.api.patch(`/api/v1/tasks/${theirs.id}`).send({ title: 'Edited by PM' }).expect(200);
  });

  it('detects dependency cycles (TASK-18)', async () => {
    const a = await mkTask(owner.api, { title: 'A' });
    const b = await mkTask(owner.api, { title: 'B' });
    const c = await mkTask(owner.api, { title: 'C' });
    await owner.api.post(`/api/v1/tasks/${b.id}/dependencies`).send({ dependsOnTaskId: a.id }).expect(201);
    await owner.api.post(`/api/v1/tasks/${c.id}/dependencies`).send({ dependsOnTaskId: b.id }).expect(201);
    const cyc = await owner.api.post(`/api/v1/tasks/${a.id}/dependencies`).send({ dependsOnTaskId: c.id });
    expect(cyc.status).toBe(422);
    expect(cyc.body.error.code).toBe('DEPENDENCY_CYCLE');
    const self = await owner.api.post(`/api/v1/tasks/${a.id}/dependencies`).send({ dependsOnTaskId: a.id });
    expect(self.body.error.code).toBe('DEPENDENCY_CYCLE');
    const otherProject = await newProject();
    const x = (await owner.api.post('/api/v1/tasks').send({ projectId: otherProject.id, title: 'X' }).expect(201)).body.data;
    await owner.api.post(`/api/v1/tasks/${a.id}/dependencies`).send({ dependsOnTaskId: x.id }).expect(422);
    const deps = (await owner.api.get(`/api/v1/tasks/${b.id}/dependencies`).expect(200)).body.data;
    expect(deps.blockedBy.map((d) => d.id)).toEqual([a.id]);
    expect(deps.blocking.map((d) => d.id)).toEqual([c.id]);
    await owner.api.delete(`/api/v1/tasks/${c.id}/dependencies/${b.id}`).expect(204);
    await owner.api.post(`/api/v1/tasks/${a.id}/dependencies`).send({ dependsOnTaskId: c.id }).expect(201);
  });

  it('blocks completion while blockers are unfinished; completion sets completed_at (TASK-22)', async () => {
    const blocker = await mkTask(owner.api, { title: 'Blocker' });
    const task = await mkTask(owner.api, { title: 'Blocked', assigneeIds: [emp.memberId] });
    await owner.api.post(`/api/v1/tasks/${task.id}/dependencies`).send({ dependsOnTaskId: blocker.id }).expect(201);
    const done = await col('done');
    const res = await emp.api.patch(`/api/v1/tasks/${task.id}/move`).send({ columnId: done.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TASK_BLOCKED');
    expect((await owner.api.get(`/api/v1/tasks/${task.id}`)).body.data.isBlocked).toBe(true);
    await owner.api.patch(`/api/v1/tasks/${blocker.id}`).send({ status: 'done' }).expect(200);
    const ok = await emp.api.patch(`/api/v1/tasks/${task.id}/move`).send({ columnId: done.id }).expect(200);
    expect(ok.body.data.completedAt).toBeTruthy();
    expect(ok.body.data.status).toBe('done');
    const back = await owner.api.patch(`/api/v1/tasks/${task.id}`).send({ status: 'in_progress' }).expect(200);
    expect(back.body.data.completedAt).toBeNull();
  });

  it('supports subtasks with progress counts (TASK-17, KAN-13)', async () => {
    const parent = await mkTask(owner.api, { title: 'Parent', assigneeIds: [emp.memberId] });
    const s1 = (await owner.api.post(`/api/v1/tasks/${parent.id}/subtasks`).send({ title: 'Sub 1' }).expect(201)).body.data;
    await owner.api.post(`/api/v1/tasks/${parent.id}/subtasks`).send({ title: 'Sub 2' }).expect(201);
    expect(s1.parentTaskId).toBe(parent.id);
    await owner.api.post(`/api/v1/tasks/${s1.id}/subtasks`).send({ title: 'Too deep' }).expect(422);
    // assignee of the parent can complete subtasks
    await emp.api.patch(`/api/v1/tasks/${s1.id}`).send({ status: 'done' }).expect(200);
    const d = (await emp.api.get(`/api/v1/tasks/${parent.id}`).expect(200)).body.data;
    expect(d).toMatchObject({ subtasksDone: 1, subtasksTotal: 2, subtaskProgress: 50 });
    expect(d.subtasks.length).toBe(2);
    const list = (await emp.api.get(`/api/v1/tasks/${parent.id}/subtasks`).expect(200)).body.data;
    expect(list.map((x) => x.title)).toEqual(['Sub 1', 'Sub 2']);
  });

  it('runs review and approval (TASK-23/24)', async () => {
    const task = await mkTask(owner.api, { title: 'Review me', assigneeIds: [emp.memberId] });
    const sub = await emp.api.post(`/api/v1/tasks/${task.id}/submit-review`).send({ reviewerMemberId: manager.memberId }).expect(200);
    expect(sub.body.data).toMatchObject({ status: 'in_review', approvalStatus: 'pending' });
    expect((await notifs(manager.user.id, 'task.review_requested')).some((x) => x.data.taskId === task.id)).toBe(true);
    await emp.api.post(`/api/v1/tasks/${task.id}/approve`).send({}).expect(403);
    const rc = await manager.api.post(`/api/v1/tasks/${task.id}/request-changes`).send({ comment: 'Fix spacing' }).expect(200);
    expect(rc.body.data).toMatchObject({ status: 'in_progress', approvalStatus: 'changes_requested', commentCount: 1 });
    await emp.api.post(`/api/v1/tasks/${task.id}/submit-review`).send({}).expect(200);
    const ap = await manager.api.post(`/api/v1/tasks/${task.id}/approve`).send({}).expect(200);
    expect(ap.body.data).toMatchObject({ status: 'done', approvalStatus: 'approved' });
    expect(ap.body.data.completedAt).toBeTruthy();
    const approvals = (await notifs(emp.user.id, 'task.approved')).filter((x) => x.data.taskId === task.id);
    expect(approvals.map((x) => x.data.decision).sort()).toEqual(['approved', 'changes_requested']);
    const d = (await owner.api.get(`/api/v1/tasks/${task.id}`).expect(200)).body.data;
    expect(d.approvedBy.memberId).toBe(manager.memberId);
  });

  it('lists with filters and calendar (KAN-21/22)', async () => {
    const p = await newProject();
    const base = { projectId: p.id };
    const a = (await owner.api.post('/api/v1/tasks').send({ ...base, title: 'Alpha overdue', dueDate: today(-3), assigneeIds: [emp.memberId], priority: 'high' }).expect(201)).body.data;
    const b = (await owner.api.post('/api/v1/tasks').send({ ...base, title: 'Beta', dueDate: today(5), priority: 'low' }).expect(201)).body.data;
    const label = (await owner.api.post('/api/v1/labels').send({ name: `Bug ${Date.now()}`, projectId: p.id }).expect(201)).body.data;
    await owner.api.put(`/api/v1/tasks/${b.id}/labels`).send({ labelIds: [label.id] }).expect(200);
    const mine = (await emp.api.get(`/api/v1/tasks?assigneeId=me&projectId=${p.id}`).expect(200)).body;
    expect(mine.data.map((x) => x.id)).toEqual([a.id]);
    expect(mine.meta.total).toBe(1);
    const overdue = (await owner.api.get(`/api/v1/tasks?projectId=${p.id}&overdue=true`).expect(200)).body.data;
    expect(overdue.map((x) => x.id)).toEqual([a.id]);
    expect(overdue[0].isOverdue).toBe(true);
    expect((await owner.api.get(`/api/v1/tasks?projectId=${p.id}&labelId=${label.id}`)).body.data.map((x) => x.id)).toEqual([b.id]);
    expect((await owner.api.get(`/api/v1/tasks?projectId=${p.id}&priority=low`)).body.data.map((x) => x.id)).toEqual([b.id]);
    expect((await owner.api.get(`/api/v1/tasks?projectId=${p.id}&search=alpha`)).body.data.map((x) => x.id)).toEqual([a.id]);
    expect((await owner.api.get(`/api/v1/tasks?projectId=${p.id}&status=todo&limit=1`)).body.meta.total).toBe(2);
    const cal = (await owner.api.get(`/api/v1/tasks/calendar?from=${today(-1)}&to=${today(10)}&projectId=${p.id}`).expect(200)).body.data;
    expect(cal.map((x) => x.id)).toEqual([b.id]);
    await owner.api.get('/api/v1/tasks/calendar').expect(400);
  });

  it('manages task categories and labels (TASK-15/16)', async () => {
    const cat = (await owner.api.post('/api/v1/task-categories').send({ name: `Design ${Date.now()}`, color: '#00ff00' }).expect(201)).body.data;
    await emp.api.post('/api/v1/task-categories').send({ name: 'Nope' }).expect(403);
    const task = await mkTask(owner.api, { title: 'Categorised', categoryId: cat.id });
    expect((await owner.api.get(`/api/v1/tasks/${task.id}`)).body.data.category.name).toBe(cat.name);
    await owner.api.patch(`/api/v1/task-categories/${cat.id}`).send({ name: `${cat.name} 2` }).expect(200);
    const list = (await emp.api.get('/api/v1/task-categories').expect(200)).body.data;
    expect(list.find((c) => c.id === cat.id).taskCount).toBe(1);
    await owner.api.delete(`/api/v1/task-categories/${cat.id}`).expect(204);

    const orgLabel = (await owner.api.post('/api/v1/labels').send({ name: `Org ${Date.now()}` }).expect(201)).body.data;
    const labels = (await emp.api.get(`/api/v1/labels?projectId=${project.id}`).expect(200)).body.data;
    expect(labels.map((l) => l.id)).toContain(orgLabel.id);
    await owner.api.patch(`/api/v1/labels/${orgLabel.id}`).send({ color: '#123456' }).expect(200);
    await emp.api.delete(`/api/v1/labels/${orgLabel.id}`).expect(403);
    await owner.api.delete(`/api/v1/labels/${orgLabel.id}`).expect(204);
  });

  it('reports actual vs estimated hours from time entries (TASK-12/13)', async () => {
    const task = await mkTask(owner.api, { title: 'Timed', estimatedHours: 3, assigneeIds: [emp.memberId] });
    await db.query(
      `INSERT INTO time_entries (organization_id, member_id, project_id, task_id, started_at, ended_at, duration_seconds, status, source)
       VALUES ($1,$2,$3,$4,'2026-06-01T09:00:00Z','2026-06-01T11:00:00Z',7200,'completed','manual'),
              ($1,$5,$3,$4,'2026-06-01T09:00:00Z','2026-06-01T10:00:00Z',3600,'completed','manual')`,
      [owner.orgId, emp.memberId, project.id, task.id, emp2.memberId],
    );
    const d = (await owner.api.get(`/api/v1/tasks/${task.id}`).expect(200)).body.data;
    expect(d.actualHours).toBe(3);
    expect(d.hoursVariance).toBe(0);
    const ownerView = (await owner.api.get(`/api/v1/tasks/${task.id}/time`).expect(200)).body.data;
    expect(ownerView.entries.length).toBe(2);
    const empView = (await emp.api.get(`/api/v1/tasks/${task.id}/time`).expect(200)).body.data;
    expect(empView.entries.length).toBe(1);
    expect(empView.actualHours).toBe(3);
  });

  it('sends due reminders and overdue alerts once (TASK-25/26)', async () => {
    const due = await mkTask(owner.api, { title: 'Due tomorrow', dueDate: today(1), assigneeIds: [emp.memberId] });
    const late = await mkTask(owner.api, { title: 'Late', dueDate: today(-1), assigneeIds: [emp2.memberId] });
    await runCron('tasks.due_reminders');
    await runCron('tasks.due_reminders');
    await runCron('tasks.overdue_alerts');
    await runCron('tasks.overdue_alerts');
    expect((await notifs(emp.user.id, 'task.deadline_reminder')).filter((x) => x.data.taskId === due.id).length).toBe(1);
    expect((await notifs(emp2.user.id, 'task.overdue')).filter((x) => x.data.taskId === late.id).length).toBe(1);
    expect((await notifs(manager.user.id, 'task.overdue')).filter((x) => x.data.taskId === late.id).length).toBe(1);
  });

  it('isolates organizations', async () => {
    const task = await mkTask(owner.api, { title: 'Secret' });
    const other = await registerOrg(t);
    await other.api.get(`/api/v1/tasks/${task.id}`).expect(404);
    await other.api.patch(`/api/v1/tasks/${task.id}`).send({ title: 'x' }).expect(404);
    await other.api.delete(`/api/v1/tasks/${task.id}`).expect(404);
    await other.api.post('/api/v1/tasks').send({ projectId: project.id, title: 'x' }).expect(404);
    const list = (await other.api.get('/api/v1/tasks').expect(200)).body.data;
    expect(list).toEqual([]);
  });
});
