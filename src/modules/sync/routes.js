import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { notFound, conflict, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { publish } from '../../lib/events.js';
import { scopeMembers, assertMemberAccess } from '../../rbac/scope.js';
import { writeHistory, finalizeEntry } from '../time/timer-service.js';
import { recomputeRange } from '../time/summary-service.js';
import { overlappingEntries, insertOfflineEntry, conflictDto } from './service.js';

/** Sync conflict review (SYNC-08, ADM-16). */
const r = createRouter('/sync-conflicts', 'Sync conflicts');

const SELECT = `
  SELECT c.*, u.first_name, u.last_name, e.started_at AS conflicting_started_at, e.ended_at AS conflicting_ended_at, e.status AS conflicting_status
  FROM sync_conflicts c JOIN organization_members m ON m.id = c.member_id JOIN users u ON u.id = m.user_id
  LEFT JOIN time_entries e ON e.id = c.conflicting_entity_id`;

const reviewPerm = (ctx) => (ctx.can('time.approve') ? 'time.approve' : 'time.update');

r.get(
  '/',
  {
    summary: 'Offline sync conflicts for review',
    ids: 'SYNC-08, ADM-16',
    permission: ['time.approve', 'time.update'],
    query: paginationQuery.extend({ status: z.enum(['open', 'resolved']).optional(), memberId: z.uuid().optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    const w = where([req.ctx.orgId]);
    w.raw('c.organization_id = $1');
    w.add('c.status = ?', q.status);
    w.add('c.member_id = ?', q.memberId);
    await scopeMembers(req.ctx, reviewPerm(req.ctx), w, 'c.member_id');
    const total = (await db.one(`SELECT count(*)::int AS n FROM sync_conflicts c ${w.sql}`, w.params)).n;
    const rows = await db.many(`${SELECT} ${w.sql} ORDER BY c.created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, w.params);
    ok(res, rows.map(conflictDto), pageMeta(q, total));
  },
);

r.post(
  '/:id/resolve',
  {
    summary: 'Resolve a sync conflict (keep server or keep device data)',
    ids: 'SYNC-08',
    permission: ['time.approve', 'time.update'],
    params: z.object({ id: z.uuid() }),
    body: z.strictObject({ resolution: z.enum(['keep_server', 'keep_device']) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const c = await db.one('SELECT * FROM sync_conflicts WHERE id = $1 AND organization_id = $2', [req.v.params.id, ctx.orgId]);
    if (!c) throw notFound('Sync conflict');
    await assertMemberAccess(ctx, reviewPerm(ctx), c.member_id);
    if (c.status !== 'open') throw conflict('ALREADY_RESOLVED', 'This conflict has already been resolved');
    const resolution = req.body.resolution;
    let createdEntryId = null;
    const touched = [];
    if (resolution === 'keep_device') {
      if (c.entity_type !== 'time_entry') throw badRequest('Unsupported conflict type');
      const p = c.payload;
      const start = new Date(p.startedAt);
      const end = new Date(p.endedAt);
      await db.tx(async () => {
        const overlaps = await overlappingEntries(c.member_id, start, end);
        for (const e of overlaps) {
          const lockedTs = e.timesheet_id
            ? await db.one(`SELECT 1 FROM timesheets WHERE id = $1 AND (status = 'approved' OR locked_at IS NOT NULL)`, [e.timesheet_id])
            : null;
          if (e.status === 'approved' || e.invoice_id || lockedTs)
            throw conflict('ENTRY_LOCKED', 'An overlapping server entry is approved or locked; the server data must be kept');
          if (!e.ended_at) throw conflict('ENTRY_RUNNING', 'An overlapping entry is still running; stop it first');
        }
        for (const e of overlaps) {
          const es = new Date(e.started_at);
          const ee = new Date(e.ended_at);
          touched.push([es, ee]);
          const before = { startedAt: e.started_at, endedAt: e.ended_at };
          if (es >= start && ee <= end) {
            await db.query('UPDATE time_entries SET deleted_at = now(), updated_at = now() WHERE id = $1', [e.id]);
            await writeHistory(ctx.orgId, e.id, ctx.memberId, 'delete', before, null, 'Sync conflict resolved: device data kept');
            continue;
          }
          if (es < start && ee > end) {
            // Device range sits inside the server entry → split it around the device range.
            await db.query(
              `UPDATE time_entries SET ended_at = $2, paused_seconds = least(paused_seconds, extract(epoch FROM ($2::timestamptz - started_at))::int), updated_at = now() WHERE id = $1`,
              [e.id, start],
            );
            const tail = await db.one(
              `INSERT INTO time_entries (organization_id, member_id, project_id, task_id, client_id, device_id, started_at, ended_at, entry_type, source,
                 is_offline, is_billable, note, status, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
              [e.organization_id, e.member_id, e.project_id, e.task_id, e.client_id, e.device_id, end, ee, e.entry_type, e.source,
                e.is_offline, e.is_billable, e.note, e.status, ctx.memberId],
            );
            await finalizeEntry(e.id);
            await finalizeEntry(tail.id);
            await writeHistory(ctx.orgId, e.id, ctx.memberId, 'update', before, { startedAt: e.started_at, endedAt: start }, 'Sync conflict resolved: split');
            await writeHistory(ctx.orgId, tail.id, ctx.memberId, 'create', null, { startedAt: end, endedAt: ee }, 'Sync conflict resolved: split');
            continue;
          }
          if (es < start) {
            await db.query(
              `UPDATE time_entries SET ended_at = $2, paused_seconds = least(paused_seconds, extract(epoch FROM ($2::timestamptz - started_at))::int), updated_at = now() WHERE id = $1`,
              [e.id, start],
            );
            await writeHistory(ctx.orgId, e.id, ctx.memberId, 'update', before, { startedAt: e.started_at, endedAt: start }, 'Sync conflict resolved: trimmed');
          } else {
            await db.query(
              `UPDATE time_entries SET started_at = $2, paused_seconds = least(paused_seconds, extract(epoch FROM (ended_at - $2::timestamptz))::int), updated_at = now() WHERE id = $1`,
              [e.id, end],
            );
            await writeHistory(ctx.orgId, e.id, ctx.memberId, 'update', before, { startedAt: end, endedAt: e.ended_at }, 'Sync conflict resolved: trimmed');
          }
          await finalizeEntry(e.id);
        }
        const deviceRow = c.device_id ? await db.one('SELECT id FROM devices WHERE id = $1', [c.device_id]) : null;
        const entry = await insertOfflineEntry(
          { orgId: ctx.orgId, memberId: c.member_id, deviceId: deviceRow?.id ?? null },
          { ...p, clientUuid: deviceRow ? p.clientUuid : null },
          { createdBy: ctx.memberId },
        );
        createdEntryId = entry.id;
        await db.query(`UPDATE sync_conflicts SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`, [
          c.id,
          resolution,
          ctx.memberId,
        ]);
      });
      touched.push([start, end]);
      const all = touched.flat();
      await recomputeRange(c.member_id, new Date(Math.min(...all)), new Date(Math.max(...all)));
    } else {
      await db.query(`UPDATE sync_conflicts SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`, [
        c.id,
        resolution,
        ctx.memberId,
      ]);
    }
    await audit(ctx, 'sync_conflict.resolve', { entityType: 'sync_conflict', entityId: c.id, after: { resolution, createdEntryId } });
    if (createdEntryId) await publish('time_entry.updated', { orgId: ctx.orgId, memberId: c.member_id, conflictId: c.id });
    const row = await db.one(`${SELECT} WHERE c.id = $1`, [c.id]);
    ok(res, { ...conflictDto(row), createdEntryId });
  },
);

export default r;
