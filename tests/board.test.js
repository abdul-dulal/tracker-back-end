import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';

let t;
let owner;
let manager;
let emp;
beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  manager = await addMember(t, owner, { role: 'manager' });
  emp = await addMember(t, owner, { role: 'employee' });
});

let n = 0;
async function newProject() {
  const res = await owner.api.post('/api/v1/projects').send({
    name: `Board ${++n}-${Date.now()}`,
    members: [{ memberId: manager.memberId, role: 'manager' }, { memberId: emp.memberId }],
  });
  return res.body.data;
}
const cols = async (pid) => (await owner.api.get(`/api/v1/projects/${pid}/columns`).expect(200)).body.data;
const mk = async (pid, body) => (await owner.api.post('/api/v1/tasks').send({ projectId: pid, ...body }).expect(201)).body.data;
const order = async (pid, columnId) => {
  const b = (await owner.api.get(`/api/v1/projects/${pid}/board`).expect(200)).body.data;
  return b.columns.find((c) => c.id === columnId).cards.map((c) => c.title);
};

describe('Kanban board (M11)', () => {
  it('returns columns with card DTOs and supports filters (KAN-07..14, 16, 18, 19)', async () => {
    const p = await newProject();
    const c = await cols(p.id);
    const todo = c.find((x) => x.category === 'todo');
    const a = await mk(p.id, { title: 'Alpha', priority: 'urgent', dueDate: '2020-01-01', assigneeIds: [emp.memberId], newLabels: [{ name: 'UI' }] });
    await mk(p.id, { title: 'Beta', columnId: c.find((x) => x.category === 'in_progress').id });
    await owner.api.post(`/api/v1/tasks/${a.id}/subtasks`).send({ title: 'sub', status: 'done' }).expect(201);
    await owner.api.post(`/api/v1/tasks/${a.id}/subtasks`).send({ title: 'sub2' }).expect(201);
    await owner.api.post('/api/v1/comments').send({ entityType: 'task', entityId: a.id, body: 'hi' }).expect(201);

    const board = (await emp.api.get(`/api/v1/projects/${p.id}/board`).expect(200)).body.data;
    expect(board.columns.map((x) => x.name)).toEqual(['To Do', 'In Progress', 'In Review', 'Completed']);
    const todoCol = board.columns.find((x) => x.id === todo.id);
    expect(todoCol.cards.length).toBe(1); // subtasks are not board cards
    expect(todoCol.cards[0]).toMatchObject({
      title: 'Alpha',
      priority: 'urgent',
      dueDate: '2020-01-01',
      isOverdue: true,
      subtasksDone: 1,
      subtasksTotal: 2,
      commentCount: 1,
    });
    expect(todoCol.cards[0].labels[0].name).toBe('UI');
    expect(todoCol.cards[0].assignees[0]).toMatchObject({ memberId: emp.memberId });
    expect(todoCol.cards[0].assignees[0]).toHaveProperty('avatarUrl');

    const f1 = (await owner.api.get(`/api/v1/projects/${p.id}/board?assigneeId=${emp.memberId}`).expect(200)).body.data;
    expect(f1.columns.flatMap((x) => x.cards).map((x) => x.title)).toEqual(['Alpha']);
    const f2 = (await owner.api.get(`/api/v1/projects/${p.id}/board?search=bet`).expect(200)).body.data;
    expect(f2.columns.flatMap((x) => x.cards).map((x) => x.title)).toEqual(['Beta']);
    const f3 = (await emp.api.get(`/api/v1/projects/${p.id}/board?assigneeId=me&priority=urgent`).expect(200)).body.data;
    expect(f3.columns.flatMap((x) => x.cards).map((x) => x.title)).toEqual(['Alpha']);

    const outsider = await addMember(t, owner, { role: 'employee' });
    await outsider.api.get(`/api/v1/projects/${p.id}/board`).expect(403);
  });

  it('moves tasks with fractional positions and renumbers on tiny gaps (KAN-05)', async () => {
    const p = await newProject();
    const c = await cols(p.id);
    const todo = c.find((x) => x.category === 'todo');
    const prog = c.find((x) => x.category === 'in_progress');
    const A = await mk(p.id, { title: 'A' });
    const B = await mk(p.id, { title: 'B' });
    const C = await mk(p.id, { title: 'C', assigneeIds: [emp.memberId] });
    expect(await order(p.id, todo.id)).toEqual(['A', 'B', 'C']);

    await owner.api.patch(`/api/v1/tasks/${C.id}/move`).send({ columnId: todo.id, afterId: A.id }).expect(200);
    expect(await order(p.id, todo.id)).toEqual(['A', 'C', 'B']);
    await owner.api.patch(`/api/v1/tasks/${B.id}/move`).send({ columnId: todo.id, beforeId: A.id }).expect(200);
    expect(await order(p.id, todo.id)).toEqual(['B', 'A', 'C']);

    // tiny gap → renumber
    await db.query('UPDATE tasks SET position = 1 WHERE id = $1', [B.id]);
    await db.query('UPDATE tasks SET position = 1.0000000001 WHERE id = $1', [A.id]);
    await db.query('UPDATE tasks SET position = 5 WHERE id = $1', [C.id]);
    await owner.api.patch(`/api/v1/tasks/${C.id}/move`).send({ columnId: todo.id, afterId: B.id, beforeId: A.id }).expect(200);
    expect(await order(p.id, todo.id)).toEqual(['B', 'C', 'A']);
    const pos = await db.many('SELECT title, position FROM tasks WHERE project_id = $1 ORDER BY position', [p.id]);
    expect(pos.map((x) => x.position)).toEqual([1, 2, 3]);

    // cross-column move by the assignee emits realtime event
    t.emitted.length = 0;
    const moved = await emp.api.patch(`/api/v1/tasks/${C.id}/move`).send({ columnId: prog.id }).expect(200);
    expect(moved.body.data).toMatchObject({ status: 'in_progress', columnId: prog.id });
    expect(t.emitted.some((e) => e.room === `project:${p.id}` && e.event === 'board.task_moved' && e.data.id === C.id)).toBe(true);
    expect(await order(p.id, prog.id)).toEqual(['C']);

    // invalid neighbours
    await owner.api.patch(`/api/v1/tasks/${A.id}/move`).send({ columnId: prog.id, afterId: B.id }).expect(400);
    const other = await newProject();
    const otherCol = (await cols(other.id))[0];
    await owner.api.patch(`/api/v1/tasks/${A.id}/move`).send({ columnId: otherCol.id }).expect(400);
  });

  it('manages columns: create, update, reorder, delete with task relocation (KAN-06)', async () => {
    const p = await newProject();
    let c = await cols(p.id);
    const todo = c.find((x) => x.category === 'todo');
    const done = c.find((x) => x.category === 'done');
    const qa = (await manager.api.post(`/api/v1/projects/${p.id}/columns`).send({ name: 'QA', category: 'in_review', afterColumnId: c[2].id, wipLimit: 3 }).expect(201)).body.data;
    await emp.api.post(`/api/v1/projects/${p.id}/columns`).send({ name: 'Nope' }).expect(403);
    c = await cols(p.id);
    expect(c.map((x) => x.name)).toEqual(['To Do', 'In Progress', 'In Review', 'QA', 'Completed']);

    // cannot remove the only todo/done column or change its category away
    const delTodo = await owner.api.delete(`/api/v1/columns/${todo.id}`);
    expect(delTodo.status).toBe(422);
    expect(delTodo.body.error.code).toBe('COLUMN_REQUIRED');
    await owner.api.patch(`/api/v1/columns/${done.id}`).send({ category: 'in_progress' }).expect(422);
    await owner.api.patch(`/api/v1/columns/${qa.id}`).send({ name: 'Quality' }).expect(200);

    // deleting moves tasks to a same-category column
    const task = await mk(p.id, { title: 'In QA', columnId: qa.id });
    const review = c.find((x) => x.name === 'In Review');
    await owner.api.delete(`/api/v1/columns/${qa.id}`).expect(204);
    const after = (await owner.api.get(`/api/v1/tasks/${task.id}`).expect(200)).body.data;
    expect(after.columnId).toBe(review.id);

    // a second done column allows deleting the first one; tasks keep completion
    const done2 = (await owner.api.post(`/api/v1/projects/${p.id}/columns`).send({ name: 'Shipped', category: 'done' }).expect(201)).body.data;
    const finished = await mk(p.id, { title: 'Finished', columnId: done.id });
    await owner.api.delete(`/api/v1/columns/${done.id}`).expect(204);
    const f = (await owner.api.get(`/api/v1/tasks/${finished.id}`).expect(200)).body.data;
    expect(f.columnId).toBe(done2.id);
    expect(f.completedAt).toBeTruthy();

    c = await cols(p.id);
    const reversed = c.map((x) => x.id).reverse();
    const re = (await owner.api.post(`/api/v1/projects/${p.id}/columns/reorder`).send({ columnIds: reversed }).expect(200)).body.data;
    expect(re.map((x) => x.id)).toEqual(reversed);
    await owner.api.post(`/api/v1/projects/${p.id}/columns/reorder`).send({ columnIds: reversed.slice(1) }).expect(400);
  });

  it('quick-creates a task from a column (KAN-15)', async () => {
    const p = await newProject();
    const prog = (await cols(p.id)).find((x) => x.category === 'in_progress');
    const res = await emp.api.post('/api/v1/tasks').send({ title: 'Quick', columnId: prog.id }).expect(201);
    expect(res.body.data).toMatchObject({ projectId: p.id, columnId: prog.id, status: 'in_progress' });
  });

  it('cross-project board groups by status category and respects scope (KAN-17)', async () => {
    const p1 = await newProject();
    const p2 = await newProject();
    const hidden = (await owner.api.post('/api/v1/projects').send({ name: `Hidden ${Date.now()}` }).expect(201)).body.data;
    await mk(p1.id, { title: 'P1 todo' });
    await mk(p2.id, { title: 'P2 done', status: 'done' });
    await mk(hidden.id, { title: 'Hidden task' });
    const b = (await emp.api.get(`/api/v1/board?projectIds=${p1.id},${p2.id},${hidden.id}`).expect(200)).body.data;
    expect(b.columns.map((x) => x.category)).toEqual(['todo', 'in_progress', 'in_review', 'done']);
    expect(b.columns[0].cards.map((x) => x.title)).toEqual(['P1 todo']);
    expect(b.columns[3].cards.map((x) => x.title)).toEqual(['P2 done']);
    const all = (await owner.api.get(`/api/v1/board?projectIds=${hidden.id}`).expect(200)).body.data;
    expect(all.columns[0].cards.map((x) => x.title)).toEqual(['Hidden task']);
  });

  it('isolates organizations', async () => {
    const p = await newProject();
    const col = (await cols(p.id))[0];
    const other = await registerOrg(t);
    await other.api.get(`/api/v1/projects/${p.id}/board`).expect(404);
    await other.api.patch(`/api/v1/columns/${col.id}`).send({ name: 'x' }).expect(404);
    await other.api.post('/api/v1/tasks').send({ title: 'x', columnId: col.id }).expect(400);
    const b = (await other.api.get(`/api/v1/board?projectIds=${p.id}`).expect(200)).body.data;
    expect(b.columns.flatMap((x) => x.cards)).toEqual([]);
  });
});
