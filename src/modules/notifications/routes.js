import { z } from 'zod';
import { createRouter, zBool } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, noContent, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';

/** In-app notification center (NOTIF-01…23, F.13). Own notifications only. */
const r = createRouter('/notifications', 'Notifications');

export function notificationDto(n) {
  return {
    id: n.id,
    organizationId: n.organization_id,
    type: n.type,
    title: n.title,
    body: n.body,
    data: n.data,
    link: n.link,
    read: !!n.read_at,
    readAt: n.read_at,
    channels: n.channels_sent,
    createdAt: n.created_at,
  };
}

/** Own notifications; when an org is active, only that org's (plus org-less system) notifications. */
function scope(ctx) {
  const w = where();
  w.add('n.recipient_user_id = ?', ctx.userId);
  if (ctx.orgId) w.add('(n.organization_id = ? OR n.organization_id IS NULL)', ctx.orgId);
  // Rows created with in-app disabled are stored pre-read and only exist for email/desktop delivery.
  w.raw(`'in_app' = ANY(n.channels_sent)`);
  return w;
}

r.get(
  '/',
  {
    auth: 'user',
    summary: 'List my notifications',
    ids: 'NOTIF-01…NOTIF-22',
    query: paginationQuery.extend({ unread: zBool.optional(), type: z.string().max(60).optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    const w = scope(req.ctx);
    if (q.unread === true) w.raw('n.read_at IS NULL');
    if (q.unread === false) w.raw('n.read_at IS NOT NULL');
    w.add('n.type = ?', q.type);
    const total = (await db.one(`SELECT count(*)::int AS n FROM notifications n ${w.sql}`, w.params)).n;
    const rows = await db.many(
      `SELECT n.* FROM notifications n ${w.sql} ORDER BY n.created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      w.params,
    );
    const unread = (await db.one(`SELECT count(*)::int AS n FROM notifications n ${scope(req.ctx).sql} AND n.read_at IS NULL`, scope(req.ctx).params)).n;
    ok(res, rows.map(notificationDto), { ...pageMeta(q, total), unread });
  },
);

r.get('/unread-count', { auth: 'user', summary: 'Unread notification count', ids: 'NOTIF-22' }, async (req, res) => {
  const w = scope(req.ctx);
  w.raw('n.read_at IS NULL');
  const row = await db.one(`SELECT count(*)::int AS n FROM notifications n ${w.sql}`, w.params);
  ok(res, { count: row.n });
});

r.post('/read-all', { auth: 'user', summary: 'Mark all my notifications read', ids: 'NOTIF-22' }, async (req, res) => {
  const w = scope(req.ctx);
  w.raw('n.read_at IS NULL');
  const r2 = await db.query(`UPDATE notifications n SET read_at = now() ${w.sql}`, w.params);
  ok(res, { updated: r2.rowCount });
});

r.patch(
  '/:id/read',
  {
    auth: 'user',
    summary: 'Mark a notification read (or unread with {read:false})',
    ids: 'NOTIF-22',
    params: z.object({ id: z.uuid() }),
    body: z.object({ read: z.boolean().default(true) }).optional(),
  },
  async (req, res) => {
    const read = req.body?.read ?? true;
    const row = await db.one(
      `UPDATE notifications SET read_at = CASE WHEN $3 THEN coalesce(read_at, now()) ELSE NULL END
       WHERE id = $1 AND recipient_user_id = $2 RETURNING *`,
      [req.v.params.id, req.ctx.userId, read],
    );
    if (!row) throw notFound('Notification');
    ok(res, notificationDto(row));
  },
);

r.delete('/:id', { auth: 'user', summary: 'Delete a notification', ids: 'NOTIF-22', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const row = await db.one('DELETE FROM notifications WHERE id = $1 AND recipient_user_id = $2 RETURNING id', [req.v.params.id, req.ctx.userId]);
  if (!row) throw notFound('Notification');
  noContent(res);
});

export default r;
