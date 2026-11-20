import { z } from 'zod';
import { createRouter, zColor } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, uuidParam } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { accessibleProjectIds, assertProjectAccess } from '../../rbac/scope.js';
import { loadProject } from '../projects/service.js';

/** TASK-15 / KAN-12: labels — org-wide (projectId null) or project-specific. */
const r = createRouter('/labels', 'Tasks');
const dto = (l) => ({ id: l.id, name: l.name, color: l.color, projectId: l.project_id });

/** Writing org-wide labels needs org-ish scope; project labels need tasks.update on that project. */
async function assertLabelWrite(ctx, projectId) {
  if (projectId) {
    await loadProject(ctx.orgId, projectId);
    await assertProjectAccess(ctx, 'tasks.update', projectId);
    ctx.require('tasks.update', 'project');
  } else {
    ctx.require('tasks.update', 'project');
  }
}

async function loadLabel(ctx, id) {
  const l = await db.one('SELECT * FROM labels WHERE id = $1 AND organization_id = $2', [id, ctx.orgId]);
  if (!l) throw notFound('Label');
  return l;
}

r.get('/', { summary: 'List labels', ids: 'TASK-15', permission: 'tasks.view', query: z.object({ projectId: z.uuid().optional() }) }, async (req, res) => {
  const ctx = req.ctx;
  const ids = await accessibleProjectIds(ctx, 'tasks.view');
  const params = [ctx.orgId];
  let cond = 'project_id IS NULL';
  if (req.v.query.projectId) {
    if (ids && !ids.includes(req.v.query.projectId)) return ok(res, (await db.many(`SELECT * FROM labels WHERE organization_id = $1 AND ${cond} ORDER BY lower(name)`, params)).map(dto));
    params.push(req.v.query.projectId);
    cond = `(project_id IS NULL OR project_id = $2)`;
  } else if (ids) {
    params.push(ids);
    cond = `(project_id IS NULL OR project_id = ANY($2::uuid[]))`;
  } else {
    cond = 'true';
  }
  const rows = await db.many(`SELECT * FROM labels WHERE organization_id = $1 AND ${cond} ORDER BY project_id NULLS FIRST, lower(name)`, params);
  ok(res, rows.map(dto));
});

r.post(
  '/',
  {
    summary: 'Create label',
    ids: 'TASK-15',
    permission: 'tasks.update',
    body: z.object({ name: z.string().trim().min(1).max(60), color: zColor.nullable().optional(), projectId: z.uuid().nullable().optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    await assertLabelWrite(ctx, req.body.projectId);
    const l = await db.one('INSERT INTO labels (organization_id, project_id, name, color) VALUES ($1,$2,$3,$4) RETURNING *', [
      ctx.orgId,
      req.body.projectId ?? null,
      req.body.name,
      req.body.color ?? null,
    ]);
    created(res, dto(l));
  },
);

r.patch(
  '/:id',
  { summary: 'Update label', ids: 'TASK-15', permission: 'tasks.update', params: uuidParam, body: z.object({ name: z.string().trim().min(1).max(60).optional(), color: zColor.nullable().optional() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const l = await loadLabel(ctx, req.v.params.id);
    await assertLabelWrite(ctx, l.project_id);
    if (req.body.name === undefined && req.body.color === undefined) throw badRequest('Nothing to update');
    const u = await db.one(`UPDATE labels SET name = $2, color = $3 WHERE id = $1 RETURNING *`, [
      l.id,
      req.body.name ?? l.name,
      req.body.color === undefined ? l.color : req.body.color,
    ]);
    ok(res, dto(u));
  },
);

r.delete('/:id', { summary: 'Delete label', ids: 'TASK-15', permission: 'tasks.update', params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  const l = await loadLabel(ctx, req.v.params.id);
  await assertLabelWrite(ctx, l.project_id);
  await db.query('DELETE FROM labels WHERE id = $1', [l.id]);
  noContent(res);
});

export default r;
