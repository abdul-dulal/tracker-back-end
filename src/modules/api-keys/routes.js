import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent } from '../../lib/http.js';
import { notFound, forbidden, badRequest } from '../../lib/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { ALL_PERMISSIONS } from '../../rbac/catalog.js';

/** API key management (INT-02, INT-04). Keys act with org scope for the listed permission keys. */
const r = createRouter('/api-keys', 'API keys');
const PERM_KEYS = new Set(ALL_PERMISSIONS.map((p) => p.key));

export function apiKeyDto(k) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    expiresAt: k.expires_at,
    lastUsedAt: k.last_used_at,
    revokedAt: k.revoked_at,
    active: !k.revoked_at && (!k.expires_at || new Date(k.expires_at) > new Date()),
    createdBy: k.created_by ? { id: k.created_by, name: k.creator_name ?? null } : null,
    createdAt: k.created_at,
  };
}

const noApiKeyAuth = (req, _res, next) => {
  if (req.ctx.authType === 'api_key') throw forbidden('API keys cannot manage API keys', 'API_KEY_NOT_ALLOWED');
  next();
};

r.get('/', { summary: 'List API keys', ids: 'INT-02', permission: 'api_keys.manage', feature: 'api' }, async (req, res) => {
  const rows = await db.many(
    `SELECT k.*, trim(u.first_name || ' ' || u.last_name) AS creator_name FROM api_keys k
     LEFT JOIN organization_members m ON m.id = k.created_by LEFT JOIN users u ON u.id = m.user_id
     WHERE k.organization_id = $1 ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`,
    [req.ctx.orgId],
  );
  ok(res, rows.map(apiKeyDto));
});

r.post(
  '/',
  {
    summary: 'Create an API key (secret shown once)',
    ids: 'INT-02, INT-04',
    permission: 'api_keys.manage',
    feature: 'api',
    middleware: noApiKeyAuth,
    body: z.object({
      name: z.string().trim().min(1).max(100),
      scopes: z
        .array(z.string().refine((s) => s === '*' || PERM_KEYS.has(s), 'Unknown permission'))
        .min(1)
        .max(ALL_PERMISSIONS.length + 1)
        .transform((a) => [...new Set(a)]),
      expiresInDays: z.coerce.number().int().min(1).max(3650).optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const { name, scopes, expiresInDays } = req.body;
    if (scopes.includes('*') && scopes.length > 1) throw badRequest("'*' cannot be combined with other scopes", undefined, 'INVALID_SCOPES');
    // A key can never grant more than its creator holds (org scope required).
    const wanted = scopes.includes('*') ? [...PERM_KEYS] : scopes;
    const missing = wanted.filter((p) => ctx.can(p) !== 'org');
    if (missing.length) throw forbidden(`You cannot grant permissions you do not hold with organization scope: ${missing.join(', ')}`, 'SCOPE_NOT_ALLOWED');
    const secret = `trk_${randomToken(32)}`;
    const row = await db.one(
      `INSERT INTO api_keys (organization_id, name, prefix, key_hash, scopes, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END, $7) RETURNING *`,
      [ctx.orgId, name, secret.slice(0, 12), sha256(secret), scopes, expiresInDays ?? null, ctx.memberId ?? null],
    );
    await audit(ctx, 'api_key.create', { entityType: 'api_key', entityId: row.id, after: { name, scopes, expiresAt: row.expires_at } });
    created(res, { ...apiKeyDto(row), secret });
  },
);

r.delete('/:id', { summary: 'Revoke an API key', ids: 'INT-02', permission: 'api_keys.manage', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const row = await db.one(
    `UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [req.v.params.id, req.ctx.orgId],
  );
  if (!row) throw notFound('API key');
  await audit(req.ctx, 'api_key.revoke', { entityType: 'api_key', entityId: row.id, before: { name: row.name } });
  noContent(res);
});

export default r;
