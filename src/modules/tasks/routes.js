import { z } from 'zod';
import { createRouter, zBool, zColor } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, where, dateStr, uuidParam } from '../../lib/http.js';
import { badRequest, forbidden, notFound, unprocessable, conflict } from '../../lib/errors.js';
import { accessibleProjectIds, assertProjectAccess, accessibleMemberIds } from '../../rbac/scope.js';
import { logActivity, diff } from '../../lib/audit.js';
import { publish } from '../../lib/events.js';
import { emitToProject } from '../../lib/realtime.js';
import { notify } from '../notifications/service.js';
import { signedGetUrl } from '../../lib/storage.js';
import { loadProject, num, hours, assertOrgMembers } from '../projects/service.js';
import { activityDto } from '../projects/service.js';
import {
  CATEGORIES,
  loadTask,
  getTaskFor,
  assertTaskUpdate,
  sanitizeRichText,
  resolveColumn,
  endPosition,
  moveTask,
  wouldCycle,
  fetchCards,
  fetchCard,
  actualSeconds,
  setAssignees,
  setLabels,
  taskWhere,
} from './service.js';

const r = createRouter('/tasks', 'Tasks');

const PRIORITY = z.enum(['low', 'medium', 'high', 'urgent']);
const STATUS = z.enum(CATEGORIES);
const zAssignee = z.union([z.uuid(), z.literal('me')]);
const newLabel = z.object({ name: z.string().trim().min(1).max(60), color: zColor.nullable().optional() });
const idDep = z.object({ id: z.uuid(), dependsOnId: z.uuid() });

const taskFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100000).nullable().optional(),
  priority: PRIORITY.optional(),
  categoryId: z.uuid().nullable().optional(),
  startDate: dateStr.nullable().optional(),
  dueDate: dateStr.nullable().optional(),
  estimatedHours: z.number().min(0).max(100000).nullable().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  reviewerMemberId: z.uuid().nullable().optional(),
};
const FIELD_MAP = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  categoryId: 'category_id',
  startDate: 'start_date',
  dueDate: 'due_date',
  estimatedHours: 'estimated_hours',
  progress: 'progress',
  reviewerMemberId: 'reviewer_member_id',
};
const createBody = z.object({
  ...taskFields,
  projectId: z.uuid().optional(),
  columnId: z.uuid().optional(),
  status: STATUS.optional(),
  parentTaskId: z.uuid().optional(),
  assigneeIds: z.array(z.uuid()).max(50).optional(),
  labelIds: z.array(z.uuid()).max(50).optional(),
  newLabels: z.array(newLabel).max(20).optional(),
});

const tz = (ctx) => ctx.orgTimezone ?? ctx.timezone ?? 'UTC';
const link = (t) => `/projects/${t.project_id}/tasks/${t.id}`;

async function assertCategory(orgId, categoryId) {
  if (!categoryId) return;
  const c = await db.one('SELECT 1 FROM task_categories WHERE id = $1 AND organization_id = $2', [categoryId, orgId]);
  if (!c) throw badRequest('Task category not found', undefined, 'INVALID_REFERENCE');
}

function checkDates(start, due) {
  if (start && due && due < start) throw badRequest('Due date must be on or after the start date', undefined, 'INVALID_DATES');
}

