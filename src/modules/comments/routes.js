import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, uuidParam } from '../../lib/http.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { logActivity } from '../../lib/audit.js';
import { emitToProject } from '../../lib/realtime.js';
import { signedGetUrl } from '../../lib/storage.js';
import { notify } from '../notifications/service.js';
import { assertOrgMembers } from '../projects/service.js';
import { resolveEntity } from './service.js';

/** PROJ-21 / TASK-19: comments on projects and tasks with mentions and visibility. */
const r = createRouter('/comments', 'Comments');
const ENTITY = z.enum(['project', 'task']);
const SELECT = `SELECT c.*, u.first_name, u.last_name, u.avatar_key FROM comments c
  LEFT JOIN organization_members m ON m.id = c.author_member_id LEFT JOIN users u ON u.id = m.user_id`;

const dto = (c, ctx) => ({
  id: c.id,
  entityType: c.entity_type,
  entityId: c.entity_id,
  body: c.body,
  visibility: c.visibility,
  mentions: c.mentions ?? [],
  author: c.author_member_id
    ? { memberId: c.author_member_id, name: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim(), avatarUrl: signedGetUrl(c.avatar_key) }
    : null,
  isMine: !!ctx && c.author_member_id === ctx.memberId,
  editedAt: c.edited_at,
  createdAt: c.created_at,
});

async function loadComment(ctx, id) {
  const c = await db.one(`${SELECT} WHERE c.id = $1 AND c.organization_id = $2 AND c.deleted_at IS NULL`, [id, ctx.orgId]);
  if (!c) throw notFound('Comment');
  return c;
}

/** Notify mentioned members and (for tasks) assignees about a new comment. */
async function notifyComment(ctx, entity, comment, mentions) {
  const author = ctx.user ? `${ctx.user.firstName ?? ''} ${ctx.user.lastName ?? ''}`.trim() : 'Someone';
  const snippet = comment.body.length > 140 ? `${comment.body.slice(0, 137)}...` : comment.body;
  const mentioned = mentions.filter((id) => id !== ctx.memberId);
  if (mentioned.length)
    await notify({
      orgId: ctx.orgId,
      memberIds: mentioned,
      type: 'task.comment',
      title: `${author} mentioned you on ${entity.title}`,
      body: snippet,
      link: entity.link,
      data: { commentId: comment.id, entityType: entity.type, entityId: entity.id, projectId: entity.projectId, mention: true },
    });
  if (entity.type === 'task') {
    const assignees = (await db.many('SELECT member_id FROM task_assignees WHERE task_id = $1', [entity.id]))
      .map((x) => x.member_id)
      .filter((id) => id !== ctx.memberId && !mentioned.includes(id));
    if (assignees.length)
      await notify({
        orgId: ctx.orgId,
        memberIds: assignees,
        type: 'task.comment',
        title: `${author} commented on ${entity.title}`,
        body: snippet,
        link: entity.link,
        data: { commentId: comment.id, entityType: 'task', entityId: entity.id, projectId: entity.projectId },
      });
  }
}

