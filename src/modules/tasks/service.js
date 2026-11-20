import { db } from '../../lib/db.js';
import { notFound, forbidden, badRequest, unprocessable } from '../../lib/errors.js';
import { assertProjectAccess, accessibleProjectIds } from '../../rbac/scope.js';
import { where } from '../../lib/http.js';
import { signedGetUrl } from '../../lib/storage.js';
import { logActivity } from '../../lib/audit.js';
import { publish } from '../../lib/events.js';
import { emitToProject } from '../../lib/realtime.js';
import { notify } from '../notifications/service.js';
import { num, hours, memberHasProjectAccess } from '../projects/service.js';

/** Shared task helpers (M10/M11). */

export const CATEGORIES = ['todo', 'in_progress', 'in_review', 'done'];
const POS_EPSILON = 1e-6;

/** Load a non-deleted task (in a non-deleted project) of the org with its column category. */
export async function loadTask(orgId, id) {
  const t = await db.one(
    `SELECT t.*, c.category AS status, c.name AS column_name, p.name AS project_name, p.archived_at AS project_archived_at
     FROM tasks t JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
     LEFT JOIN board_columns c ON c.id = t.column_id
     WHERE t.id = $1 AND t.organization_id = $2 AND t.deleted_at IS NULL`,
    [id, orgId],
  );
  if (!t) throw notFound('Task');
  return t;
}

export async function getTaskFor(ctx, id, perm = 'tasks.view') {
  const t = await loadTask(ctx.orgId, id);
  await assertProjectAccess(ctx, perm, t.project_id);
  return t;
}

export async function isAssignee(taskId, memberId) {
  return !!(await db.one('SELECT 1 FROM task_assignees WHERE task_id = $1 AND member_id = $2', [taskId, memberId]));
}

/**
 * Enforce tasks.update with its scope. 'own' (employees) → only tasks assigned to them
 * (or subtasks of a task assigned to them). Returns the scope.
 */
export async function assertTaskUpdate(ctx, task) {
  const scope = ctx.require('tasks.update');
  if (scope === 'own') {
    const ok =
      (await isAssignee(task.id, ctx.memberId)) || (task.parent_task_id && (await isAssignee(task.parent_task_id, ctx.memberId)));
    if (!ok) throw forbidden('You can only update tasks assigned to you', 'TASK_NOT_ASSIGNED');
    return scope;
  }
  await assertProjectAccess(ctx, 'tasks.update', task.project_id);
  return scope;
}

