import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { assertOrgMembers, assertOrgRows } from '../teams/service.js';

const r = createRouter('/departments', 'Departments');

const deptDto = (d) => ({
  id: d.id,
  name: d.name,
  description: d.description,
  parentId: d.parent_id,
  parentName: d.parent_name ?? null,
  head: d.head_member_id ? { id: d.head_member_id, name: d.head_name ?? null } : null,
  memberCount: d.member_count ?? 0,
  teamCount: d.team_count ?? 0,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
});

const SELECT = `
  SELECT d.*, p.name AS parent_name, trim(hu.first_name || ' ' || hu.last_name) AS head_name,
    (SELECT count(*)::int FROM organization_members m WHERE m.department_id = d.id AND m.deleted_at IS NULL AND m.status <> 'inactive') AS member_count,
    (SELECT count(*)::int FROM teams t WHERE t.department_id = d.id AND t.deleted_at IS NULL) AS team_count
  FROM departments d
  LEFT JOIN departments p ON p.id = d.parent_id AND p.deleted_at IS NULL
  LEFT JOIN organization_members hm ON hm.id = d.head_member_id
  LEFT JOIN users hu ON hu.id = hm.user_id`;

async function loadDept(orgId, id) {
  const d = await db.one(`${SELECT} WHERE d.id = $1 AND d.organization_id = $2 AND d.deleted_at IS NULL`, [id, orgId]);
  if (!d) throw notFound('Department');
  return d;
}

/** Reject a parent that would create a cycle (parent is the department itself or one of its descendants). */
async function assertNoCycle(orgId, id, parentId) {
  if (!parentId) return;
  if (parentId === id) throw badRequest('A department cannot be its own parent', [{ path: 'body.parentId', message: 'Cycle' }], 'INVALID_PARENT');
  const hit = await db.one(
    `WITH RECURSIVE sub AS (
       SELECT id FROM departments WHERE id = $1 AND organization_id = $3
       UNION SELECT d.id FROM departments d JOIN sub ON d.parent_id = sub.id WHERE d.deleted_at IS NULL)
     SELECT 1 FROM sub WHERE id = $2`,
    [id, parentId, orgId],
  );
  if (hit) throw badRequest('Parent cannot be a sub-department of this department', [{ path: 'body.parentId', message: 'Cycle' }], 'INVALID_PARENT');
}

r.get(
  '/',
  { summary: 'List departments', ids: 'TEAM-01', permission: ['teams.view', 'departments.manage'], query: z.object({ search: z.string().trim().max(120).optional() }) },
  async (req, res) => {
    const params = [req.ctx.orgId];
    let cond = '';
    if (req.v.query.search) {
      params.push(`%${req.v.query.search}%`);
      cond = 'AND d.name ILIKE $2';
    }
    const rows = await db.many(`${SELECT} WHERE d.organization_id = $1 AND d.deleted_at IS NULL ${cond} ORDER BY lower(d.name)`, params);
    ok(res, rows.map(deptDto));
  },
);

r.get('/:id', { summary: 'Department detail', ids: 'TEAM-01', permission: ['teams.view', 'departments.manage'], params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const d = await loadDept(req.ctx.orgId, req.v.params.id);
  const teams = await db.many(`SELECT id, name FROM teams WHERE department_id = $1 AND deleted_at IS NULL ORDER BY lower(name)`, [d.id]);
  const children = await db.many(`SELECT id, name FROM departments WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY lower(name)`, [d.id]);
  ok(res, { ...deptDto(d), teams, children });
});

const body = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  headMemberId: z.uuid().nullable().optional(),
  parentId: z.uuid().nullable().optional(),
});

r.post('/', { summary: 'Create department (name, head, parent)', ids: 'TEAM-01', permission: 'departments.manage', body }, async (req, res) => {
  const b = req.body;
  if (b.headMemberId) await assertOrgMembers(req.ctx.orgId, [b.headMemberId], 'headMemberId');
  if (b.parentId) await assertOrgRows('departments', req.ctx.orgId, [b.parentId], 'parentId');
  const d = await db.one(
    `INSERT INTO departments (organization_id, name, description, head_member_id, parent_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.ctx.orgId, b.name, b.description ?? null, b.headMemberId ?? null, b.parentId ?? null],
  );
  await audit(req.ctx, 'department.created', { entityType: 'department', entityId: d.id, after: b });
  created(res, deptDto(await loadDept(req.ctx.orgId, d.id)));
});

r.patch('/:id', { summary: 'Update department', ids: 'TEAM-01', permission: 'departments.manage', params: z.object({ id: z.uuid() }), body: body.partial() }, async (req, res) => {
  const before = await loadDept(req.ctx.orgId, req.v.params.id);
  const b = req.body;
  if (b.headMemberId) await assertOrgMembers(req.ctx.orgId, [b.headMemberId], 'headMemberId');
  if (b.parentId) {
    await assertOrgRows('departments', req.ctx.orgId, [b.parentId], 'parentId');
    await assertNoCycle(req.ctx.orgId, before.id, b.parentId);
  }
  await db.query(
    `UPDATE departments SET
       name = coalesce($2, name),
       description = CASE WHEN $3::boolean THEN $4 ELSE description END,
       head_member_id = CASE WHEN $5::boolean THEN $6::uuid ELSE head_member_id END,
       parent_id = CASE WHEN $7::boolean THEN $8::uuid ELSE parent_id END,
       updated_at = now()
     WHERE id = $1`,
    [before.id, b.name ?? null, b.description !== undefined, b.description ?? null, b.headMemberId !== undefined, b.headMemberId ?? null, b.parentId !== undefined, b.parentId ?? null],
  );
  await audit(req.ctx, 'department.updated', { entityType: 'department', entityId: before.id, before: deptDto(before), after: b });
  ok(res, deptDto(await loadDept(req.ctx.orgId, before.id)));
});

r.delete('/:id', { summary: 'Delete department (soft); members/teams are unassigned', ids: 'TEAM-01', permission: 'departments.manage', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const d = await loadDept(req.ctx.orgId, req.v.params.id);
  await db.tx(async () => {
    await db.query('UPDATE departments SET deleted_at = now(), updated_at = now() WHERE id = $1', [d.id]);
    await db.query('UPDATE departments SET parent_id = $2 WHERE parent_id = $1', [d.id, d.parent_id]);
    await db.query('UPDATE teams SET department_id = NULL, updated_at = now() WHERE department_id = $1', [d.id]);
    await db.query('UPDATE organization_members SET department_id = NULL, updated_at = now() WHERE department_id = $1', [d.id]);
  });
  await audit(req.ctx, 'department.deleted', { entityType: 'department', entityId: d.id, before: deptDto(d) });
  noContent(res);
});

export default r;
