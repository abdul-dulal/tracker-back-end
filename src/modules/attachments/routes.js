import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, uuidParam } from '../../lib/http.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { logActivity } from '../../lib/audit.js';
import { createUpload, assertUploaded, signedGetUrl, deleteObject } from '../../lib/storage.js';
import { assertStorageAvailable } from '../subscription/features.js';
import { resolveEntity } from '../comments/service.js';

/** PROJ-20 / TASK-20: attachments via signed uploads. */
const r = createRouter('/attachments', 'Attachments');
const ENTITY = z.enum(['project', 'task', 'comment']);
const fileName = z.string().trim().min(1).max(255).refine((s) => !/[\\/\0]/.test(s), 'Invalid file name');

const dto = (a) => ({
  id: a.id,
  entityType: a.entity_type,
  entityId: a.entity_id,
  fileName: a.file_name,
  contentType: a.mime,
  size: Number(a.size_bytes),
  uploadedBy: a.uploaded_by ? { memberId: a.uploaded_by, name: `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() } : null,
  url: signedGetUrl(a.file_key, { filename: a.file_name }),
  createdAt: a.created_at,
});
const SELECT = `SELECT a.*, u.first_name, u.last_name FROM attachments a
  LEFT JOIN organization_members m ON m.id = a.uploaded_by LEFT JOIN users u ON u.id = m.user_id`;

/** Logged activity goes to the owning project/task (comments log on their parent). */
const activityTarget = (entity) => (entity.type === 'comment' ? entity.parent : entity);

async function loadAttachment(ctx, id) {
  const a = await db.one(`${SELECT} WHERE a.id = $1 AND a.organization_id = $2 AND a.deleted_at IS NULL`, [id, ctx.orgId]);
  if (!a) throw notFound('Attachment');
  return a;
}

r.post(
  '/upload-url',
  {
    summary: 'Get a signed upload URL for an attachment',
    ids: 'PROJ-20,TASK-20',
    permission: ['projects.view', 'tasks.view'],
    body: z.object({
      entityType: ENTITY,
      entityId: z.uuid(),
      fileName,
      contentType: z.string().trim().min(3).max(120).regex(/^[\w.+-]+\/[\w.+-]+$/, 'Invalid content type'),
      size: z.number().int().positive(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    await resolveEntity(ctx, b.entityType, b.entityId, 'write');
    await assertStorageAvailable(ctx.orgId, b.size);
    const upload = await createUpload({ orgId: ctx.orgId, purpose: 'attachment', contentType: b.contentType, size: b.size, userId: ctx.userId });
    ok(res, upload);
  },
);

r.post(
  '/',
  {
    summary: 'Register an uploaded attachment',
    ids: 'PROJ-20,TASK-20',
    permission: ['projects.view', 'tasks.view'],
    body: z.object({ key: z.string().min(1).max(512), entityType: ENTITY, entityId: z.uuid(), fileName }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    const entity = await resolveEntity(ctx, b.entityType, b.entityId, 'write');
    const file = await assertUploaded(b.key, { orgId: ctx.orgId, purpose: 'attachment' });
    if (await db.one('SELECT 1 FROM attachments WHERE file_key = $1 AND deleted_at IS NULL', [b.key]))
      throw badRequest('This file is already attached', undefined, 'FILE_ALREADY_ATTACHED');
    const row = await db.one(
      `INSERT INTO attachments (organization_id, entity_type, entity_id, file_key, file_name, mime, size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ctx.orgId, b.entityType, b.entityId, b.key, b.fileName, file.content_type, file.size_bytes ?? 0, ctx.memberId ?? null],
    );
    const target = activityTarget(entity);
    await logActivity(ctx, target.type, target.id, 'attachment_added', { attachmentId: row.id, fileName: b.fileName });
    created(res, dto(await loadAttachment(ctx, row.id)));
  },
);

r.get(
  '/',
  { summary: 'List attachments of an entity', ids: 'PROJ-20,TASK-20', permission: ['projects.view', 'tasks.view'], query: z.object({ entityType: ENTITY, entityId: z.uuid() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    await resolveEntity(ctx, q.entityType, q.entityId, 'view');
    const rows = await db.many(
      `${SELECT} WHERE a.organization_id = $1 AND a.entity_type = $2 AND a.entity_id = $3 AND a.deleted_at IS NULL ORDER BY a.created_at DESC`,
      [ctx.orgId, q.entityType, q.entityId],
    );
    ok(res, rows.map(dto));
  },
);

r.get('/:id/download', { summary: 'Signed download URL', ids: 'PROJ-20,TASK-20', permission: ['projects.view', 'tasks.view'], params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  const a = await loadAttachment(ctx, req.v.params.id);
  await resolveEntity(ctx, a.entity_type, a.entity_id, 'view');
  ok(res, { url: signedGetUrl(a.file_key, { download: true, filename: a.file_name }), fileName: a.file_name });
});

r.delete('/:id', { summary: 'Delete attachment', ids: 'PROJ-20,TASK-20', permission: ['projects.view', 'tasks.view'], params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  const a = await loadAttachment(ctx, req.v.params.id);
  if (a.uploaded_by === ctx.memberId) await resolveEntity(ctx, a.entity_type, a.entity_id, 'view');
  else if (ctx.isAdminLike()) await resolveEntity(ctx, a.entity_type, a.entity_id, 'view');
  else {
    const entity = await resolveEntity(ctx, a.entity_type, a.entity_id, 'write');
    if (entity.type === 'task' && ctx.can('tasks.update') === 'own') throw forbidden('Only the uploader can delete this attachment');
  }
  await db.query('UPDATE attachments SET deleted_at = now() WHERE id = $1', [a.id]);
  await deleteObject(a.file_key);
  const entity = await resolveEntity(ctx, a.entity_type, a.entity_id, 'view').catch(() => null);
  if (entity) {
    const target = activityTarget(entity);
    await logActivity(ctx, target.type, target.id, 'attachment_deleted', { attachmentId: a.id, fileName: a.file_name });
  }
  noContent(res);
});

export default r;
