import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { signedGetUrl } from '../../lib/storage.js';

/** Export job status & download link (SS-25; shared by any export_jobs producer). */
const r = createRouter('/exports', 'Exports');

export function exportDto(j) {
  const ready = j.status === 'done' && j.file_key && (!j.expires_at || new Date(j.expires_at) > new Date());
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    fileName: j.file_name,
    error: j.error,
    params: j.params?.filters ?? j.params ?? {},
    downloadUrl: ready ? signedGetUrl(j.file_key, { download: true, filename: j.file_name ?? undefined, ttl: 3600 }) : null,
    expiresAt: j.expires_at,
    createdAt: j.created_at,
    finishedAt: j.finished_at,
  };
}

r.get('/:id', { summary: 'Export job status and signed download link', ids: 'SS-25, RPT-*', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const ctx = req.ctx;
  const j = await db.one('SELECT * FROM export_jobs WHERE id = $1 AND organization_id = $2', [req.v.params.id, ctx.orgId]);
  if (!j || (j.requested_by !== ctx.memberId && !ctx.isAdminLike())) throw notFound('Export');
  ok(res, exportDto(j));
});

export default r;