/** TASK-01 / KAN-15 / TASK-17: create a task (quick create supported: {title, columnId}). */
async function createTask(ctx, b) {
  let projectId = b.projectId;
  let parent = null;
  if (b.parentTaskId) {
    parent = await loadTask(ctx.orgId, b.parentTaskId);
    if (parent.parent_task_id) throw unprocessable('SUBTASK_DEPTH', 'Subtasks cannot have subtasks');
    if (projectId && projectId !== parent.project_id) throw badRequest('Subtask must belong to the parent task project');
    projectId = parent.project_id;
  }
  if (!projectId && b.columnId) {
    const col = await db.one('SELECT project_id FROM board_columns WHERE id = $1 AND organization_id = $2', [b.columnId, ctx.orgId]);
    if (!col) throw badRequest('Column not found', undefined, 'INVALID_REFERENCE');
    projectId = col.project_id;
  }
  if (!projectId) throw badRequest('projectId is required', [{ path: 'body.projectId', message: 'Required' }], 'VALIDATION_ERROR');
  const project = await loadProject(ctx.orgId, projectId);
  await assertProjectAccess(ctx, 'tasks.create', projectId);
  if (project.archived_at) throw unprocessable('PROJECT_ARCHIVED', 'Cannot add tasks to an archived project');
  checkDates(b.startDate, b.dueDate);
  await assertCategory(ctx.orgId, b.categoryId);
  if (b.reviewerMemberId) await assertOrgMembers(ctx.orgId, [b.reviewerMemberId]);
  const assignees = b.assigneeIds ?? [];
  if (assignees.some((id) => id !== ctx.memberId)) await assertProjectAccess(ctx, 'tasks.assign', projectId);
  const column = await resolveColumn(projectId, { columnId: b.columnId, status: b.status });

  const task = await db.tx(async () => {
    const cols = ['organization_id', 'project_id', 'parent_task_id', 'column_id', 'position', 'created_by'];
    const vals = [ctx.orgId, projectId, parent?.id ?? null, column?.id ?? null, column ? await endPosition(column.id) : 0, ctx.memberId ?? null];
    for (const [f, col] of Object.entries(FIELD_MAP)) {
      if (b[f] === undefined) continue;
      cols.push(col);
      vals.push(f === 'description' ? sanitizeRichText(b[f]) : b[f]);
    }
    if (column?.category === 'done') {
      cols.push('completed_at');
      vals.push(new Date());
    }
    const row = await db.one(`INSERT INTO tasks (${cols.join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals);
    const t = await loadTask(ctx.orgId, row.id);
    if (assignees.length) await setAssignees(ctx, t, assignees, { notifyAdded: false });
    if (b.labelIds?.length || b.newLabels?.length) await setLabels(ctx, t, b.labelIds ?? [], b.newLabels ?? []);
    await logActivity(ctx, 'task', t.id, 'created', { title: t.title, parentTaskId: t.parent_task_id });
    return t;
  });
  const toNotify = assignees.filter((id) => id !== ctx.memberId);
  if (toNotify.length)
    await notify({
      orgId: ctx.orgId,
      memberIds: toNotify,
      type: 'task.assigned',
      title: `New task: ${task.title}`,
      body: `You were assigned to "${task.title}" in ${project.name}.`,
      link: link(task),
      data: { taskId: task.id, projectId },
    });
  const card = await fetchCard(ctx, task.id);
  emitToProject(projectId, 'board.task_updated', card);
  await publish('task.created', { orgId: ctx.orgId, task: card });
  return card;
}

// ───────────────────────── list / calendar ─────────────────────────
r.get(
  '/',
  {
    summary: 'List tasks (list view)',
    ids: 'KAN-21,KAN-16,KAN-18,KAN-19',
    permission: 'tasks.view',
    query: paginationQuery.extend({
      projectId: z.uuid().optional(),
      assigneeId: zAssignee.optional(),
      status: STATUS.optional(),
      priority: PRIORITY.optional(),
      labelId: z.uuid().optional(),
      categoryId: z.uuid().optional(),
      parentTaskId: z.uuid().optional(),
      topLevel: zBool.optional(),
      dueBefore: dateStr.optional(),
      overdue: zBool.optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const w = await taskWhere(ctx, q);
    if (q.topLevel) w.raw('t.parent_task_id IS NULL');
    w.add('t.parent_task_id = ?', q.parentTaskId).add('t.category_id = ?', q.categoryId);
    if (q.dueBefore) w.add('t.due_date <= ?::date', q.dueBefore);
    if (q.overdue !== undefined)
      w.add(q.overdue ? 't.completed_at IS NULL AND t.due_date < (now() AT TIME ZONE ?::text)::date' : 'NOT (t.completed_at IS NULL AND coalesce(t.due_date < (now() AT TIME ZONE ?::text)::date, false))', tz(ctx));
    const total = (await db.one(`SELECT count(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL LEFT JOIN board_columns c ON c.id = t.column_id ${w.sql}`, w.params)).n;
    const sortable = { createdAt: 't.created_at', dueDate: 't.due_date', priority: `array_position(ARRAY['low','medium','high','urgent'], t.priority)`, title: 'lower(t.title)', updatedAt: 't.updated_at', position: 't.position' };
    const col = sortable[q.sort] ?? sortable.createdAt;
    const dir = q.order === 'asc' ? 'ASC' : 'DESC';
    const cards = await fetchCards(w, tz(ctx), { orderBy: `${col} ${dir} NULLS LAST, t.id`, limit: q.limit, offset: (q.page - 1) * q.limit });
    ok(res, cards, pageMeta(q, total));
  },
);

r.get(
  '/calendar',
  {
    summary: 'Calendar view of tasks',
    ids: 'KAN-22',
    permission: 'tasks.view',
    query: z.object({ from: dateStr, to: dateStr, projectId: z.uuid().optional(), assigneeId: zAssignee.optional(), priority: PRIORITY.optional(), status: STATUS.optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    if (q.to < q.from) throw badRequest('"to" must be on or after "from"', undefined, 'INVALID_DATES');
    const w = await taskWhere(ctx, q);
    w.add(
      `((t.due_date BETWEEN ?::date AND ?::date) OR (t.start_date BETWEEN ?::date AND ?::date) OR (t.start_date < ?::date AND t.due_date > ?::date))`,
      q.from, q.to, q.from, q.to, q.from, q.to,
    );
    const cards = await fetchCards(w, tz(ctx), { orderBy: 'coalesce(t.due_date, t.start_date), t.position', limit: 1000 });
    ok(res, cards);
  },
);

r.post('/', { summary: 'Create task (incl. quick create)', ids: 'TASK-01,KAN-15', permission: 'tasks.create', body: createBody }, async (req, res) => {
  created(res, await createTask(req.ctx, req.body));
});

// ───────────────────────── detail / update / delete ─────────────────────────
r.get('/:id', { summary: 'Task detail', ids: 'KAN-08,TASK-11,TASK-12,TASK-14', permission: 'tasks.view', params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  const t = await getTaskFor(ctx, req.v.params.id);
  ok(res, await taskDetail(ctx, t));
});

async function taskDetail(ctx, t) {
  const card = await fetchCard(ctx, t.id);
  const sw = where();
  sw.add('t.parent_task_id = ?', t.id).raw('t.deleted_at IS NULL');
  const subtasks = await fetchCards(sw, tz(ctx), { orderBy: 't.position, t.created_at' });
  const blockedBy = await db.many(
    `SELECT b.id, b.title, b.completed_at, c.category AS status FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_task_id
     LEFT JOIN board_columns c ON c.id = b.column_id WHERE d.task_id = $1 AND b.deleted_at IS NULL ORDER BY b.title`,
    [t.id],
  );
  const blocking = await db.many(
    `SELECT b.id, b.title, b.completed_at, c.category AS status FROM task_dependencies d JOIN tasks b ON b.id = d.task_id
     LEFT JOIN board_columns c ON c.id = b.column_id WHERE d.depends_on_task_id = $1 AND b.deleted_at IS NULL ORDER BY b.title`,
    [t.id],
  );
  const actual = await actualSeconds([t.id, ...subtasks.map((s) => s.id)]);
  const extra = await db.one(
    `SELECT cat.name AS category_name, cat.color AS category_color, ru.first_name AS r_first, ru.last_name AS r_last, au.first_name AS a_first, au.last_name AS a_last
     FROM tasks t LEFT JOIN task_categories cat ON cat.id = t.category_id
     LEFT JOIN organization_members rm ON rm.id = t.reviewer_member_id LEFT JOIN users ru ON ru.id = rm.user_id
     LEFT JOIN organization_members am ON am.id = t.approved_by LEFT JOIN users au ON au.id = am.user_id
     WHERE t.id = $1`,
    [t.id],
  );
  const dep = (x) => ({ id: x.id, title: x.title, status: x.status, completedAt: x.completed_at, done: !!x.completed_at });
  const ownSecs = actual.get(t.id) ?? 0;
  const subSecs = subtasks.reduce((s, x) => s + (actual.get(x.id) ?? 0), 0);
  return {
    ...card,
    description: t.description,
    categoryId: t.category_id,
    category: t.category_id ? { id: t.category_id, name: extra.category_name, color: extra.category_color } : null,
    reviewerMemberId: t.reviewer_member_id,
    reviewer: t.reviewer_member_id ? { memberId: t.reviewer_member_id, name: `${extra.r_first} ${extra.r_last ?? ''}`.trim() } : null,
    approvedBy: t.approved_by ? { memberId: t.approved_by, name: `${extra.a_first} ${extra.a_last ?? ''}`.trim() } : null,
    approvedAt: t.approved_at,
    subtaskProgress: card.subtasksTotal ? Math.round((card.subtasksDone / card.subtasksTotal) * 100) : null,
    subtasks,
    dependencies: { blockedBy: blockedBy.map(dep), blocking: blocking.map(dep) },
    isBlocked: blockedBy.some((x) => !x.completed_at),
    actualHours: hours(ownSecs),
    actualHoursWithSubtasks: hours(ownSecs + subSecs),
    hoursVariance: t.estimated_hours !== null ? hours(ownSecs + subSecs) - num(t.estimated_hours) : null,
    createdBy: t.created_by,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

const OWN_FIELDS = ['progress', 'columnId', 'status'];

r.patch(
  '/:id',
  {
    summary: 'Update task',
    ids: 'TASK-02,TASK-08,TASK-22',
    permission: 'tasks.update',
    params: uuidParam,
    body: z.object({
      ...taskFields,
      title: taskFields.title.optional(),
      columnId: z.uuid().optional(),
      status: STATUS.optional(),
      assigneeIds: z.array(z.uuid()).max(50).optional(),
      labelIds: z.array(z.uuid()).max(50).optional(),
      newLabels: z.array(newLabel).max(20).optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    const t = await loadTask(ctx.orgId, req.v.params.id);
    const scope = await assertTaskUpdate(ctx, t);
    if (scope === 'own') {
      const extra = Object.keys(b).filter((k) => b[k] !== undefined && !OWN_FIELDS.includes(k));
      if (extra.length) throw forbidden(`You can only update status and progress of your tasks (not: ${extra.join(', ')})`, 'TASK_FIELDS_RESTRICTED');
    }
    if (b.assigneeIds) await assertProjectAccess(ctx, 'tasks.assign', t.project_id);
    checkDates(b.startDate === undefined ? t.start_date : b.startDate, b.dueDate === undefined ? t.due_date : b.dueDate);
    if (b.categoryId) await assertCategory(ctx.orgId, b.categoryId);
    if (b.reviewerMemberId) await assertOrgMembers(ctx.orgId, [b.reviewerMemberId]);
    const card = await db.tx(async () => {
      const sets = [];
      const vals = [];
      for (const [f, col] of Object.entries(FIELD_MAP)) {
        if (b[f] === undefined) continue;
        vals.push(f === 'description' ? sanitizeRichText(b[f]) : b[f]);
        sets.push(`${col} = $${vals.length}`);
      }
      if (b.dueDate !== undefined && b.dueDate !== t.due_date) sets.push('due_reminder_sent_at = NULL', 'overdue_alert_sent_at = NULL');
      if (sets.length) {
        vals.push(t.id);
        await db.query(`UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
        const before = Object.fromEntries(Object.entries(FIELD_MAP).map(([f, col]) => [f, t[col] === null ? null : String(t[col])]));
        const after = Object.fromEntries(Object.keys(b).filter((k) => FIELD_MAP[k]).map((k) => [k, b[k] === null ? null : String(b[k])]));
        const d = diff(before, after);
        if (d.changed) await logActivity(ctx, 'task', t.id, 'updated', { before: d.before, after: d.after });
      }
      if (b.assigneeIds) await setAssignees(ctx, t, b.assigneeIds);
      if (b.labelIds || b.newLabels) await setLabels(ctx, t, b.labelIds ?? [], b.newLabels ?? []);
      if (b.columnId || b.status) {
        const current = await loadTask(ctx.orgId, t.id);
        const column = await resolveColumn(t.project_id, { columnId: b.columnId, status: b.status });
        if (column.id !== current.column_id) await moveTask(ctx, current, column);
      }
      return fetchCard(ctx, t.id);
    });
    emitToProject(t.project_id, 'board.task_updated', card);
    await publish('task.updated', { orgId: ctx.orgId, task: card });
    ok(res, card);
  },
);

