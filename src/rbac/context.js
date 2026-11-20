import { db } from '../lib/db.js';
import { forbidden } from '../lib/errors.js';
import { SCOPE_RANK } from './catalog.js';

/** In-memory cache of role permissions keyed by `${roleId}:${version}`. */
const permCache = new Map();

export async function loadRolePermissions(roleId, version) {
  const key = `${roleId}:${version}`;
  if (permCache.has(key)) return permCache.get(key);
  const rows = await db.many(
    `SELECT p.key, rp.scope FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1`,
    [roleId],
  );
  const map = new Map(rows.map((r) => [r.key, r.scope]));
  permCache.set(key, map);
  if (permCache.size > 5000) permCache.delete(permCache.keys().next().value);
  return map;
}

/**
 * Build the request context for a user in an organization.
 * @returns {Promise<object|null>} null when the user is not an active member.
 */
export async function loadMemberContext(userId, orgId) {
  const m = await db.one(
    `SELECT m.id, m.status, m.client_id, m.timezone AS member_timezone, m.restrictions,
            r.id AS role_id, r.slug AS role_slug, r.base_role, r.level AS role_level, r.version AS role_version, r.name AS role_name,
            o.status AS org_status, o.timezone AS org_timezone, o.name AS org_name, o.default_currency,
            s.enforce_2fa
     FROM organization_members m
     JOIN roles r ON r.id = m.role_id
     JOIN organizations o ON o.id = m.organization_id
     LEFT JOIN organization_settings s ON s.organization_id = o.id
     WHERE m.user_id = $1 AND m.organization_id = $2 AND m.deleted_at IS NULL AND o.deleted_at IS NULL`,
    [userId, orgId],
  );
  if (!m) return null;
  const perms = await loadRolePermissions(m.role_id, m.role_version);
  return {
    orgId,
    memberId: m.id,
    memberStatus: m.status,
    orgStatus: m.org_status,
    clientId: m.client_id,
    timezone: m.member_timezone || m.org_timezone || 'UTC',
    orgTimezone: m.org_timezone,
    currency: m.default_currency,
    restrictions: m.restrictions ?? {},
    enforce2fa: m.enforce_2fa,
    role: { id: m.role_id, slug: m.role_slug, baseRole: m.base_role, level: m.role_level, name: m.role_name },
    perms,
  };
}

/** Attach permission helpers to a context object. */
export function withHelpers(ctx) {
  ctx.cache = ctx.cache ?? new Map();
  /** @returns {'own'|'team'|'project'|'org'|null} */
  ctx.can = (perm) => ctx.perms?.get(perm) ?? null;
  ctx.require = (perm, minScope) => {
    const scope = ctx.can(perm);
    if (!scope) throw forbidden(`Missing permission: ${perm}`);
    if (minScope && SCOPE_RANK[scope] < SCOPE_RANK[minScope]) throw forbidden(`Permission ${perm} requires ${minScope} scope`);
    return scope;
  };
  ctx.isOwner = () => ctx.role?.baseRole === 'owner';
  ctx.isAdminLike = () => ['owner', 'admin'].includes(ctx.role?.baseRole);
  ctx.isClient = () => ctx.role?.baseRole === 'client';
  return ctx;
}
