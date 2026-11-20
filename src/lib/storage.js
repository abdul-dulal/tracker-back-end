import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { db } from './db.js';
import { hmac, safeEqual, uuid } from './crypto.js';
import { badRequest, AppError } from './errors.js';

/**
 * Object storage with signed URLs (SEC-08/SEC-09).
 * Local driver: files on disk under STORAGE_DIR, served through /api/v1/files with HMAC-signed,
 * expiring URLs. An S3 driver can implement the same interface (putObject/getObject/deleteObject/
 * signedGetUrl/signedPutUrl) without changing callers.
 */
const root = path.resolve(env.STORAGE_DIR);
const GET_TTL = 5 * 60;
const PUT_TTL = 10 * 60;

const safeKey = (key) => {
  if (!/^[a-zA-Z0-9/_\-.]+$/.test(key) || key.includes('..')) throw badRequest('Invalid file key');
  return key;
};
const filePath = (key) => path.join(root, safeKey(key));
const now = () => Math.floor(Date.now() / 1000);

export const MAX_UPLOAD_BYTES = {
  avatar: 5 * 1024 * 1024,
  logo: 5 * 1024 * 1024,
  attachment: 50 * 1024 * 1024,
  screenshot: 15 * 1024 * 1024,
  import: 10 * 1024 * 1024,
  export: 500 * 1024 * 1024,
};

/** Build a storage key: org/{orgId}/{purpose}/{yyyy}/{mm}/{uuid}{ext} */
export function buildKey({ orgId, purpose, ext = '' }) {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const owner = orgId ? `org/${orgId}` : 'global';
  const safeExt = ext && /^\.[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : '';
  return `${owner}/${purpose}/${yyyy}/${mm}/${dd}/${uuid()}${safeExt}`;
}

export const extFromContentType = (ct = '') =>
  ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/csv': '.csv',
    'application/zip': '.zip',
    'application/json': '.json',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  })[ct.split(';')[0].trim()] ?? '';

export async function putObject(key, buffer, { contentType, orgId, purpose = 'misc', userId } = {}) {
  const p = filePath(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, buffer);
  await db.query(
    `INSERT INTO files (key, organization_id, purpose, content_type, size_bytes, uploaded_by, uploaded_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, content_type = EXCLUDED.content_type, uploaded_at = now()`,
    [key, orgId ?? null, purpose, contentType ?? null, buffer.length, userId ?? null],
  );
  if (orgId) await addStorageUsage(orgId, buffer.length);
  return { key, size: buffer.length };
}

export async function getObject(key) {
  return fs.readFile(filePath(key));
}

export async function objectExists(key) {
  try {
    await fs.access(filePath(key));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key) {
  if (!key) return;
  const row = await db.one('DELETE FROM files WHERE key = $1 RETURNING organization_id, size_bytes', [key]);
  await fs.rm(filePath(key), { force: true });
  if (row?.organization_id) await addStorageUsage(row.organization_id, -Number(row.size_bytes));
}

export async function addStorageUsage(orgId, delta) {
  await db.query(
    `INSERT INTO usage_counters (organization_id, metric, value) VALUES ($1, 'storage_bytes', greatest($2::bigint, 0))
     ON CONFLICT (organization_id, metric) DO UPDATE SET value = greatest(usage_counters.value + $2::bigint, 0), updated_at = now()`,
    [orgId, delta],
  );
}

const sign = (parts) => hmac(parts.join('|'));

/** Signed, expiring download URL (relative to API origin). */
export function signedGetUrl(key, { ttl = GET_TTL, download, filename } = {}) {
  if (!key) return null;
  const exp = now() + ttl;
  const dl = download ? '1' : '0';
  const sig = sign(['get', key, exp, dl, filename ?? '']);
  const qs = new URLSearchParams({ exp: String(exp), sig, dl });
  if (filename) qs.set('fn', filename);
  return `${env.APP_URL}/api/v1/files/${key}?${qs}`;
}

/**
 * Create a signed upload URL. The client PUTs the raw file body to it.
 * Returns { uploadUrl, key, method, headers, expiresAt }.
 */
export async function createUpload({ orgId, purpose, contentType, size, userId, allowedTypes }) {
  const max = MAX_UPLOAD_BYTES[purpose] ?? MAX_UPLOAD_BYTES.attachment;
  if (size > max) throw badRequest(`File too large (max ${Math.round(max / 1024 / 1024)} MB)`, undefined, 'FILE_TOO_LARGE');
  if (allowedTypes && !allowedTypes.some((t) => contentType.startsWith(t)))
    throw badRequest('File type not allowed', { allowed: allowedTypes }, 'FILE_TYPE_NOT_ALLOWED');
  const key = buildKey({ orgId, purpose, ext: extFromContentType(contentType) });
  const exp = now() + PUT_TTL;
  const sig = sign(['put', key, exp, contentType, max, orgId ?? '', purpose, userId ?? '']);
  const qs = new URLSearchParams({ exp: String(exp), sig, ct: contentType, max: String(max), org: orgId ?? '', p: purpose, u: userId ?? '' });
  return {
    uploadUrl: `${env.APP_URL}/api/v1/files/${key}?${qs}`,
    key,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyGetSignature(key, q) {
  const exp = Number(q.exp);
  if (!exp || exp < now()) throw new AppError(403, 'URL_EXPIRED', 'This link has expired');
  const expected = sign(['get', key, exp, q.dl ?? '0', q.fn ?? '']);
  if (!safeEqual(expected, q.sig ?? '')) throw new AppError(403, 'INVALID_SIGNATURE', 'Invalid link signature');
}

export function verifyPutSignature(key, q) {
  const exp = Number(q.exp);
  if (!exp || exp < now()) throw new AppError(403, 'URL_EXPIRED', 'Upload URL has expired');
  const expected = sign(['put', key, exp, q.ct, q.max, q.org ?? '', q.p, q.u ?? '']);
  if (!safeEqual(expected, q.sig ?? '')) throw new AppError(403, 'INVALID_SIGNATURE', 'Invalid upload signature');
  return { contentType: q.ct, max: Number(q.max), orgId: q.org || null, purpose: q.p, userId: q.u || null };
}

/** Ensure an uploaded key exists, belongs to the org and purpose. Returns file row. */
export async function assertUploaded(key, { orgId, purpose }) {
  const row = await db.one('SELECT * FROM files WHERE key = $1', [key]);
  if (!row || !row.uploaded_at) throw badRequest('File has not been uploaded', { key }, 'FILE_NOT_UPLOADED');
  if (orgId && row.organization_id !== orgId) throw badRequest('File does not belong to this organization', undefined, 'FILE_NOT_UPLOADED');
  if (purpose && row.purpose !== purpose) throw badRequest('File purpose mismatch', undefined, 'FILE_NOT_UPLOADED');
  return row;
}
