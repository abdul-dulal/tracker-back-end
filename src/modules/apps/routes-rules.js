import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';

/** Productivity categorization rules (APP-13…16, APP-19). Most specific scope wins (member > team > org). */
const r = createRouter('/productivity-rules', 'Apps & websites');

const ruleBody = z.strictObject({
  scopeType: z.enum(['org', 'team', 'member']).default('org'),
  scopeId: z.uuid().nullable().optional(),
  targetType: z.enum(['app', 'website']),
  pattern: z.string().trim().min(1).max(255),
  matchType: z.enum(['exact', 'domain', 'wildcard']).default('exact'),
  category: z.enum(['productive', 'unproductive', 'neutral']),
});

export function ruleDto(x) {
  return {
    id: x.id,
    scopeType: x.scope_type,
    scopeId: x.scope_id,
    scopeName: x.scope_name ?? null,
    targetType: x.target_type,
    pattern: x.pattern,
    matchType: x.match_type,
    category: x.category,
    createdAt: x.created_at,
  };
}

async function validateScope(orgId, scopeType, scopeId) {
  if (scopeType === 'org') {
    if (scopeId) throw badRequest('scopeId must be empty for org rules');
    return null;
  }
  if (!scopeId) throw badRequest('scopeId is required for team/member rules');
  const ok_ =
    scopeType === 'team'
      ? await db.one('SELECT 1 FROM teams WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [scopeId, orgId])
      : await db.one('SELECT 1 FROM organization_members WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [scopeId, orgId]);
  if (!ok_) throw badRequest(`${scopeType} not found`, undefined, 'INVALID_REFERENCE');
  return scopeId;
}

const SELECT = `
  SELECT r.*, CASE r.scope_type WHEN 'team' THEN (SELECT name FROM teams WHERE id = r.scope_id)
                                WHEN 'member' THEN (SELECT u.first_name || ' ' || u.last_name FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.id = r.scope_id)
                   END AS scope_name
  FROM productivity_rules r`;

r.get(
  '/',
  {
    summary: 'List productivity rules',
    ids: 'APP-13, APP-14, APP-15, APP-16, APP-19',
    permission: 'apps.categorize',
    query: paginationQuery.extend({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      targetType: z.enum(['app', 'website']).optional(),
      scopeType: z.enum(['org', 'team', 'member']).optional(),
      scopeId: z.uuid().optional(),
      category: z.enum(['productive', 'unproductive', 'neutral']).optional(),
    }),
  },
  async (req, res) => {
    const q = req.v.query;
    const w = where([req.ctx.orgId]);
    w.raw('r.organization_id = $1');
    w.add('r.target_type = ?', q.targetType);
    w.add('r.scope_type = ?', q.scopeType);
    w.add('r.scope_id = ?', q.scopeId);
    w.add('r.category = ?', q.category);
    if (q.search) w.add('r.pattern ILIKE ?', `%${q.search}%`);
    const total = (await db.one(`SELECT count(*)::int AS n FROM productivity_rules r ${w.sql}`, w.params)).n;
    const rows = await db.many(`${SELECT} ${w.sql} ORDER BY r.target_type, lower(r.pattern) LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, w.params);
    ok(res, rows.map(ruleDto), pageMeta(q, total));
  },
);

r.post('/', { summary: 'Create a productivity rule', ids: 'APP-16, APP-19', permission: 'apps.categorize', body: ruleBody }, async (req, res) => {
  const b = req.body;
  const scopeId = await validateScope(req.ctx.orgId, b.scopeType, b.scopeId);
  const row = await db.one(
    `INSERT INTO productivity_rules (organization_id, scope_type, scope_id, target_type, pattern, match_type, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [req.ctx.orgId, b.scopeType, scopeId, b.targetType, b.pattern.toLowerCase(), b.matchType, b.category],
  );
  await audit(req.ctx, 'productivity_rule.create', { entityType: 'productivity_rule', entityId: row.id, after: b });
  created(res, ruleDto(await db.one(`${SELECT} WHERE r.id = $1`, [row.id])));
});

r.patch(
  '/:id',
  {
    summary: 'Update a productivity rule',
    ids: 'APP-16',
    permission: 'apps.categorize',
    params: z.object({ id: z.uuid() }),
    body: z.strictObject({
      pattern: z.string().trim().min(1).max(255).optional(),
      matchType: z.enum(['exact', 'domain', 'wildcard']).optional(),
      category: z.enum(['productive', 'unproductive', 'neutral']).optional(),
    }),
  },
  async (req, res) => {
    const cur = await db.one('SELECT * FROM productivity_rules WHERE id = $1 AND organization_id = $2', [req.v.params.id, req.ctx.orgId]);
    if (!cur) throw notFound('Rule');
    const b = req.body;
    await db.query(
      `UPDATE productivity_rules SET pattern = coalesce($2, pattern), match_type = coalesce($3, match_type), category = coalesce($4, category) WHERE id = $1`,
      [cur.id, b.pattern?.toLowerCase() ?? null, b.matchType ?? null, b.category ?? null],
    );
    await audit(req.ctx, 'productivity_rule.update', { entityType: 'productivity_rule', entityId: cur.id, before: ruleDto(cur), after: b });
    ok(res, ruleDto(await db.one(`${SELECT} WHERE r.id = $1`, [cur.id])));
  },
);

r.delete('/:id', { summary: 'Delete a productivity rule', ids: 'APP-16', permission: 'apps.categorize', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const row = await db.one('DELETE FROM productivity_rules WHERE id = $1 AND organization_id = $2 RETURNING *', [req.v.params.id, req.ctx.orgId]);
  if (!row) throw notFound('Rule');
  await audit(req.ctx, 'productivity_rule.delete', { entityType: 'productivity_rule', entityId: row.id, before: ruleDto(row) });
  noContent(res);
});

export default r;
