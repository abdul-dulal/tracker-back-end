import { z } from 'zod';
import { createRouter, zColor } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, uuidParam } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';

/** TASK-16: task categories (org-wide taxonomy). */
const r = createRouter('/task-categories', 'Tasks');
const dto = (c) => ({ id: c.id, name: c.name, color: c.color, taskCount: c.task_count ?? undefined });

r.get('/', { summary: 'List task categories', ids: 'TASK-16', permission: 'tasks.view' }, async (req, res) => {
  const rows = await db.many(
    `SELECT c.*, (SELECT count(*) FROM tasks t WHERE t.category_id = c.id AND t.deleted_at IS NULL) AS task_count
     FROM task_categories c WHERE c.organization_id = $1 ORDER BY lower(c.name)`,
    [req.ctx.orgId],
  );
  ok(res, rows.map(dto));
});

r.post(
  '/',
  { summary: 'Create task category', ids: 'TASK-16', permission: 'tasks.update', body: z.object({ name: z.string().trim().min(1).max(80), color: zColor.nullable().optional() }) },
  async (req, res) => {
    const ctx = req.ctx;
    ctx.require('tasks.update', 'project');
    const c = await db.one('INSERT INTO task_categories (organization_id, name, color) VALUES ($1,$2,$3) RETURNING *', [ctx.orgId, req.body.name, req.body.color ?? null]);
    created(res, dto(c));
  },
);

r.patch(
  '/:id',
  {
    summary: 'Update task category',
    ids: 'TASK-16',
    permission: 'tasks.update',
    params: uuidParam,
    body: z.object({ name: z.string().trim().min(1).max(80).optional(), color: zColor.nullable().optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    ctx.require('tasks.update', 'project');
    if (req.body.name === undefined && req.body.color === undefined) throw badRequest('Nothing to update');
    const c = await db.one(
      `UPDATE task_categories SET name = coalesce($3, name), color = CASE WHEN $4::boolean THEN $5 ELSE color END
       WHERE id = $1 AND organization_id = $2 RETURNING *`,
      [req.v.params.id, ctx.orgId, req.body.name ?? null, req.body.color !== undefined, req.body.color ?? null],
    );
    if (!c) throw notFound('Task category');
    ok(res, dto(c));
  },
);

r.delete('/:id', { summary: 'Delete task category', ids: 'TASK-16', permission: 'tasks.update', params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  ctx.require('tasks.update', 'project');
  const d = await db.query('DELETE FROM task_categories WHERE id = $1 AND organization_id = $2', [req.v.params.id, ctx.orgId]);
  if (!d.rowCount) throw notFound('Task category');
  noContent(res);
});

export default r;
