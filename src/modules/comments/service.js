import { db } from '../../lib/db.js';
import { notFound, badRequest, forbidden } from '../../lib/errors.js';
import { assertProjectAccess } from '../../rbac/scope.js';
import { loadProject } from '../projects/service.js';
import { loadTask, assertTaskUpdate } from '../tasks/service.js';

/**
 * Resolve a commentable/attachable entity and enforce access.
 * mode 'view'  → projects.view / tasks.view on the project
 * mode 'write' → projects.update on the project / tasks.update (own = assignee) on the task
 */
export async function resolveEntity(ctx, entityType, entityId, mode = 'view') {
  if (entityType === 'project') {
    const p = await loadProject(ctx.orgId, entityId);
    await assertProjectAccess(ctx, mode === 'write' ? 'projects.update' : 'projects.view', p.id);
    return { type: 'project', id: p.id, projectId: p.id, title: p.name, link: `/projects/${p.id}` };
  }
  if (entityType === 'task') {
    const t = await loadTask(ctx.orgId, entityId);
    if (mode === 'write') await assertTaskUpdate(ctx, t);
    else await assertProjectAccess(ctx, 'tasks.view', t.project_id);
    return { type: 'task', id: t.id, projectId: t.project_id, title: t.title, task: t, link: `/projects/${t.project_id}/tasks/${t.id}` };
  }
  if (entityType === 'comment') {
    const c = await db.one('SELECT * FROM comments WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [entityId, ctx.orgId]);
    if (!c) throw notFound('Comment');
    const parent = await resolveEntity(ctx, c.entity_type, c.entity_id, 'view');
    if (mode === 'write' && c.author_member_id !== ctx.memberId && !ctx.isAdminLike())
      throw forbidden('Only the comment author can attach files to this comment');
    return { ...parent, type: 'comment', id: c.id, parent };
  }
  throw badRequest(`Unsupported entity type: ${entityType}`, undefined, 'INVALID_ENTITY_TYPE');
}
