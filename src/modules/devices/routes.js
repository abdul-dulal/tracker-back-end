import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { emitToLive } from '../../lib/realtime.js';
import { scopeMembers, assertMemberAccess } from '../../rbac/scope.js';
import { cmpVersion } from '../agent/service.js';

/** Desktop devices overview & revocation (DESK-22, DESK-24, DESK-25, SYNC-09, SYNC-12). */
const r = createRouter('/devices', 'Devices');

const ONLINE_WINDOW_MS = 2 * 60_000;

async function minVersions() {
  const rows = await db.many(
    `SELECT DISTINCT ON (os) os, version FROM app_releases WHERE min_supported ORDER BY os, published_at DESC`,
  );
  const latest = await db.many(`SELECT DISTINCT ON (os) os, version FROM app_releases WHERE channel = 'stable' ORDER BY os, published_at DESC`);
  return { min: Object.fromEntries(rows.map((x) => [x.os, x.version])), latest: Object.fromEntries(latest.map((x) => [x.os, x.version])) };
}

function deviceDto(d, v) {
  const online = d.status === 'active' && d.online && d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < ONLINE_WINDOW_MS;
  return {
    id: d.id,
    member: { id: d.member_id, firstName: d.first_name, lastName: d.last_name, email: d.email },
    kind: d.kind,
    os: d.os,
    osVersion: d.os_version,
    appVersion: d.app_version,
    hostname: d.hostname,
    status: d.status,
    online: !!online,
    lastSeenAt: d.last_seen_at,
    lastSyncAt: d.last_sync_at,
    pendingCount: d.pending_count,
    openConflicts: d.open_conflicts ?? 0,
    latestVersion: v.latest[d.os] ?? null,
    minSupportedVersion: v.min[d.os] ?? null,
    outdated: !!(v.min[d.os] && cmpVersion(d.app_version, v.min[d.os]) < 0),
    updateAvailable: !!(v.latest[d.os] && cmpVersion(d.app_version, v.latest[d.os]) < 0),
    createdAt: d.created_at,
  };
}

const SELECT = `
  SELECT d.*, u.first_name, u.last_name, u.email,
         (SELECT count(*)::int FROM sync_conflicts c WHERE c.device_id = d.id AND c.status = 'open') AS open_conflicts
  FROM devices d JOIN organization_members m ON m.id = d.member_id JOIN users u ON u.id = m.user_id`;

r.get(
  '/',
  {
    summary: 'Desktop devices (version, online, last seen/sync, pending uploads)',
    ids: 'DESK-22, DESK-24, SYNC-09, SYNC-12',
    permission: 'members.view',
    query: paginationQuery.extend({
      memberId: z.uuid().optional(),
      status: z.enum(['active', 'revoked']).optional(),
      outdated: z.enum(['true', 'false']).optional(),
    }),
  },
  async (req, res) => {
    const q = req.v.query;
    const w = where([req.ctx.orgId]);
    w.raw('d.organization_id = $1');
    w.add('d.member_id = ?', q.memberId);
    w.add('d.status = ?', q.status);
    if (q.search) w.add(`(u.first_name || ' ' || u.last_name || ' ' || coalesce(d.hostname,'')) ILIKE ?`, `%${q.search}%`);
    await scopeMembers(req.ctx, 'members.view', w, 'd.member_id');
    const v = await minVersions();
    let rows = (await db.many(`${SELECT} ${w.sql} ORDER BY d.last_seen_at DESC NULLS LAST`, w.params)).map((d) => deviceDto(d, v));
    if (q.outdated) rows = rows.filter((d) => d.outdated === (q.outdated === 'true'));
    const total = rows.length;
    ok(res, rows.slice((q.page - 1) * q.limit, q.page * q.limit), pageMeta(q, total));
  },
);

r.post(
  '/:id/revoke',
  { summary: 'Revoke a desktop device (logs the agent out)', ids: 'DESK-25, SEC-*', params: z.object({ id: z.uuid() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const d = await db.one('SELECT * FROM devices WHERE id = $1 AND organization_id = $2', [req.v.params.id, ctx.orgId]);
    if (!d) throw notFound('Device');
    if (d.member_id !== ctx.memberId) await assertMemberAccess(ctx, 'members.update', d.member_id);
    await db.tx(async () => {
      await db.query(`UPDATE devices SET status = 'revoked', online = false WHERE id = $1`, [d.id]);
      await db.query('UPDATE device_tokens SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL', [d.id]);
    });
    await audit(ctx, 'device.revoke', { entityType: 'device', entityId: d.id, before: { status: d.status }, after: { status: 'revoked' } });
    emitToLive(ctx.orgId, 'presence.updated', { memberId: d.member_id, deviceId: d.id, online: false, status: 'offline' });
    const row = await db.one(`${SELECT} WHERE d.id = $1`, [d.id]);
    ok(res, deviceDto(row, await minVersions()));
  },
);

export default r;
