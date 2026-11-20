import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent } from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { PERMISSIONS, ALL_PERMISSIONS } from '../../rbac/catalog.js';
import { hasFeature } from '../subscription/features.js';

const r = createRouter('/roles', 'Roles & Permissions');
const perms = createRouter('/permissions', 'Roles & Permissions');

perms.get('/', { summary: 'Permission catalog grouped by module', ids: 'RBAC-03, RBAC-04', permission: 'roles.manage' }, async (_req, res) => {
  ok(res, Object.entries(PERMISSIONS).map(([module, keys]) => ({ module, permissions: keys.map((key) => ({ key, scopes: scopesFor(key) })) })));
});

/** Which scopes make sense for a permission (UI matrix). */
function scopesFor(key) {
  const orgOnly = ['organization.', 'roles.', 'departments.', 'settings.', 'privacy.', 'audit.', 'integrations.', 'api_keys.', 'webhooks.', 'subscription.', 'notifications.', 'billing.', 'invoices.', 'payroll.', 'clients.', 'schedules.', 'holidays.', 'breaks.manage', 'members.import', 'members.create', 'projects.create', 'apps.categorize', 'timesheets.lock', 'attendance.manage'];
  if (orgOnly.some((p) => key.startsWith(p))) return ['org'];
  if (key.startsWith('projects.') || key.startsWith('tasks.') || key === 'board.manage_columns') return ['own', 'project', 'team', 'org'];
  return ['own', 'team', 'project', 'org'];
}

async function roleDto(role) {
  const grants = await db.many(
    `SELECT p.key, rp.scope FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 ORDER BY p.key`,
    [role.id],
  );
  const count = await db.one('SELECT count(*)::int AS n FROM organization_members WHERE role_id = $1 AND deleted_at IS NULL', [role.id]);
  return {
    id: role.id,
    name: role.name,
    slug: role.slug,
    description: role.description,
    isSystem: role.is_system,
    baseRole: role.base_role,
    level: role.level,
    memberCount: count.n,
    permissions: Object.fromEntries(grants.map((g) => [g.key, g.scope])),
    createdAt: role.created_at,
  };
}

r.get('/', { summary: 'List roles', ids: 'RBAC-01, RBAC-09', permission: ['roles.manage', 'members.view', 'members.invite'] }, async (req, res) => {
  const roles = await db.many('SELECT * FROM roles WHERE organization_id = $1 ORDER BY level DESC, name', [req.ctx.orgId]);
  ok(res, await Promise.all(roles.map(roleDto)));
});

r.get('/:id', { summary: 'Role detail with permission grants', ids: 'RBAC-03', permission: 'roles.manage', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const role = await db.one('SELECT * FROM roles WHERE id = $1 AND organization_id = $2', [req.v.params.id, req.ctx.orgId]);
  if (!role) throw notFound('Role');
  ok(res, await roleDto(role));
});

