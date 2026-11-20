import { z } from 'zod';
import { createRouter, zColor, zCsvUuids } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, uuidParam } from '../../lib/http.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { assertProjectAccess } from '../../rbac/scope.js';
import { logActivity } from '../../lib/audit.js';
import { emitToProject } from '../../lib/realtime.js';
import { getProjectFor, loadProject } from '../projects/service.js';
import { CATEGORIES, taskWhere, fetchCards, projectColumns, endPosition } from '../tasks/service.js';

/** M11 Kanban board: board views and column management. */
const CATEGORY = z.enum(CATEGORIES);
const PRIORITY = z.enum(['low', 'medium', 'high', 'urgent']);
const zAssignee = z.union([z.uuid(), z.literal('me')]);
const boardFilters = z.object({
  assigneeId: zAssignee.optional(),
  priority: PRIORITY.optional(),
  labelId: z.uuid().optional(),
  search: z.string().trim().max(200).optional(),
});
const tz = (ctx) => ctx.orgTimezone ?? ctx.timezone ?? 'UTC';
const CATEGORY_NAMES = { todo: 'To Do', in_progress: 'In Progress', in_review: 'In Review', done: 'Completed' };

const columnDto = (c, extra = {}) => ({
  id: c.id,
  projectId: c.project_id,
  name: c.name,
  category: c.category,
  position: c.position,
  color: c.color,
  wipLimit: c.wip_limit,
  ...extra,
});

async function taskCounts(projectId) {
  const rows = await db.many(
    `SELECT column_id, count(*) AS n FROM tasks WHERE project_id = $1 AND deleted_at IS NULL AND parent_task_id IS NULL GROUP BY column_id`,
    [projectId],
  );
  return new Map(rows.map((r) => [r.column_id, r.n]));
}

// ───────────────────────── /projects/:id/board & columns ─────────────────────────
const p = createRouter('/projects', 'Kanban');

p.get(
  '/:id/board',
  { summary: 'Project Kanban board', ids: 'KAN-07,KAN-09..14,KAN-16,KAN-18,KAN-19,KAN-20', permission: 'tasks.view', params: uuidParam, query: boardFilters },
  async (req, res) => {
    const ctx = req.ctx;
    const project = await getProjectFor(ctx, req.v.params.id, 'tasks.view');
    const columns = await projectColumns(project.id);
    const w = await taskWhere(ctx, { ...req.v.query, projectId: project.id });
    w.raw('t.parent_task_id IS NULL');
    const cards = await fetchCards(w, tz(ctx), { orderBy: 't.position, t.created_at' });
    const byColumn = new Map(columns.map((c) => [c.id, []]));
    const unassigned = [];
    for (const card of cards) (byColumn.get(card.columnId) ?? unassigned).push(card);
    ok(res, {
      project: { id: project.id, name: project.name, color: project.color, archived: !!project.archived_at },
      columns: columns.map((c) => columnDto(c, { taskCount: byColumn.get(c.id).length, cards: byColumn.get(c.id) })),
      ...(unassigned.length ? { unassigned } : {}),
    });
  },
);

p.get('/:id/columns', { summary: 'List board columns', ids: 'KAN-06', permission: 'tasks.view', params: uuidParam }, async (req, res) => {
  const project = await getProjectFor(req.ctx, req.v.params.id, 'tasks.view');
  const counts = await taskCounts(project.id);
  ok(res, (await projectColumns(project.id)).map((c) => columnDto(c, { taskCount: counts.get(c.id) ?? 0 })));
});