r.delete('/:id', { summary: 'Delete task (soft)', ids: 'TASK-03', permission: 'tasks.delete', params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  const t = await getTaskFor(ctx, req.v.params.id, 'tasks.delete');
  await db.query('UPDATE tasks SET deleted_at = now(), updated_at = now() WHERE (id = $1 OR parent_task_id = $1) AND deleted_at IS NULL', [t.id]);
  await logActivity(ctx, 'task', t.id, 'deleted', { title: t.title });
  emitToProject(t.project_id, 'board.task_deleted', { id: t.id, projectId: t.project_id, columnId: t.column_id });
  await publish('task.deleted', { orgId: ctx.orgId, task: { id: t.id, projectId: t.project_id, title: t.title } });
  noContent(res);
});

// ───────────────────────── move (KAN-05) ─────────────────────────
r.patch(
  '/:id/move',
  {
    summary: 'Move task on the board',
    ids: 'KAN-05,TASK-22',
    permission: 'tasks.update',
    params: uuidParam,
    body: z.object({ columnId: z.uuid(), beforeId: z.uuid().nullable().optional(), afterId: z.uuid().nullable().optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const t = await loadTask(ctx.orgId, req.v.params.id);
    await assertTaskUpdate(ctx, t);
    const column = await resolveColumn(t.project_id, { columnId: req.body.columnId });
    if ([req.body.beforeId, req.body.afterId].includes(t.id)) throw badRequest('A task cannot be positioned relative to itself', undefined, 'INVALID_POSITION');
    await db.tx(() => moveTask(ctx, t, column, { beforeId: req.body.beforeId ?? undefined, afterId: req.body.afterId ?? undefined }));
    ok(res, await fetchCard(ctx, t.id));
  },
);

// ───────────────────────── assignees / labels ─────────────────────────
r.put(
  '/:id/assignees',
  { summary: 'Set task assignees', ids: 'TASK-04,TASK-05', permission: 'tasks.assign', params: uuidParam, body: z.object({ memberIds: z.array(z.uuid()).max(50) }) },
  async (req, res) => {
    const ctx = req.ctx;
    const t = await getTaskFor(ctx, req.v.params.id, 'tasks.assign');
    await db.tx(() => setAssignees(ctx, t, req.body.memberIds));
    const card = await fetchCard(ctx, t.id);
    emitToProject(t.project_id, 'board.task_updated', card);
    await publish('task.updated', { orgId: ctx.orgId, task: card });
    ok(res, card);
  },
);

r.put(
  '/:id/labels',
  {
    summary: 'Set task labels (inline create supported)',
    ids: 'TASK-15',
    permission: 'tasks.update',
    params: uuidParam,
    body: z.object({ labelIds: z.array(z.uuid()).max(50).default([]), newLabels: z.array(newLabel).max(20).default([]) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const t = await loadTask(ctx.orgId, req.v.params.id);
    const scope = await assertTaskUpdate(ctx, t);
    if (scope === 'own') throw forbidden('You can only update status and progress of your tasks', 'TASK_FIELDS_RESTRICTED');
    await db.tx(() => setLabels(ctx, t, req.body.labelIds, req.body.newLabels));
    await logActivity(ctx, 'task', t.id, 'labels_changed', null);
    const card = await fetchCard(ctx, t.id);
    emitToProject(t.project_id, 'board.task_updated', card);
    ok(res, card);
  },
);

// ───────────────────────── subtasks (TASK-17) ─────────────────────────
r.get('/:id/subtasks', { summary: 'List subtasks', ids: 'TASK-17', permission: 'tasks.view', params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  const t = await getTaskFor(ctx, req.v.params.id);
  const w = where();
  w.add('t.parent_task_id = ?', t.id).raw('t.deleted_at IS NULL');
  ok(res, await fetchCards(w, tz(ctx), { orderBy: 't.position, t.created_at' }));
});

r.post(
  '/:id/subtasks',
  { summary: 'Create subtask', ids: 'TASK-17', permission: 'tasks.create', params: uuidParam, body: createBody.omit({ projectId: true, parentTaskId: true }) },
  async (req, res) => {
    created(res, await createTask(req.ctx, { ...req.body, parentTaskId: req.v.params.id }));
  },
);

// ───────────────────────── dependencies (TASK-18) ─────────────────────────
r.get('/:id/dependencies', { summary: 'List task dependencies', ids: 'TASK-18', permission: 'tasks.view', params: uuidParam }, async (req, res) => {
  const t = await getTaskFor(req.ctx, req.v.params.id);
  const detail = await taskDetail(req.ctx, t);
  ok(res, detail.dependencies);
});

r.post(
  '/:id/dependencies',
  { summary: 'Add dependency (this task is blocked by dependsOnTaskId)', ids: 'TASK-18', permission: 'tasks.update', params: uuidParam, body: z.object({ dependsOnTaskId: z.uuid() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const t = await loadTask(ctx.orgId, req.v.params.id);
    const scope = await assertTaskUpdate(ctx, t);
    if (scope === 'own') throw forbidden('You cannot change task dependencies', 'TASK_FIELDS_RESTRICTED');
    const depId = req.body.dependsOnTaskId;
    if (depId === t.id) throw unprocessable('DEPENDENCY_CYCLE', 'A task cannot depend on itself');
    const dep = await loadTask(ctx.orgId, depId);
    if (dep.project_id !== t.project_id) throw unprocessable('DEPENDENCY_PROJECT_MISMATCH', 'Dependencies must be within the same project');
    if (await db.one('SELECT 1 FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2', [t.id, depId]))
      throw conflict('CONFLICT', 'Dependency already exists');
    if (await wouldCycle(t.id, depId)) throw unprocessable('DEPENDENCY_CYCLE', 'This dependency would create a cycle');
    await db.query('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1,$2)', [t.id, depId]);
    await logActivity(ctx, 'task', t.id, 'dependency_added', { dependsOnTaskId: depId, title: dep.title });
    const detail = await taskDetail(ctx, t);
    created(res, detail.dependencies);
  },
);

r.delete('/:id/dependencies/:dependsOnId', { summary: 'Remove dependency', ids: 'TASK-18', permission: 'tasks.update', params: idDep }, async (req, res) => {
  const ctx = req.ctx;
  const t = await loadTask(ctx.orgId, req.v.params.id);
  const scope = await assertTaskUpdate(ctx, t);
  if (scope === 'own') throw forbidden('You cannot change task dependencies', 'TASK_FIELDS_RESTRICTED');
  const del = await db.query('DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2', [t.id, req.v.params.dependsOnId]);
  if (!del.rowCount) throw notFound('Dependency');
  await logActivity(ctx, 'task', t.id, 'dependency_removed', { dependsOnTaskId: req.v.params.dependsOnId });
  noContent(res);
});

// ───────────────────────── review & approval (TASK-23/24) ─────────────────────────
async function assigneeIds(taskId) {
  return (await db.many('SELECT member_id FROM task_assignees WHERE task_id = $1', [taskId])).map((r) => r.member_id);
}

r.post(
  '/:id/submit-review',
  { summary: 'Submit task for review', ids: 'TASK-23', permission: 'tasks.update', params: uuidParam, body: z.object({ reviewerMemberId: z.uuid().optional() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const t = await loadTask(ctx.orgId, req.v.params.id);
    await assertTaskUpdate(ctx, t);
    const reviewer = req.body.reviewerMemberId ?? t.reviewer_member_id;
    if (!reviewer) throw badRequest('reviewerMemberId is required', [{ path: 'body.reviewerMemberId', message: 'Required' }], 'VALIDATION_ERROR');
    await assertOrgMembers(ctx.orgId, [reviewer]);
    const column = await resolveColumn(t.project_id, { status: 'in_review' });
    await db.tx(async () => {
      await db.query(`UPDATE tasks SET reviewer_member_id = $2, approval_status = 'pending', approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = $1`, [t.id, reviewer]);
      if (column.id !== t.column_id) await moveTask(ctx, await loadTask(ctx.orgId, t.id), column);
      await logActivity(ctx, 'task', t.id, 'review_requested', { reviewerMemberId: reviewer });
    });
    if (reviewer !== ctx.memberId)
      await notify({
        orgId: ctx.orgId,
        memberIds: [reviewer],
        type: 'task.review_requested',
        title: `Review requested: ${t.title}`,
        body: `Please review "${t.title}" in ${t.project_name}.`,
        link: link(t),
        data: { taskId: t.id, projectId: t.project_id },
      });
    ok(res, await fetchCard(ctx, t.id));
  },
);

r.post('/:id/approve', { summary: 'Approve task', ids: 'TASK-24', permission: 'tasks.approve', params: uuidParam, body: z.object({ comment: z.string().trim().max(5000).optional() }) }, async (req, res) => {
  const ctx = req.ctx;
  const t = await getTaskFor(ctx, req.v.params.id, 'tasks.approve');
  const column = await resolveColumn(t.project_id, { status: 'done' });
  await db.tx(async () => {
    if (column.id !== t.column_id) await moveTask(ctx, t, column);
    await db.query(`UPDATE tasks SET approval_status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [t.id, ctx.memberId ?? null]);
    if (req.body.comment)
      await db.query(`INSERT INTO comments (organization_id, entity_type, entity_id, author_member_id, body) VALUES ($1,'task',$2,$3,$4)`, [ctx.orgId, t.id, ctx.memberId ?? null, req.body.comment]);
    await logActivity(ctx, 'task', t.id, 'approved', null);
  });
  const recipients = (await assigneeIds(t.id)).filter((id) => id !== ctx.memberId);
  if (recipients.length)
    await notify({ orgId: ctx.orgId, memberIds: recipients, type: 'task.approved', title: `Task approved: ${t.title}`, body: `"${t.title}" was approved.`, link: link(t), data: { taskId: t.id, projectId: t.project_id, decision: 'approved' } });
  ok(res, await fetchCard(ctx, t.id));
});

r.post(
  '/:id/request-changes',
  { summary: 'Request changes on task', ids: 'TASK-24', permission: 'tasks.approve', params: uuidParam, body: z.object({ comment: z.string().trim().min(1).max(5000) }) },
  async (req, res) => {
    const ctx = req.ctx;
    const t = await getTaskFor(ctx, req.v.params.id, 'tasks.approve');
    const column =
      (await db.one(`SELECT * FROM board_columns WHERE project_id = $1 AND category = 'in_progress' ORDER BY position LIMIT 1`, [t.project_id])) ??
      (await resolveColumn(t.project_id, { status: 'todo' }));
    await db.tx(async () => {
      await db.query(`UPDATE tasks SET approval_status = 'changes_requested', approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = $1`, [t.id]);
      if (column.id !== t.column_id) await moveTask(ctx, await loadTask(ctx.orgId, t.id), column);
      await db.query(`INSERT INTO comments (organization_id, entity_type, entity_id, author_member_id, body) VALUES ($1,'task',$2,$3,$4)`, [ctx.orgId, t.id, ctx.memberId ?? null, req.body.comment]);
      await logActivity(ctx, 'task', t.id, 'changes_requested', { comment: req.body.comment });
    });
    const recipients = (await assigneeIds(t.id)).filter((id) => id !== ctx.memberId);
    if (recipients.length)
      await notify({ orgId: ctx.orgId, memberIds: recipients, type: 'task.approved', title: `Changes requested: ${t.title}`, body: req.body.comment, link: link(t), data: { taskId: t.id, projectId: t.project_id, decision: 'changes_requested' } });
    ok(res, await fetchCard(ctx, t.id));
  },
);

// ───────────────────────── activity / time ─────────────────────────
r.get('/:id/activity', { summary: 'Task activity history', ids: 'TASK-21', permission: 'tasks.view', params: uuidParam, query: paginationQuery }, async (req, res) => {
  const ctx = req.ctx;
  const t = await getTaskFor(ctx, req.v.params.id);
  const q = req.v.query;
  const total = (await db.one(`SELECT count(*) AS n FROM activity_log WHERE organization_id = $1 AND entity_type = 'task' AND entity_id = $2`, [ctx.orgId, t.id])).n;
  const rows = await db.many(
    `SELECT a.*, u.first_name, u.last_name, u.avatar_key FROM activity_log a
     LEFT JOIN organization_members m ON m.id = a.actor_member_id LEFT JOIN users u ON u.id = m.user_id
     WHERE a.organization_id = $1 AND a.entity_type = 'task' AND a.entity_id = $2 ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`,
    [ctx.orgId, t.id, q.limit, (q.page - 1) * q.limit],
  );
  ok(res, rows.map(activityDto), pageMeta(q, total));
});

r.get('/:id/time', { summary: 'Time entries on a task', ids: 'TASK-13', permission: 'tasks.view', params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  const t = await getTaskFor(ctx, req.v.params.id);
  const memberIds = ctx.can('time.view') ? await accessibleMemberIds(ctx, 'time.view') : [ctx.memberId];
  const params = [t.id, ctx.orgId];
  let scope = '';
  if (memberIds) {
    params.push(memberIds);
    scope = ' AND e.member_id = ANY($3::uuid[])';
  }
  const rows = await db.many(
    `SELECT e.id, e.member_id, e.started_at, e.ended_at, e.duration_seconds, e.is_billable, e.status, e.note, e.source, u.first_name, u.last_name, u.avatar_key
     FROM time_entries e JOIN organization_members m ON m.id = e.member_id JOIN users u ON u.id = m.user_id
     WHERE e.task_id = $1 AND e.organization_id = $2 AND e.deleted_at IS NULL${scope} ORDER BY e.started_at DESC LIMIT 500`,
    params,
  );
  const totalSecs = (await actualSeconds([t.id])).get(t.id) ?? 0;
  const byMember = new Map();
  for (const e of rows) {
    if (e.status === 'rejected') continue;
    const m = byMember.get(e.member_id) ?? { memberId: e.member_id, name: `${e.first_name} ${e.last_name}`.trim(), seconds: 0 };
    m.seconds += e.duration_seconds;
    byMember.set(e.member_id, m);
  }
  ok(res, {
    taskId: t.id,
    estimatedHours: num(t.estimated_hours),
    actualHours: hours(totalSecs),
    byMember: [...byMember.values()].map((m) => ({ memberId: m.memberId, name: m.name, hours: hours(m.seconds) })),
    entries: rows.map((e) => ({
      id: e.id,
      member: { memberId: e.member_id, name: `${e.first_name} ${e.last_name}`.trim(), avatarUrl: signedGetUrl(e.avatar_key) },
      startedAt: e.started_at,
      endedAt: e.ended_at,
      durationSeconds: e.duration_seconds,
      isBillable: e.is_billable,
      status: e.status,
      note: e.note,
      source: e.source,
    })),
  });
});

export default r;
