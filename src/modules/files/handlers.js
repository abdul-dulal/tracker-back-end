import express from 'express';
import { getObject, objectExists, putObject, verifyGetSignature, verifyPutSignature } from '../../lib/storage.js';
import { db } from '../../lib/db.js';
import { AppError, notFound } from '../../lib/errors.js';
import { assertStorageAvailable } from '../subscription/features.js';
import { registerRoute } from '../../docs/registry.js';

/**
 * Local storage driver endpoints (signed URLs, SEC-09). Not part of the createRouter() helper
 * because the signature itself is the authorization.
 *   PUT /api/v1/files/<key>?exp&sig&ct&max…  raw body upload
 *   GET /api/v1/files/<key>?exp&sig&dl&fn    download/preview
 */
const router = express.Router();

router.put(
  /^\/(.+)$/,
  express.raw({ type: () => true, limit: '500mb' }),
  async (req, res) => {
    const key = req.params[0];
    const meta = verifyPutSignature(key, req.query);
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) throw new AppError(400, 'EMPTY_UPLOAD', 'Empty upload body');
    if (body.length > meta.max) throw new AppError(413, 'FILE_TOO_LARGE', 'File exceeds the allowed size');
    const ct = (req.get('content-type') ?? '').split(';')[0];
    if (ct && meta.contentType && ct !== meta.contentType) throw new AppError(400, 'CONTENT_TYPE_MISMATCH', 'Content-Type does not match the signed upload');
    if (meta.orgId) await assertStorageAvailable(meta.orgId, body.length);
    const existing = await db.one('SELECT uploaded_at FROM files WHERE key = $1', [key]);
    if (existing?.uploaded_at) throw new AppError(409, 'ALREADY_UPLOADED', 'This upload URL has already been used');
    await putObject(key, body, { contentType: meta.contentType, orgId: meta.orgId, purpose: meta.purpose, userId: meta.userId });
    res.status(200).json({ data: { key, size: body.length } });
  },
);

router.get(/^\/(.+)$/, async (req, res) => {
  const key = req.params[0];
  verifyGetSignature(key, req.query);
  if (!(await objectExists(key))) throw notFound('File');
  const row = await db.one('SELECT content_type FROM files WHERE key = $1', [key]);
  res.setHeader('Content-Type', row?.content_type ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.query.dl === '1') {
    const fn = String(req.query.fn || key.split('/').pop()).replace(/[^\w.\- ]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
  } else {
    res.setHeader('Content-Disposition', 'inline');
  }
  res.send(await getObject(key));
});

registerRoute({ method: 'put', prefix: '/files', path: '/:key', tag: 'Files', auth: 'public', summary: 'Upload to a signed URL (raw body)', ids: 'SEC-09' });
registerRoute({ method: 'get', prefix: '/files', path: '/:key', tag: 'Files', auth: 'public', summary: 'Download from a signed URL', ids: 'SEC-09' });

export default { router, prefix: '/files' };