/** Basic sanitizer for rich-text descriptions (TASK-06): strips scripts, event handlers and js: URLs. */
export function sanitizeRichText(html) {
  if (html === null || html === undefined) return html;
  return String(html)
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

export async function projectColumns(projectId) {
  return db.many('SELECT * FROM board_columns WHERE project_id = $1 ORDER BY position, created_at', [projectId]);
}

/** Resolve a target column for a project from columnId or a status category. */
export async function resolveColumn(projectId, { columnId, status } = {}) {
  if (columnId) {
    const c = await db.one('SELECT * FROM board_columns WHERE id = $1 AND project_id = $2', [columnId, projectId]);
    if (!c) throw badRequest('Column not found in this project', undefined, 'INVALID_REFERENCE');
    return c;
  }
  const c = await db.one(
    'SELECT * FROM board_columns WHERE project_id = $1 AND category = $2 ORDER BY position LIMIT 1',
    [projectId, status ?? 'todo'],
  );
  if (!c && status) throw unprocessable('NO_COLUMN_FOR_STATUS', `The project has no ${status} column`);
  return c;
}

export async function endPosition(columnId) {
  const r = await db.one('SELECT max(position) AS m FROM tasks WHERE column_id = $1 AND deleted_at IS NULL', [columnId]);
  return (r?.m ?? 0) + 1;
}

/** TASK-22: unfinished blockers prevent completion. */
export async function assertNotBlocked(taskId) {
  const rows = await db.many(
    `SELECT b.id, b.title FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_task_id
     WHERE d.task_id = $1 AND b.deleted_at IS NULL AND b.completed_at IS NULL`,
    [taskId],
  );
  if (rows.length)
    throw unprocessable('TASK_BLOCKED', 'This task is blocked by unfinished tasks', { blockedBy: rows.map((r) => ({ id: r.id, title: r.title })) });
}

/** TASK-18: would adding task → dependsOn create a cycle? */
export async function wouldCycle(taskId, dependsOnId) {
  const r = await db.one(
    `WITH RECURSIVE chain(id) AS (
       SELECT $2::uuid
       UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN chain c ON d.task_id = c.id)
     SELECT 1 AS hit FROM chain WHERE id = $1 LIMIT 1`,
    [taskId, dependsOnId],
  );
  return !!r;
}

/**
 * KAN-05: fractional position between neighbours in the target column.
 * afterId = card that ends up directly above; beforeId = card directly below. Renumbers on tiny gaps.
 */
export async function computePosition(task, columnId, { beforeId, afterId } = {}) {
  const list = await db.many(
    `SELECT id, position FROM tasks WHERE column_id = $1 AND deleted_at IS NULL AND id <> $2 ORDER BY position, created_at`,
    [columnId, task.id],
  );
  let idx = list.length;
  if (afterId) {
    const i = list.findIndex((x) => x.id === afterId);
    if (i < 0) throw badRequest('afterId is not a task in the target column', undefined, 'INVALID_REFERENCE');
    idx = i + 1;
  }
  if (beforeId) {
    const i = list.findIndex((x) => x.id === beforeId);
    if (i < 0) throw badRequest('beforeId is not a task in the target column', undefined, 'INVALID_REFERENCE');
    if (afterId && i !== idx) throw badRequest('afterId and beforeId must be adjacent', undefined, 'INVALID_POSITION');
    idx = i;
  }
  const prev = list[idx - 1];
  const next = list[idx];
  if (prev && next) {
    if (next.position - prev.position < POS_EPSILON) {
      // Renumber the whole column with the moved task in place.
      list.splice(idx, 0, { id: task.id });
      for (let i = 0; i < list.length; i++) {
        if (list[i].id !== task.id) await db.query('UPDATE tasks SET position = $2 WHERE id = $1', [list[i].id, i + 1]);
      }
      return idx + 1;
    }
    return (prev.position + next.position) / 2;
  }
  if (prev) return prev.position + 1;
  if (next) return next.position - 1;
  return 1;
}

/**
 * Move a task to a column/position, applying completion rules (TASK-22) and side effects.
 * Returns the reloaded task row.
 */
export async function moveTask(ctx, task, column, { beforeId, afterId, silent = false } = {}) {
  const enteringDone = column.category === 'done' && task.status !== 'done';
  const leavingDone = column.category !== 'done' && (task.status === 'done' || task.completed_at);
  if (enteringDone) await assertNotBlocked(task.id);
  const position = await computePosition(task, column.id, { beforeId, afterId });
  await db.query(
    `UPDATE tasks SET column_id = $2, position = $3,
       completed_at = CASE WHEN $4::boolean THEN coalesce(completed_at, now()) WHEN $5::boolean THEN NULL ELSE completed_at END,
       progress = CASE WHEN $4::boolean THEN 100 ELSE progress END,
       updated_at = now() WHERE id = $1`,
    [task.id, column.id, position, enteringDone, !!leavingDone],
  );
  const updated = await loadTask(ctx.orgId, task.id);
  if (task.column_id !== column.id) {
    await logActivity(ctx, 'task', task.id, 'moved', { from: { columnId: task.column_id, status: task.status }, to: { columnId: column.id, status: column.category } });
  }
  if (!silent) {
    const card = await fetchCard(ctx, task.id);
    emitToProject(task.project_id, 'board.task_moved', card);
    await publish('task.updated', { orgId: ctx.orgId, task: card });
    if (enteringDone) {
      await logActivity(ctx, 'task', task.id, 'completed', null);
      await publish('task.completed', { orgId: ctx.orgId, task: card });
    }
  }
  return updated;
}

const CARD_SELECT = (tzP) => `SELECT t.*, c.category AS status, c.name AS column_name, p.name AS project_name,
  (t.due_date IS NOT NULL AND t.completed_at IS NULL AND t.due_date < (now() AT TIME ZONE ${tzP}::text)::date) AS is_overdue,
  coalesce((SELECT json_agg(json_build_object('memberId', m.id, 'firstName', u.first_name, 'lastName', u.last_name, 'avatarKey', u.avatar_key) ORDER BY u.first_name)
    FROM task_assignees ta JOIN organization_members m ON m.id = ta.member_id JOIN users u ON u.id = m.user_id WHERE ta.task_id = t.id), '[]'::json) AS assignees,
  coalesce((SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color, 'projectId', l.project_id) ORDER BY l.name)
    FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = t.id), '[]'::json) AS labels,
  (SELECT count(*) FROM tasks s WHERE s.parent_task_id = t.id AND s.deleted_at IS NULL) AS subtasks_total,
  (SELECT count(*) FROM tasks s WHERE s.parent_task_id = t.id AND s.deleted_at IS NULL AND s.completed_at IS NOT NULL) AS subtasks_done,
  (SELECT count(*) FROM comments cm WHERE cm.entity_type = 'task' AND cm.entity_id = t.id AND cm.deleted_at IS NULL) AS comment_count,
  (SELECT count(*) FROM attachments a WHERE a.entity_type = 'task' AND a.entity_id = t.id AND a.deleted_at IS NULL) AS attachment_count
FROM tasks t JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
LEFT JOIN board_columns c ON c.id = t.column_id`;

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : (v ?? []));