r.post(
  '/',
  {
    summary: 'Create a custom role (optionally cloned)',
    ids: 'RBAC-02',
    permission: 'roles.manage',
    body: z.object({
      name: z.string().trim().min(2).max(80),
      description: z.string().max(500).optional(),
      cloneFromRoleId: z.uuid().optional(),
      baseRole: z.enum(['admin', 'manager', 'team_leader', 'employee']).optional(),
    }),
  },
  async (req, res) => {
    if (!(await hasFeature(req.ctx, 'customRoles'))) throw forbidden('Custom roles are not included in your plan', 'FEATURE_NOT_IN_PLAN');
    const b = req.body;
    const slug = `custom-${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 80);
    const src = b.cloneFromRoleId ? await db.one('SELECT * FROM roles WHERE id = $1 AND organization_id = $2', [b.cloneFromRoleId, req.ctx.orgId]) : null;
    if (b.cloneFromRoleId && !src) throw badRequest('Role to clone not found', undefined, 'INVALID_REFERENCE');
    const baseRole = src?.base_role === 'owner' ? 'admin' : (src?.base_role ?? b.baseRole ?? 'employee');
    if (baseRole === 'client') throw badRequest('Cannot clone the client role');
    const level = { admin: 85, manager: 55, team_leader: 35, employee: 15 }[baseRole];
    if (level > req.ctx.role.level) throw forbidden('Cannot create a role above your own level');
    if (await db.one('SELECT 1 FROM roles WHERE organization_id = $1 AND slug = $2', [req.ctx.orgId, slug])) throw conflict('ROLE_EXISTS', 'A role with this name already exists');
    const role = await db.tx(async () => {
      const role0 = await db.one(
        `INSERT INTO roles (organization_id, name, slug, description, is_system, base_role, level) VALUES ($1,$2,$3,$4,false,$5,$6) RETURNING *`,
        [req.ctx.orgId, b.name, slug, b.description ?? null, baseRole, level],
      );
      if (src) await db.query('INSERT INTO role_permissions (role_id, permission_id, scope) SELECT $1, permission_id, scope FROM role_permissions WHERE role_id = $2', [role0.id, src.id]);
      return role0;
    });
    await audit(req.ctx, 'role.created', { entityType: 'role', entityId: role.id, after: { name: b.name, clonedFrom: src?.slug } });
    created(res, await roleDto(role));
  },
);

r.patch(
  '/:id',
  { summary: 'Rename / describe a custom role', ids: 'RBAC-02', permission: 'roles.manage', params: z.object({ id: z.uuid() }), body: z.object({ name: z.string().trim().min(2).max(80).optional(), description: z.string().max(500).nullable().optional() }) },
  async (req, res) => {
    const role = await db.one('SELECT * FROM roles WHERE id = $1 AND organization_id = $2', [req.v.params.id, req.ctx.orgId]);
    if (!role) throw notFound('Role');
    if (role.is_system) throw forbidden('System roles cannot be renamed; clone them instead', 'SYSTEM_ROLE');
    const u = await db.one('UPDATE roles SET name = coalesce($2, name), description = coalesce($3, description), updated_at = now() WHERE id = $1 RETURNING *', [role.id, req.body.name ?? null, req.body.description ?? null]);
    ok(res, await roleDto(u));
  },
);

r.put(
  '/:id/permissions',
  {
    summary: 'Replace permission grants of a custom role',
    ids: 'RBAC-03…08',
    permission: 'roles.manage',
    params: z.object({ id: z.uuid() }),
    body: z.object({ grants: z.array(z.object({ permission: z.string(), scope: z.enum(['own', 'team', 'project', 'org']) })).max(200) }),
  },
  async (req, res) => {
    const role = await db.one('SELECT * FROM roles WHERE id = $1 AND organization_id = $2', [req.v.params.id, req.ctx.orgId]);
    if (!role) throw notFound('Role');
    if (role.is_system) throw forbidden('System role permissions are fixed; clone the role to customize', 'SYSTEM_ROLE');
    const known = new Set(ALL_PERMISSIONS.map((p) => p.key));
    const unknown = req.body.grants.filter((g) => !known.has(g.permission));
    if (unknown.length) throw badRequest('Unknown permissions', unknown.map((g) => ({ path: 'grants', message: g.permission })));
    for (const g of req.body.grants) if (!scopesFor(g.permission).includes(g.scope)) throw badRequest(`Scope ${g.scope} is not valid for ${g.permission}`);
    // Cannot grant what you do not have yourself (no privilege escalation).
    for (const g of req.body.grants) if (!req.ctx.can(g.permission)) throw forbidden(`You cannot grant ${g.permission}`);
    const before = await roleDto(role);
    await db.tx(async () => {
      await db.query('DELETE FROM role_permissions WHERE role_id = $1', [role.id]);
      for (const g of req.body.grants)
        await db.query('INSERT INTO role_permissions (role_id, permission_id, scope) SELECT $1, id, $3 FROM permissions WHERE key = $2', [role.id, g.permission, g.scope]);
      await db.query('UPDATE roles SET version = version + 1, updated_at = now() WHERE id = $1', [role.id]);
    });
    const after = await roleDto(role);
    await audit(req.ctx, 'role.permissions_updated', { entityType: 'role', entityId: role.id, before: before.permissions, after: after.permissions });
    ok(res, after);
  },
);

r.delete('/:id', { summary: 'Delete a custom role (must have no members)', ids: 'RBAC-02', permission: 'roles.manage', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const role = await db.one('SELECT * FROM roles WHERE id = $1 AND organization_id = $2', [req.v.params.id, req.ctx.orgId]);
  if (!role) throw notFound('Role');
  if (role.is_system) throw forbidden('System roles cannot be deleted', 'SYSTEM_ROLE');
  const used = await db.one('SELECT count(*)::int AS n FROM organization_members WHERE role_id = $1 AND deleted_at IS NULL', [role.id]);
  if (used.n) throw conflict('ROLE_IN_USE', `Reassign the ${used.n} member(s) using this role first`);
  await db.query('DELETE FROM invitations WHERE role_id = $1 AND status <> $2', [role.id, 'pending']);
  if (await db.one(`SELECT 1 FROM invitations WHERE role_id = $1 AND status = 'pending'`, [role.id])) throw conflict('ROLE_IN_USE', 'Pending invitations use this role');
  await db.query('DELETE FROM invitation_links WHERE role_id = $1', [role.id]);
  await db.query('DELETE FROM roles WHERE id = $1', [role.id]);
  await audit(req.ctx, 'role.deleted', { entityType: 'role', entityId: role.id, before: { name: role.name } });
  noContent(res);
});

export default [r, perms];
