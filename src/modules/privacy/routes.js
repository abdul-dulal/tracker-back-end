import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { notFound, conflict, forbidden } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { enqueue } from '../../lib/jobs.js';
import { signedGetUrl } from '../../lib/storage.js';
import { notify, usersWithPermission } from '../notifications/service.js';
import { getOrgMember } from '../../rbac/scope.js';

/** Data export / deletion requests (PRIV-07, PRIV-08, SEC-19, SEC-20). */
const r = createRouter('/data-requests', 'Privacy');
const MANAGE = 'privacy.requests.manage';
const idParam = z.object({ id: z.uuid() });

export function requestDto(d) {
  return {
    id: d.id,
    member: { id: d.member_id, name: d.member_name ?? null, email: d.member_email ?? null },
    type: d.type,
    status: d.status,
    reason: d.reason,
    notes: d.notes,
    requestedAt: d.requested_at,
    dueAt: d.due_at,
    processedBy: d.processed_by,
    processedAt: d.processed_at,
    downloadAvailable: d.type === 'export' && d.status === 'completed' && !!d.file_key,
  };
}

const SELECT = `SELECT d.*, trim(u.first_name || ' ' || u.last_name) AS member_name, u.email AS member_email
  FROM data_requests d JOIN organization_members m ON m.id = d.member_id JOIN users u ON u.id = m.user_id`;

const isManager = (ctx) => ctx.can(MANAGE) === 'org';

async function loadRequest(ctx, id) {
  const d = await db.one(`${SELECT} WHERE d.id = $1 AND d.organization_id = $2`, [id, ctx.orgId]);
  if (!d || (!isManager(ctx) && d.member_id !== ctx.memberId)) throw notFound('Data request');
  return d;
}