export function cardDto(t) {
  const assignees = parseJson(t.assignees);
  return {
    id: t.id,
    projectId: t.project_id,
    projectName: t.project_name,
    parentTaskId: t.parent_task_id,
    columnId: t.column_id,
    columnName: t.column_name ?? null,
    status: t.status ?? null,
    title: t.title,
    priority: t.priority,
    position: t.position,
    startDate: t.start_date,
    dueDate: t.due_date,
    isOverdue: !!t.is_overdue,
    completedAt: t.completed_at,
    approvalStatus: t.approval_status,
    progress: t.progress,
    estimatedHours: num(t.estimated_hours),
    labels: parseJson(t.labels),
    assignees: assignees.map((a) => ({ memberId: a.memberId, name: `${a.firstName} ${a.lastName ?? ''}`.trim(), avatarUrl: signedGetUrl(a.avatarKey) })),
    subtasksDone: t.subtasks_done ?? 0,
    subtasksTotal: t.subtasks_total ?? 0,
    commentCount: t.comment_count ?? 0,
    attachmentCount: t.attachment_count ?? 0,
  };
}

/**
 * Fetch card rows for a where() builder (aliases t, c, p). Call AFTER any count query using the
 * same builder, because this adds a timezone parameter.
 */
export async function fetchCards(w, tz, { orderBy = 'c.position NULLS LAST, t.position, t.created_at', limit, offset } = {}) {
  const tzP = w.param(tz || 'UTC');
  const page = limit ? ` LIMIT ${Number(limit)} OFFSET ${Number(offset) || 0}` : '';
  const rows = await db.many(`${CARD_SELECT(tzP)} ${w.sql} ORDER BY ${orderBy}${page}`, w.params);
  return rows.map(cardDto);
}

export async function fetchCard(ctx, taskId) {
  const rows = await db.many(`${CARD_SELECT('$3')} WHERE t.id = $1 AND t.organization_id = $2`, [taskId, ctx.orgId, ctx.orgTimezone ?? ctx.timezone ?? 'UTC']);
  return rows[0] ? cardDto(rows[0]) : null;
}

/** Estimated vs actual hours (TASK-11/12). */
export async function actualSeconds(taskIds) {
  if (!taskIds.length) return new Map();
  const rows = await db.many(
    `SELECT task_id, coalesce(sum(duration_seconds), 0) AS secs FROM time_entries
     WHERE task_id = ANY($1::uuid[]) AND deleted_at IS NULL AND status <> 'rejected' GROUP BY task_id`,
    [taskIds],
  );
  return new Map(rows.map((r) => [r.task_id, Number(r.secs)]));
}