r.get(
  '/',
  {
    summary: 'List comments for an entity',
    ids: 'PROJ-21,TASK-19,KAN-14',
    permission: ['projects.view', 'tasks.view'],
    query: paginationQuery.extend({ entityType: ENTITY, entityId: z.uuid(), visibility: z.enum(['internal', 'client']).optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    await resolveEntity(ctx, q.entityType, q.entityId, 'view');
    const params = [ctx.orgId, q.entityType, q.entityId];
    let extra = '';
    if (q.visibility) {
      params.push(q.visibility);
      extra = ` AND c.visibility = $4`;
    }
    const cond = `c.organization_id = $1 AND c.entity_type = $2 AND c.entity_id = $3 AND c.deleted_at IS NULL${extra}`;
    const total = (await db.one(`SELECT count(*) AS n FROM comments c WHERE ${cond}`, params)).n;
    const rows = await db.many(`${SELECT} WHERE ${cond} ORDER BY c.created_at ${q.order === 'desc' && q.sort === 'createdAt' ? 'DESC' : 'ASC'} LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, params);
    ok(res, rows.map((c) => dto(c, ctx)), pageMeta(q, total));
  },
);

r.post(
  '/',
  {
    summary: 'Add comment',
    ids: 'PROJ-21,TASK-19,TASK-25',
    permission: ['projects.view', 'tasks.view'],
    body: z.object({
      entityType: ENTITY,
      entityId: z.uuid(),
      body: z.string().trim().min(1).max(20000),
      visibility: z.enum(['internal', 'client']).default('internal'),
      mentions: z.array(z.uuid()).max(50).default([]),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    const entity = await resolveEntity(ctx, b.entityType, b.entityId, 'view');
    const mentions = [...new Set(b.mentions)];
    await assertOrgMembers(ctx.orgId, mentions);
    const row = await db.one(
      `INSERT INTO comments (organization_id, entity_type, entity_id, author_member_id, body, visibility, mentions)
       VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[]) RETURNING id`,
      [ctx.orgId, b.entityType, b.entityId, ctx.memberId ?? null, b.body, b.visibility, mentions],
    );
    const c = await loadComment(ctx, row.id);
    await logActivity(ctx, b.entityType, b.entityId, 'commented', { commentId: c.id });
    await notifyComment(ctx, entity, c, mentions);
    const out = dto(c, ctx);
    emitToProject(entity.projectId, 'comment.created', out);
    created(res, out);
  },
);

r.patch(
  '/:id',
  {
    summary: 'Edit comment (author or admin)',
    ids: 'PROJ-21,TASK-19',
    permission: ['projects.view', 'tasks.view'],
    params: uuidParam,
    body: z.object({ body: z.string().trim().min(1).max(20000).optional(), visibility: z.enum(['internal', 'client']).optional(), mentions: z.array(z.uuid()).max(50).optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const c = await loadComment(ctx, req.v.params.id);
    if (c.author_member_id !== ctx.memberId && !ctx.isAdminLike()) throw forbidden('Only the author or an admin can edit this comment');
    const entity = await resolveEntity(ctx, c.entity_type, c.entity_id, 'view');
    const b = req.body;
    const mentions = b.mentions ? [...new Set(b.mentions)] : c.mentions;
    if (b.mentions) await assertOrgMembers(ctx.orgId, mentions);
    await db.query(`UPDATE comments SET body = $2, visibility = $3, mentions = $4::uuid[], edited_at = now() WHERE id = $1`, [
      c.id,
      b.body ?? c.body,
      b.visibility ?? c.visibility,
      mentions,
    ]);
    const u = await loadComment(ctx, c.id);
    const newMentions = mentions.filter((id) => !(c.mentions ?? []).includes(id) && id !== ctx.memberId);
    if (newMentions.length) {
      const author = ctx.user ? `${ctx.user.firstName ?? ''} ${ctx.user.lastName ?? ''}`.trim() : 'Someone';
      await notify({
        orgId: ctx.orgId,
        memberIds: newMentions,
        type: 'task.comment',
        title: `${author} mentioned you on ${entity.title}`,
        body: u.body.slice(0, 140),
        link: entity.link,
        data: { commentId: u.id, entityType: entity.type, entityId: entity.id, projectId: entity.projectId, mention: true },
      });
    }
    ok(res, dto(u, ctx));
  },
);

r.delete('/:id', { summary: 'Delete comment (author or admin)', ids: 'PROJ-21,TASK-19', permission: ['projects.view', 'tasks.view'], params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  const c = await loadComment(ctx, req.v.params.id);
  if (c.author_member_id !== ctx.memberId && !ctx.isAdminLike()) throw forbidden('Only the author or an admin can delete this comment');
  await db.query('UPDATE comments SET deleted_at = now() WHERE id = $1', [c.id]);
  await logActivity(ctx, c.entity_type, c.entity_id, 'comment_deleted', { commentId: c.id });
  noContent(res);
});

export default r;
