import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent } from '../../lib/http.js';
import { notFound, conflict } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';

/**
 * Sensitive website exclusions (PRIV-05): matching domains are stored only as "(excluded)", without
 * URL or title. Patterns: "bank.com" (domain + sub-domains) or globs like "*.health.*".
 */
const r = createRouter('/sensitive-exclusions', 'Privacy');

const dto = (x) => ({ id: x.id, domainPattern: x.domain_pattern, reason: x.reason, createdAt: x.created_at });

r.get('/', { summary: 'List sensitive website exclusions', ids: 'PRIV-05', permission: 'settings.privacy' }, async (req, res) => {
  const rows = await db.many('SELECT * FROM sensitive_exclusions WHERE organization_id = $1 ORDER BY domain_pattern', [req.ctx.orgId]);
  ok(res, rows.map(dto));
});

r.post(
  '/',
  {
    summary: 'Add a sensitive website exclusion',
    ids: 'PRIV-05',
    permission: 'settings.privacy',
    body: z.strictObject({
      domainPattern: z
        .string()
        .trim()
        .toLowerCase()
        .min(1)
        .max(255)
        .regex(/^[a-z0-9*.-]+$/, 'Expected a domain or wildcard pattern')
        .transform((v) => v.replace(/^www\./, '')),
      reason: z.string().trim().max(500).optional(),
    }),
  },
  async (req, res) => {
    const exists = await db.one('SELECT 1 FROM sensitive_exclusions WHERE organization_id = $1 AND domain_pattern = $2', [req.ctx.orgId, req.body.domainPattern]);
    if (exists) throw conflict('EXCLUSION_EXISTS', 'This domain is already excluded');
    const row = await db.one(
      'INSERT INTO sensitive_exclusions (organization_id, domain_pattern, reason) VALUES ($1,$2,$3) RETURNING *',
      [req.ctx.orgId, req.body.domainPattern, req.body.reason ?? null],
    );
    await audit(req.ctx, 'sensitive_exclusion.create', { entityType: 'sensitive_exclusion', entityId: row.id, after: dto(row) });
    created(res, dto(row));
  },
);

r.delete('/:id', { summary: 'Remove a sensitive website exclusion', ids: 'PRIV-05', permission: 'settings.privacy', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const row = await db.one('DELETE FROM sensitive_exclusions WHERE id = $1 AND organization_id = $2 RETURNING *', [req.v.params.id, req.ctx.orgId]);
  if (!row) throw notFound('Exclusion');
  await audit(req.ctx, 'sensitive_exclusion.delete', { entityType: 'sensitive_exclusion', entityId: row.id, before: dto(row) });
  noContent(res);
});

export default r;