r.get(
  '/',
  {
    summary: 'List data requests (own, or all with privacy.requests.manage)',
    ids: 'PRIV-07, PRIV-08',
    query: paginationQuery.extend({
      status: z.enum(['pending', 'approved', 'processing', 'completed', 'rejected']).optional(),
      type: z.enum(['export', 'deletion']).optional(),
      memberId: z.uuid().optional(),
    }),
  },
  async (req, res) => {
    const q = req.v.query;
    const w = where();
    w.add('d.organization_id = ?', req.ctx.orgId);
    if (isManager(req.ctx)) w.add('d.member_id = ?', q.memberId);
    else w.add('d.member_id = ?', req.ctx.memberId);
    w.add('d.status = ?', q.status);
    w.add('d.type = ?', q.type);
    const total = (await db.one(`SELECT count(*)::int AS n FROM data_requests d ${w.sql}`, w.params)).n;
    const rows = await db.many(`${SELECT} ${w.sql} ORDER BY d.requested_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, w.params);
    ok(res, rows.map(requestDto), pageMeta(q, total));
  },
);

r.post(
  '/',
  {
    summary: 'Request an export or deletion of my data (admins may file for a member)',
    ids: 'PRIV-07, PRIV-08',
    body: z.object({ type: z.enum(['export', 'deletion']), reason: z.string().trim().max(2000).optional(), memberId: z.uuid().optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    let memberId = ctx.memberId;
    if (req.body.memberId && req.body.memberId !== ctx.memberId) {
      if (!isManager(ctx)) throw forbidden('You can only request your own data');
      memberId = (await getOrgMember(ctx.orgId, req.body.memberId)).id;
    }
    if (!memberId) throw forbidden('A member context is required');
    const open = await db.one(
      `SELECT id FROM data_requests WHERE member_id = $1 AND type = $2 AND status IN ('pending','approved','processing')`,
      [memberId, req.body.type],
    );
    if (open) throw conflict('REQUEST_PENDING', `An open ${req.body.type} request already exists`, { id: open.id });
    const row = await db.one(
      `INSERT INTO data_requests (organization_id, member_id, type, reason) VALUES ($1,$2,$3,$4) RETURNING id`,
      [ctx.orgId, memberId, req.body.type, req.body.reason ?? null],
    );
    const d = await db.one(`${SELECT} WHERE d.id = $1`, [row.id]);
    await audit(ctx, 'data_request.create', { entityType: 'data_request', entityId: d.id, after: { type: d.type, memberId } });
    const approvers = (await usersWithPermission(ctx.orgId, MANAGE)).filter((u) => u !== ctx.userId);
    await notify({
      orgId: ctx.orgId,
      userIds: approvers,
      type: 'approval.requested',
      title: `Data ${d.type} request`,
      body: `${d.member_name} requested a data ${d.type}.`,
      link: '/settings/privacy/requests',
      data: { dataRequestId: d.id },
    });
    created(res, requestDto(d));
  },
);

r.get('/:id', { summary: 'Get a data request', ids: 'PRIV-07, PRIV-08', params: idParam }, async (req, res) => {
  ok(res, requestDto(await loadRequest(req.ctx, req.v.params.id)));
});

r.post(
  '/:id/approve',
  { summary: 'Approve a data request (starts processing)', ids: 'PRIV-07, PRIV-08', permission: MANAGE, params: idParam, body: z.object({ notes: z.string().max(2000).optional() }).optional() },
  async (req, res) => {
    const ctx = req.ctx;
    if (!isManager(ctx)) throw forbidden('Organization-wide privacy permission required');
    const d = await db.one(
      `UPDATE data_requests SET status = 'approved', processed_by = $3, notes = coalesce($4, notes) WHERE id = $1 AND organization_id = $2 AND status = 'pending' RETURNING id`,
      [req.v.params.id, ctx.orgId, ctx.memberId ?? null, req.body?.notes ?? null],
    );
    if (!d) {
      await loadRequest(ctx, req.v.params.id);
      throw conflict('INVALID_STATUS', 'Only pending requests can be approved');
    }
    await enqueue('privacy.process', { requestId: d.id }, { dedupeKey: `privacy:${d.id}`, maxAttempts: 3 });
    const row = await db.one(`${SELECT} WHERE d.id = $1`, [d.id]);
    await audit(ctx, 'data_request.approve', { entityType: 'data_request', entityId: d.id, after: { type: row.type, memberId: row.member_id } });
    ok(res, requestDto(row));
  },
);

r.post(
  '/:id/reject',
  { summary: 'Reject a data request', ids: 'PRIV-07, PRIV-08', permission: MANAGE, params: idParam, body: z.object({ reason: z.string().trim().min(1).max(2000) }) },
  async (req, res) => {
    const ctx = req.ctx;
    if (!isManager(ctx)) throw forbidden('Organization-wide privacy permission required');
    const d = await db.one(
      `UPDATE data_requests SET status = 'rejected', processed_by = $3, processed_at = now(), notes = $4 WHERE id = $1 AND organization_id = $2 AND status = 'pending' RETURNING id`,
      [req.v.params.id, ctx.orgId, ctx.memberId ?? null, req.body.reason],
    );
    if (!d) {
      await loadRequest(ctx, req.v.params.id);
      throw conflict('INVALID_STATUS', 'Only pending requests can be rejected');
    }
    const row = await db.one(`${SELECT} WHERE d.id = $1`, [d.id]);
    await audit(ctx, 'data_request.reject', { entityType: 'data_request', entityId: d.id, after: { reason: req.body.reason } });
    await notify({
      orgId: ctx.orgId,
      memberIds: [row.member_id],
      type: 'approval.resolved',
      title: `Data ${row.type} request rejected`,
      body: req.body.reason,
      link: '/me/privacy',
      data: { dataRequestId: row.id },
    });
    ok(res, requestDto(row));
  },
);

r.get('/:id/download', { summary: 'Signed download URL of a completed export', ids: 'PRIV-08, SEC-19', params: idParam }, async (req, res) => {
  const d = await loadRequest(req.ctx, req.v.params.id);
  if (d.type !== 'export' || d.status !== 'completed' || !d.file_key) throw conflict('NOT_READY', 'The export is not ready');
  const ttl = 10 * 60;
  ok(res, {
    url: signedGetUrl(d.file_key, { ttl, download: true, filename: `tracker-data-export-${String(d.requested_at instanceof Date ? d.requested_at.toISOString() : d.requested_at).slice(0, 10)}.zip` }),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  });
});

export default r;
