import { z } from 'zod';
import { createRouter, zBool } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, uuidParam } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';

const r = createRouter('/system-alerts', 'Dashboard');

const dto = (a) => ({
  id: a.id, type: a.type, severity: a.severity, message: a.message, data: a.data, resolvedAt: a.resolved_at, createdAt: a.created_at,
});

r.get(
  '/',
  {
    summary: 'System alerts (ADM-18)',
    ids: 'ADM-18',
    permission: 'organization.update',
    query: z.object({ includeResolved: zBool.default(false), limit: z.coerce.number().int().min(1).max(100).default(50) }),
  },
  async (req, res) => {
    const q = req.v.query;
    const rows = await db.many(
      `SELECT * FROM system_alerts WHERE organization_id = $1 AND ($2 OR resolved_at IS NULL) ORDER BY created_at DESC LIMIT $3`,
      [req.ctx.orgId, q.includeResolved, q.limit],
    );
    ok(res, rows.map(dto));
  },
);

r.post(
  '/:id/resolve',
  { summary: 'Resolve a system alert', ids: 'ADM-18', permission: 'organization.update', params: uuidParam },
  async (req, res) => {
    const a = await db.one('SELECT * FROM system_alerts WHERE id = $1 AND organization_id = $2', [req.v.params.id, req.ctx.orgId]);
    if (!a) throw notFound('System alert');
    const row = a.resolved_at ? a : await db.one('UPDATE system_alerts SET resolved_at = now() WHERE id = $1 RETURNING *', [a.id]);
    await audit(req.ctx, 'system_alert.resolve', { entityType: 'system_alert', entityId: a.id });
    ok(res, dto(row));
  },
);

export default r;