/**
 * Replace assignees (TASK-04/05). Each must have project access. Notifies newly added members.
 * Returns newly added member ids.
 */
export async function setAssignees(ctx, task, memberIds, { notifyAdded = true } = {}) {
  const ids = [...new Set(memberIds)];
  for (const id of ids) {
    if (!(await memberHasProjectAccess(ctx.orgId, id, task.project_id)))
      throw unprocessable('ASSIGNEE_NO_ACCESS', 'Assignee must be a member of the project', { memberId: id });
  }
  const before = (await db.many('SELECT member_id FROM task_assignees WHERE task_id = $1', [task.id])).map((r) => r.member_id);
  await db.query('DELETE FROM task_assignees WHERE task_id = $1 AND NOT (member_id = ANY($2::uuid[]))', [task.id, ids]);
  for (const id of ids) await db.query('INSERT INTO task_assignees (task_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [task.id, id]);
  const added = ids.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !ids.includes(id));
  if (added.length || removed.length) await logActivity(ctx, 'task', task.id, 'assignees_changed', { added, removed });
  const toNotify = added.filter((id) => id !== ctx.memberId);
  if (notifyAdded && toNotify.length)
    await notify({
      orgId: ctx.orgId,
      memberIds: toNotify,
      type: 'task.assigned',
      title: `New task: ${task.title}`,
      body: `You were assigned to "${task.title}"${task.project_name ? ` in ${task.project_name}` : ''}.`,
      link: `/projects/${task.project_id}/tasks/${task.id}`,
      data: { taskId: task.id, projectId: task.project_id },
    });
  return added;
}

/** Replace labels (TASK-15). Labels must be org-wide or belong to the task's project; inline create project labels. */
export async function setLabels(ctx, task, labelIds = [], newLabels = []) {
  const ids = [...new Set(labelIds)];
  for (const nl of newLabels) {
    const existing = await db.one(
      `SELECT id FROM labels WHERE organization_id = $1 AND (project_id = $2 OR project_id IS NULL) AND lower(name) = lower($3) ORDER BY project_id NULLS LAST LIMIT 1`,
      [ctx.orgId, task.project_id, nl.name],
    );
    const id =
      existing?.id ??
      (await db.one('INSERT INTO labels (organization_id, project_id, name, color) VALUES ($1,$2,$3,$4) RETURNING id', [ctx.orgId, task.project_id, nl.name, nl.color ?? null])).id;
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length) {
    const ok = await db.many(
      `SELECT id FROM labels WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND (project_id IS NULL OR project_id = $3)`,
      [ctx.orgId, ids, task.project_id],
    );
    if (ok.length !== ids.length) throw badRequest('One or more labels are not available for this project', undefined, 'INVALID_REFERENCE');
  }
  await db.query('DELETE FROM task_labels WHERE task_id = $1', [task.id]);
  for (const id of ids) await db.query('INSERT INTO task_labels (task_id, label_id) VALUES ($1,$2)', [task.id, id]);
  return ids;
}

/** Shared filters for list/board/calendar (exported for the board module). */
export async function taskWhere(ctx, q) {
  const w = where();
  w.add('t.organization_id = ?', ctx.orgId).raw('t.deleted_at IS NULL');
  const ids = await accessibleProjectIds(ctx, 'tasks.view');
  if (ids) w.add('t.project_id = ANY(?::uuid[])', ids);
  w.add('t.project_id = ?', q.projectId);
  if (q.projectIds?.length) w.add('t.project_id = ANY(?::uuid[])', q.projectIds);
  if (q.assigneeId) w.add('EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.member_id = ?)', q.assigneeId === 'me' ? ctx.memberId : q.assigneeId);
  w.add('c.category = ?', q.status).add('t.priority = ?', q.priority);
  w.add('EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ?)', q.labelId);
  if (q.search) w.add('t.title ILIKE ?', `%${q.search}%`);
  return w;
}

export { hours };

