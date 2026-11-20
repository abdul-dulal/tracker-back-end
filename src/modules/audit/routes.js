import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, dateStr, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { forbidden } from '../../lib/errors.js';

/** Audit history (SEC-10, PRIV-09). */
const r = createRouter('/audit-logs', 'Audit');

export function auditDto(a) {
  return {
    id: a.id,
    organizationId: a.organization_id,
    actor: { type: a.actor_type, userId: a.actor_user_id, name: a.actor_name ?? null, email: a.actor_email ?? null },
    action: a.action,
    entityType: a.entity_type,
    entityId: a.entity_id,
    before: a.before,
    after: a.after,
    ip: a.ip,
    userAgent: a.user_agent,
    createdAt: a.created_at,
  };
}

export const auditQuery = paginationQuery.extend({
  actor: z.uuid().optional(),
  actorType: z.enum(['user', 'api_key', 'system', 'super_admin', 'agent']).optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.uuid().optional(),
  action: z.string().max(80).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});

/** Shared list query (org-scoped when orgId given; platform-wide otherwise). */
export async function listAudit(q, { orgId, tz = 'UTC' } = {}) {
  const w = where();
  if (orgId) w.add('a.organization_id = ?', orgId);
  else w.add('a.organization_id = ?', q.organizationId);
  w.add('a.actor_user_id = ?', q.actor);
  w.add('a.actor_type = ?', q.actorType);
  w.add('a.entity_type = ?', q.entityType);
  w.add('a.entity_id = ?', q.entityId);
  if (q.action) w.add(`a.action LIKE ? || '%'`, q.action.replace(/[%_]/g, '\\$&'));
  if (q.from) w.add('a.created_at >= (?::date::timestamp AT TIME ZONE ?)', q.from, tz);
  if (q.to) w.add('a.created_at < ((?::date + 1)::timestamp AT TIME ZONE ?)', q.to, tz);
  const total = (await db.one(`SELECT count(*)::int AS n FROM audit_logs a ${w.sql}`, w.params)).n;
  const rows = await db.many(
    `SELECT a.*, trim(u.first_name || ' ' || u.last_name) AS actor_name, u.email AS actor_email
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ${w.sql}
     ORDER BY a.created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    w.params,
  );
  return { rows: rows.map(auditDto), total };
}

r.get('/', { summary: 'Organization audit history', ids: 'SEC-10, PRIV-09', permission: 'audit.view', query: auditQuery }, async (req, res) => {
  if (req.ctx.can('audit.view') !== 'org') throw forbidden('Organization-wide audit permission required');
  const q = req.v.query;
  const { rows, total } = await listAudit(q, { orgId: req.ctx.orgId, tz: req.ctx.timezone });
  ok(res, rows, pageMeta(q, total));
});

export default r;
