import { z } from 'zod';
import { createRouter, zColor, zBool } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent } from '../../lib/http.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';

/** Break types (BRK-01…BRK-04): org-defined, system types renameable but not deletable; archived when in use. */
const r = createRouter('/break-types', 'Breaks');

const dto = (b) => ({
  id: b.id,
  name: b.name,
  isPaid: b.is_paid,
  maxMinutes: b.max_minutes,
  color: b.color,
  isSystem: b.is_system,
  archived: !!b.archived_at,
  archivedAt: b.archived_at,
  usageCount: b.usage_count ?? 0,
  createdAt: b.created_at,
});

const SELECT = `SELECT b.*, (SELECT count(*)::int FROM breaks x WHERE x.break_type_id = b.id) AS usage_count FROM break_types b`;

async function load(orgId, id) {
  const b = await db.one(`${SELECT} WHERE b.id = $1 AND b.organization_id = $2`, [id, orgId]);
  if (!b) throw notFound('Break type');
  return b;
}

r.get(
  '/',
  { summary: 'List break types', ids: 'BRK-01', permission: ['breaks.use', 'breaks.manage'], query: z.object({ includeArchived: zBool.default(false) }) },
  async (req, res) => {
    const all = req.v.query.includeArchived && req.ctx.can('breaks.manage');
    const rows = await db.many(`${SELECT} WHERE b.organization_id = $1 ${all ? '' : 'AND b.archived_at IS NULL'} ORDER BY b.is_system DESC, lower(b.name)`, [req.ctx.orgId]);
    ok(res, rows.map(dto));
  },
);

const body = z.object({
  name: z.string().trim().min(1).max(60),
  isPaid: z.boolean().default(false),
  maxMinutes: z.number().int().min(1).max(720).nullable().optional(),
  color: zColor.nullable().optional(),
});

r.post('/', { summary: 'Create break type', ids: 'BRK-01, BRK-02', permission: 'breaks.manage', body }, async (req, res) => {
  const b = req.body;
  const dup = await db.one('SELECT 1 FROM break_types WHERE organization_id = $1 AND lower(name) = lower($2)', [req.ctx.orgId, b.name]);
  if (dup) throw conflict('DUPLICATE_NAME', `A break type named "${b.name}" already exists`);
  const row = await db.one(
    `INSERT INTO break_types (organization_id, name, is_paid, max_minutes, color) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.ctx.orgId, b.name, b.isPaid, b.maxMinutes ?? null, b.color ?? null],
  );
  await audit(req.ctx, 'break_type.created', { entityType: 'break_type', entityId: row.id, after: b });
  created(res, dto(await load(req.ctx.orgId, row.id)));
});

r.patch(
  '/:id',
  {
    summary: 'Update break type (system types can be renamed)',
    ids: 'BRK-01, BRK-02',
    permission: 'breaks.manage',
    params: z.object({ id: z.uuid() }),
    body: z.object({ name: z.string().trim().min(1).max(60), isPaid: z.boolean(), maxMinutes: z.number().int().min(1).max(720).nullable(), color: zColor.nullable(), archived: z.boolean() }).partial(),
  },
  async (req, res) => {
    const before = await load(req.ctx.orgId, req.v.params.id);
    const b = req.body;
    if (b.name && b.name.toLowerCase() !== before.name.toLowerCase()) {
      const dup = await db.one('SELECT 1 FROM break_types WHERE organization_id = $1 AND lower(name) = lower($2) AND id <> $3', [req.ctx.orgId, b.name, before.id]);
      if (dup) throw conflict('DUPLICATE_NAME', `A break type named "${b.name}" already exists`);
    }
    if (b.archived === true && before.is_system) throw conflict('SYSTEM_BREAK_TYPE', 'System break types cannot be archived');
    await db.query(
      `UPDATE break_types SET name = coalesce($2, name), is_paid = coalesce($3, is_paid),
         max_minutes = CASE WHEN $4::boolean THEN $5::int ELSE max_minutes END,
         color = CASE WHEN $6::boolean THEN $7 ELSE color END,
         archived_at = CASE WHEN $8::boolean IS NULL THEN archived_at WHEN $8 THEN coalesce(archived_at, now()) ELSE NULL END
       WHERE id = $1`,
      [before.id, b.name ?? null, b.isPaid ?? null, b.maxMinutes !== undefined, b.maxMinutes ?? null, b.color !== undefined, b.color ?? null, b.archived ?? null],
    );
    await audit(req.ctx, 'break_type.updated', { entityType: 'break_type', entityId: before.id, before: dto(before), after: b });
    ok(res, dto(await load(req.ctx.orgId, before.id)));
  },
);

r.delete('/:id', { summary: 'Delete break type (archived instead when in use; system types protected)', ids: 'BRK-01', permission: 'breaks.manage', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const b = await load(req.ctx.orgId, req.v.params.id);
  if (b.is_system) throw conflict('SYSTEM_BREAK_TYPE', 'System break types cannot be deleted (you can rename them)');
  if (b.usage_count > 0) {
    await db.query('UPDATE break_types SET archived_at = coalesce(archived_at, now()) WHERE id = $1', [b.id]);
    await audit(req.ctx, 'break_type.archived', { entityType: 'break_type', entityId: b.id, before: dto(b) });
    return ok(res, { ...dto(await load(req.ctx.orgId, b.id)), deleted: false });
  }
  await db.query('DELETE FROM break_types WHERE id = $1', [b.id]);
  await audit(req.ctx, 'break_type.deleted', { entityType: 'break_type', entityId: b.id, before: dto(b) });
  noContent(res);
});

export default r;