p.post(
  '/:id/columns',
  {
    summary: 'Create board column',
    ids: 'KAN-06',
    permission: 'board.manage_columns',
    params: uuidParam,
    body: z.object({
      name: z.string().trim().min(1).max(80),
      category: CATEGORY.default('in_progress'),
      color: zColor.nullable().optional(),
      wipLimit: z.number().int().min(1).max(1000).nullable().optional(),
      afterColumnId: z.uuid().optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const project = await getProjectFor(ctx, req.v.params.id, 'board.manage_columns');
    const cols = await projectColumns(project.id);
    let position = (cols.at(-1)?.position ?? 0) + 1;
    if (req.body.afterColumnId) {
      const i = cols.findIndex((c) => c.id === req.body.afterColumnId);
      if (i < 0) throw badRequest('afterColumnId is not a column of this project', undefined, 'INVALID_REFERENCE');
      position = cols[i + 1] ? (cols[i].position + cols[i + 1].position) / 2 : cols[i].position + 1;
    }
    const c = await db.one(
      `INSERT INTO board_columns (organization_id, project_id, name, category, position, color, wip_limit) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ctx.orgId, project.id, req.body.name, req.body.category, position, req.body.color ?? null, req.body.wipLimit ?? null],
    );
    await logActivity(ctx, 'project', project.id, 'column_created', { columnId: c.id, name: c.name });
    const dto = columnDto(c, { taskCount: 0 });
    emitToProject(project.id, 'board.columns_updated', { projectId: project.id });
    created(res, dto);
  },
);

p.post(
  '/:id/columns/reorder',
  { summary: 'Reorder board columns', ids: 'KAN-06', permission: 'board.manage_columns', params: uuidParam, body: z.object({ columnIds: z.array(z.uuid()).min(1) }) },
  async (req, res) => {
    const ctx = req.ctx;
    const project = await getProjectFor(ctx, req.v.params.id, 'board.manage_columns');
    const cols = await projectColumns(project.id);
    const ids = req.body.columnIds;
    if (new Set(ids).size !== ids.length || ids.length !== cols.length || !cols.every((c) => ids.includes(c.id)))
      throw badRequest('columnIds must list every column of the project exactly once', undefined, 'INVALID_COLUMN_ORDER');
    await db.tx(async () => {
      for (let i = 0; i < ids.length; i++) await db.query('UPDATE board_columns SET position = $2 WHERE id = $1', [ids[i], i + 1]);
    });
    emitToProject(project.id, 'board.columns_updated', { projectId: project.id });
    const counts = await taskCounts(project.id);
    ok(res, (await projectColumns(project.id)).map((c) => columnDto(c, { taskCount: counts.get(c.id) ?? 0 })));
  },
);

// ───────────────────────── /columns/:id ─────────────────────────
const c = createRouter('/columns', 'Kanban');

async function loadColumnFor(ctx, id) {
  const col = await db.one('SELECT * FROM board_columns WHERE id = $1 AND organization_id = $2', [id, ctx.orgId]);
  if (!col) throw notFound('Column');
  await loadProject(ctx.orgId, col.project_id);
  await assertProjectAccess(ctx, 'board.manage_columns', col.project_id);
  return col;
}

/** KAN-06: a project must keep at least one todo and one done column. */
function assertRequiredCategories(columns) {
  for (const cat of ['todo', 'done']) {
    if (!columns.some((x) => x.category === cat))
      throw unprocessable('COLUMN_REQUIRED', `A board must keep at least one ${CATEGORY_NAMES[cat]} (${cat}) column`);
  }
}

c.patch(
  '/:id',
  {
    summary: 'Update board column',
    ids: 'KAN-06',
    permission: 'board.manage_columns',
    params: uuidParam,
    body: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      category: CATEGORY.optional(),
      color: zColor.nullable().optional(),
      wipLimit: z.number().int().min(1).max(1000).nullable().optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const col = await loadColumnFor(ctx, req.v.params.id);
    const b = req.body;
    if (b.category && b.category !== col.category) {
      const cols = (await projectColumns(col.project_id)).map((x) => (x.id === col.id ? { ...x, category: b.category } : x));
      assertRequiredCategories(cols);
    }
    const u = await db.tx(async () => {
      const row = await db.one(
        `UPDATE board_columns SET name = $2, category = $3, color = $4, wip_limit = $5 WHERE id = $1 RETURNING *`,
        [col.id, b.name ?? col.name, b.category ?? col.category, b.color === undefined ? col.color : b.color, b.wipLimit === undefined ? col.wip_limit : b.wipLimit],
      );
      if (b.category && b.category !== col.category) {
        // Keep completion state consistent with the column's new category.
        if (b.category === 'done') await db.query(`UPDATE tasks SET completed_at = coalesce(completed_at, now()) WHERE column_id = $1 AND deleted_at IS NULL`, [col.id]);
        else await db.query(`UPDATE tasks SET completed_at = NULL WHERE column_id = $1 AND deleted_at IS NULL`, [col.id]);
      }
      return row;
    });
    await logActivity(ctx, 'project', col.project_id, 'column_updated', { columnId: col.id, name: u.name, category: u.category });
    emitToProject(col.project_id, 'board.columns_updated', { projectId: col.project_id });
    ok(res, columnDto(u));
  },
);

c.delete(
  '/:id',
  { summary: 'Delete board column (tasks move to a same-category column)', ids: 'KAN-06', permission: 'board.manage_columns', params: uuidParam, query: z.object({ moveToColumnId: z.uuid().optional() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const col = await loadColumnFor(ctx, req.v.params.id);
    const cols = await projectColumns(col.project_id);
    const rest = cols.filter((x) => x.id !== col.id);
    assertRequiredCategories(rest);
    let target;
    if (req.v.query.moveToColumnId) {
      target = rest.find((x) => x.id === req.v.query.moveToColumnId);
      if (!target) throw badRequest('moveToColumnId is not another column of this project', undefined, 'INVALID_REFERENCE');
      if (target.category !== col.category) throw unprocessable('COLUMN_CATEGORY_MISMATCH', 'Tasks can only be moved to a column of the same category');
    } else {
      // Same category first; otherwise the nearest preceding column (falls back to the first column).
      target = rest.find((x) => x.category === col.category) ?? [...rest].reverse().find((x) => x.position < col.position) ?? rest[0];
    }
    await db.tx(async () => {
      let pos = await endPosition(target.id);
      const tasks = await db.many('SELECT id FROM tasks WHERE column_id = $1 AND deleted_at IS NULL ORDER BY position, created_at', [col.id]);
      for (const t of tasks) {
        await db.query(
          `UPDATE tasks SET column_id = $2, position = $3,
             completed_at = CASE WHEN $4 = 'done' THEN coalesce(completed_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1`,
          [t.id, target.id, pos++, target.category],
        );
      }
      await db.query(`UPDATE tasks SET column_id = $2 WHERE column_id = $1`, [col.id, target.id]); // soft-deleted leftovers
      await db.query('DELETE FROM board_columns WHERE id = $1', [col.id]);
    });
    await logActivity(ctx, 'project', col.project_id, 'column_deleted', { columnId: col.id, name: col.name, movedTo: target.id });
    emitToProject(col.project_id, 'board.columns_updated', { projectId: col.project_id });
    noContent(res);
  },
);

// ───────────────────────── /board (cross-project, KAN-17) ─────────────────────────
const b = createRouter('/board', 'Kanban');

b.get(
  '/',
  { summary: 'Cross-project board grouped by status category', ids: 'KAN-17', permission: 'tasks.view', query: boardFilters.extend({ projectIds: zCsvUuids.optional() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const w = await taskWhere(ctx, req.v.query);
    w.raw('t.parent_task_id IS NULL').raw('p.archived_at IS NULL');
    const cards = await fetchCards(w, tz(ctx), { orderBy: 'p.name, c.position, t.position', limit: 2000 });
    ok(res, {
      columns: CATEGORIES.map((cat) => {
        const list = cards.filter((x) => x.status === cat);
        return { category: cat, name: CATEGORY_NAMES[cat], taskCount: list.length, cards: list };
      }),
    });
  },
);

export default [p, c, b];
