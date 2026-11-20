import { z } from 'zod';
import { createRouter, zCurrency, zMoney } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit, diff } from '../../lib/audit.js';
import { publish } from '../../lib/events.js';
import { createInvitation } from '../invitations/routes.js';

const r = createRouter('/clients', 'Clients');

const DEFAULT_PORTAL = { showScreenshots: false, showActivity: false, showMemberNames: true, showRates: false };

const clientDto = (c) => ({
  id: c.id,
  name: c.name,
  email: c.email,
  phone: c.phone,
  company: c.company,
  address: c.address,
  currency: c.currency ? c.currency.trim() : null,
  hourlyRate: c.hourly_rate === null || c.hourly_rate === undefined ? null : Number(c.hourly_rate),
  portalPermissions: { ...DEFAULT_PORTAL, ...(c.portal_permissions ?? {}) },
  status: c.status,
  notes: c.notes,
  projectCount: c.project_count ?? 0,
  contactCount: c.contact_count ?? 0,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

const SELECT = `
  SELECT c.*,
    (SELECT count(*)::int FROM projects p WHERE p.client_id = c.id AND p.deleted_at IS NULL) AS project_count,
    (SELECT count(*)::int FROM organization_members m WHERE m.client_id = c.id AND m.deleted_at IS NULL) AS contact_count
  FROM clients c`;

async function loadClient(orgId, id) {
  const c = await db.one(`${SELECT} WHERE c.id = $1 AND c.organization_id = $2 AND c.deleted_at IS NULL`, [id, orgId]);
  if (!c) throw notFound('Client');
  return c;
}

const SORT = { name: 'lower(c.name)', createdAt: 'c.created_at', projectCount: 'project_count' };

r.get(
  '/',
  { summary: 'List clients', ids: 'CLI-01', permission: 'clients.view', query: paginationQuery.extend({ status: z.enum(['active', 'inactive']).optional() }) },
  async (req, res) => {
    const q = req.v.query;
    const w = where([req.ctx.orgId]).raw('c.organization_id = $1 AND c.deleted_at IS NULL');
    w.add('c.status = ?', q.status);
    if (q.search) w.add('(c.name ILIKE ? OR c.company ILIKE ? OR c.email ILIKE ?)', `%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
    const total = (await db.one(`SELECT count(*)::int AS n FROM clients c ${w.sql}`, w.params)).n;
    const sort = SORT[q.sort] ?? SORT.name;
    const dir = q.sort ? (q.order === 'asc' ? 'ASC' : 'DESC') : 'ASC';
    const rows = await db.many(`${SELECT} ${w.sql} ORDER BY ${sort} ${dir} LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, w.params);
    ok(res, rows.map(clientDto), pageMeta(q, total));
  },
);

const portalSchema = z
  .object({ showScreenshots: z.boolean(), showActivity: z.boolean(), showMemberNames: z.boolean(), showRates: z.boolean() })
  .partial()
  .strict();

const body = z.object({
  name: z.string().trim().min(1).max(150),
  email: z.email().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  company: z.string().trim().max(150).nullable().optional(),
  address: z.record(z.string(), z.any()).nullable().optional(),
  currency: zCurrency.nullable().optional(),
  hourlyRate: zMoney.nullable().optional(),
  portalPermissions: portalSchema.optional(),
  status: z.enum(['active', 'inactive']).optional(),
  notes: z.string().max(5000).nullable().optional(),
});

r.post('/', { summary: 'Create client', ids: 'CLI-01, CLI-18', permission: 'clients.manage', body }, async (req, res) => {
  const b = req.body;
  const c = await db.one(
    `INSERT INTO clients (organization_id, name, email, phone, company, address, currency, hourly_rate, portal_permissions, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [req.ctx.orgId, b.name, b.email ?? null, b.phone ?? null, b.company ?? null, db.json(b.address), b.currency ?? null, b.hourlyRate ?? null, db.json({ ...DEFAULT_PORTAL, ...(b.portalPermissions ?? {}) }), b.status ?? 'active', b.notes ?? null],
  );
  await audit(req.ctx, 'client.created', { entityType: 'client', entityId: c.id, after: { name: b.name } });
  await publish('client.created', { orgId: req.ctx.orgId, clientId: c.id });
  created(res, clientDto(await loadClient(req.ctx.orgId, c.id)));
});

r.get('/:id', { summary: 'Client detail (projects, contacts)', ids: 'CLI-01', permission: 'clients.view', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const c = await loadClient(req.ctx.orgId, req.v.params.id);
  const projects = await db.many(
    `SELECT id, name, status, client_visible, archived_at FROM projects WHERE client_id = $1 AND organization_id = $2 AND deleted_at IS NULL ORDER BY lower(name)`,
    [c.id, req.ctx.orgId],
  );
  const contacts = await db.many(
    `SELECT m.id, m.status, u.email, trim(u.first_name || ' ' || u.last_name) AS name, m.last_seen_at, m.created_at
     FROM organization_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
     WHERE m.client_id = $1 AND m.organization_id = $2 AND m.deleted_at IS NULL AND r.base_role = 'client' ORDER BY u.email`,
    [c.id, req.ctx.orgId],
  );
  const invitations = await db.many(
    `SELECT id, email, status, expires_at, created_at FROM invitations WHERE client_id = $1 AND organization_id = $2 AND status = 'pending' AND expires_at > now() ORDER BY created_at DESC`,
    [c.id, req.ctx.orgId],
  );
  ok(res, {
    ...clientDto(c),
    projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status, clientVisible: p.client_visible, archived: !!p.archived_at })),
    contacts: contacts.map((m) => ({ memberId: m.id, name: m.name, email: m.email, status: m.status, lastSeenAt: m.last_seen_at, createdAt: m.created_at })),
    pendingInvitations: invitations.map((i) => ({ id: i.id, email: i.email, expiresAt: i.expires_at, createdAt: i.created_at })),
  });
});

const COLS = { name: 'name', email: 'email', phone: 'phone', company: 'company', address: 'address', currency: 'currency', hourlyRate: 'hourly_rate', status: 'status', notes: 'notes' };

r.patch('/:id', { summary: 'Update client (rates, portal permissions…)', ids: 'CLI-01, CLI-18', permission: 'clients.manage', params: z.object({ id: z.uuid() }), body: body.partial() }, async (req, res) => {
  const before = await loadClient(req.ctx.orgId, req.v.params.id);
  const b = req.body;
  const sets = [];
  const params = [before.id];
  for (const [k, col] of Object.entries(COLS)) {
    if (b[k] === undefined) continue;
    params.push(k === 'address' ? db.json(b[k]) : b[k]);
    sets.push(`${col} = $${params.length}`);
  }
  if (b.portalPermissions) {
    params.push(db.json({ ...DEFAULT_PORTAL, ...(before.portal_permissions ?? {}), ...b.portalPermissions }));
    sets.push(`portal_permissions = $${params.length}`);
  }
  if (sets.length) await db.query(`UPDATE clients SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  const after = await loadClient(req.ctx.orgId, before.id);
  const d = diff(clientDto(before), clientDto(after));
  if (d.changed) await audit(req.ctx, 'client.updated', { entityType: 'client', entityId: before.id, before: d.before, after: d.after });
  ok(res, clientDto(after));
});

r.delete('/:id', { summary: 'Delete client (soft); revokes pending client invitations', ids: 'CLI-01', permission: 'clients.manage', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const c = await loadClient(req.ctx.orgId, req.v.params.id);
  await db.tx(async () => {
    await db.query(`UPDATE clients SET deleted_at = now(), status = 'inactive', updated_at = now() WHERE id = $1`, [c.id]);
    await db.query(`UPDATE invitations SET status = 'revoked' WHERE client_id = $1 AND status = 'pending'`, [c.id]);
  });
  await audit(req.ctx, 'client.deleted', { entityType: 'client', entityId: c.id, before: { name: c.name } });
  noContent(res);
});

r.post(
  '/:id/invite',
  { summary: 'Invite a client user to the portal', ids: 'CLI-01, CLI-02', permission: 'clients.manage', params: z.object({ id: z.uuid() }), body: z.object({ email: z.email().max(254) }) },
  async (req, res) => {
    const c = await loadClient(req.ctx.orgId, req.v.params.id);
    if (c.status !== 'active') throw badRequest('Client is inactive', undefined, 'CLIENT_INACTIVE');
    const role = await db.one(`SELECT id FROM roles WHERE organization_id = $1 AND slug = 'client'`, [req.ctx.orgId]);
    if (!role) throw badRequest('The organization has no client role', undefined, 'INVALID_ROLE');
    const { invitation } = await createInvitation(req.ctx, { email: req.body.email, roleId: role.id, clientId: c.id });
    created(res, { id: invitation.id, email: invitation.email, status: invitation.status, clientId: c.id, expiresAt: invitation.expires_at });
  },
);

export default r;
