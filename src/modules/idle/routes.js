import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, paginationQuery, pageMeta, pageClause, where, dateStr, uuidParam } from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { assertMemberAccess, scopeMembers } from '../../rbac/scope.js';
import { notify, usersWithPermission } from '../notifications/service.js';
import { getEntry } from '../time/timer-service.js';
import { assertNotLocked } from '../time/entry-service.js';
import { idleDto, getIdle, resolveIdle, applyKeepDiscard } from './service.js';

/** Idle periods & idle adjustment requests (TIME-16, TIME-20, TIME-22, BRK-10…15). */

/**
 * Member filter for idle data: own data always; others need idle.approve within scope.
 */
async function scopeIdle(ctx, w, column, memberId) {
  if (memberId) {
    if (memberId !== ctx.memberId) await assertMemberAccess(ctx, 'idle.approve', memberId);
    w.add(`${column} = ?`, memberId);
  } else if (ctx.can('idle.approve')) {
    await scopeMembers(ctx, 'idle.approve', w, column);
  } else {
    w.add(`${column} = ?`, ctx.memberId);
  }
}

async function assertOwnOrApprover(ctx, memberId) {
  if (memberId === ctx.memberId) return;
  if (!ctx.can('idle.approve')) throw forbidden('You can only manage your own idle time');
  await assertMemberAccess(ctx, 'idle.approve', memberId);
}

// ───────────── /idle-periods ─────────────
const periods = createRouter('/idle-periods', 'Idle periods');

periods.get(
  '/',
  {
    summary: 'List idle periods (pending by default for own)',
    ids: 'TIME-16, TIME-20, BRK-10, BRK-11',
    permission: ['timer.use', 'idle.approve'],
    query: paginationQuery.extend({
      status: z.enum(['pending', 'kept', 'discarded', 'reassigned']).optional(),
      memberId: z.uuid().optional(),
      timeEntryId: z.uuid().optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const w = where();
    w.add('i.organization_id = ?', ctx.orgId);
    await scopeIdle(ctx, w, 'i.member_id', q.memberId);
    w.add('i.resolution = ?', q.status);
    w.add('i.time_entry_id = ?', q.timeEntryId);
    const local = `((i.started_at AT TIME ZONE coalesce(m.timezone, o.timezone, 'UTC'))::date)`;
    w.add(`${local} >= ?::date`, q.from);
    w.add(`${local} <= ?::date`, q.to);
    const from = `FROM idle_periods i JOIN organization_members m ON m.id = i.member_id JOIN organizations o ON o.id = i.organization_id`;
    const agg = await db.one(`SELECT count(*)::int AS total, coalesce(sum(i.duration_seconds), 0)::int AS secs ${from} ${w.sql}`, w.params);
    const pc = pageClause(q, { startedAt: 'i.started_at', duration: 'i.duration_seconds' }, 'startedAt');
    const rows = await db.many(`SELECT i.* ${from} ${w.sql} ${pc.orderBy} LIMIT ${pc.limit} OFFSET ${pc.offset}`, w.params);
    ok(res, rows.map(idleDto), { ...pageMeta(q, agg.total), totalSeconds: agg.secs });
  },
);

const resolveBody = z.object({
  action: z.enum(['keep', 'discard', 'reassign']),
  projectId: z.uuid().nullish(),
  taskId: z.uuid().nullish(),
  note: z.string().trim().max(1000).nullish(),
});

async function resolveHandler(req, res) {
  const ctx = req.ctx;
  const idle = await getIdle(req.v.params.id, ctx.orgId);
  if (!idle) throw notFound('Idle period');
  await assertOwnOrApprover(ctx, idle.member_id);
  const out = await resolveIdle(ctx, idle.id, req.body, { allowAnyProject: ctx.can('time.manual') === 'org' || ctx.isAdminLike() });
  ok(res, out);
}

periods.post(
  '/:id/resolve',
  { summary: 'Resolve idle time: keep, discard or reassign', ids: 'TIME-22, BRK-12', permission: ['timer.use', 'idle.approve'], params: uuidParam, body: resolveBody },
  resolveHandler,
);

/** Alias per TIME-22: POST /timer/idle/:id/resolve. */
const timerIdle = createRouter('/timer/idle', 'Idle periods');
timerIdle.post(
  '/:id/resolve',
  { summary: 'Resolve idle time (alias)', ids: 'TIME-22', permission: ['timer.use', 'idle.approve'], params: uuidParam, body: resolveBody },
  resolveHandler,
);

// ───────────── /idle-adjustments ─────────────
const adj = createRouter('/idle-adjustments', 'Idle adjustments');

const ADJ_SELECT = `SELECT a.*, i.started_at AS idle_started_at, i.ended_at AS idle_ended_at, i.duration_seconds AS idle_duration, i.resolution AS idle_resolution,
       i.time_entry_id, u.first_name, u.last_name
  FROM idle_adjustment_requests a JOIN idle_periods i ON i.id = a.idle_period_id
  JOIN organization_members m ON m.id = a.member_id JOIN users u ON u.id = m.user_id`;

function adjDto(a) {
  return {
    id: a.id,
    member: { id: a.member_id, name: [a.first_name, a.last_name].filter(Boolean).join(' ') },
    idlePeriod: { id: a.idle_period_id, startedAt: a.idle_started_at, endedAt: a.idle_ended_at, durationSeconds: a.idle_duration, resolution: a.idle_resolution, timeEntryId: a.time_entry_id },
    requestedAction: a.requested_action,
    reason: a.reason,
    status: a.status,
    reviewedBy: a.reviewed_by,
    reviewedAt: a.reviewed_at,
    reviewNote: a.review_note,
    createdAt: a.created_at,
  };
}

const getAdj = (id, orgId) => db.one(`${ADJ_SELECT} WHERE a.id = $1 AND a.organization_id = $2`, [id, orgId]);

adj.get(
  '/',
  {
    summary: 'List idle adjustment requests',
    ids: 'BRK-14, BRK-15',
    permission: ['timer.use', 'idle.approve'],
    query: paginationQuery.extend({ status: z.enum(['pending', 'approved', 'rejected']).optional(), memberId: z.uuid().optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const w = where();
    w.add('a.organization_id = ?', ctx.orgId);
    await scopeIdle(ctx, w, 'a.member_id', q.memberId);
    w.add('a.status = ?', q.status);
    const total = (await db.one(`SELECT count(*)::int AS n FROM idle_adjustment_requests a ${w.sql}`, w.params)).n;
    const pc = pageClause(q, { createdAt: 'a.created_at' }, 'createdAt');
    const rows = await db.many(`${ADJ_SELECT} ${w.sql} ${pc.orderBy} LIMIT ${pc.limit} OFFSET ${pc.offset}`, w.params);
    ok(res, rows.map(adjDto), pageMeta(q, total));
  },
);

adj.post(
  '/',
  {
    summary: 'Request an idle time adjustment',
    ids: 'BRK-14',
    permission: 'timer.use',
    body: z.object({ idlePeriodId: z.uuid(), requestedAction: z.enum(['keep', 'discard']), reason: z.string().trim().min(1).max(1000) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    const idle = await getIdle(b.idlePeriodId, ctx.orgId);
    if (!idle) throw badRequest('Idle period not found', [{ path: 'body.idlePeriodId', message: 'Unknown idle period' }], 'INVALID_REFERENCE');
    if (idle.member_id !== ctx.memberId) throw forbidden('You can only request adjustments for your own idle time');
    if (idle.resolution === 'reassigned') throw conflict('IDLE_ALREADY_REASSIGNED', 'Reassigned idle time cannot be adjusted');
    const target = b.requestedAction === 'keep' ? 'kept' : 'discarded';
    if (idle.resolution === target) throw conflict('NO_CHANGE', `Idle period is already ${target}`);
    const pending = await db.one(`SELECT id FROM idle_adjustment_requests WHERE idle_period_id = $1 AND status = 'pending'`, [idle.id]);
    if (pending) throw conflict('ADJUSTMENT_PENDING', 'An adjustment request for this idle period is already pending', { id: pending.id });
    const row = await db.one(
      `INSERT INTO idle_adjustment_requests (organization_id, idle_period_id, member_id, requested_action, reason) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.orgId, idle.id, ctx.memberId, b.requestedAction, b.reason],
    );
    const userIds = await usersWithPermission(ctx.orgId, 'idle.approve', { memberId: ctx.memberId });
    if (userIds.length)
      await notify({
        orgId: ctx.orgId,
        userIds,
        type: 'approval.requested',
        title: 'Idle time adjustment requested',
        body: `A team member asked to ${b.requestedAction} ${Math.round(idle.duration_seconds / 60)} minutes of idle time: ${b.reason}`,
        link: `/approvals/idle-adjustments/${row.id}`,
        data: { kind: 'idle_adjustment', requestId: row.id, memberId: ctx.memberId },
      });
    created(res, adjDto(await getAdj(row.id, ctx.orgId)));
  },
);

for (const action of ['approve', 'reject']) {
  adj.post(
    `/:id/${action}`,
    {
      summary: `${action === 'approve' ? 'Approve' : 'Reject'} an idle adjustment request`,
      ids: 'BRK-15',
      permission: 'idle.approve',
      params: uuidParam,
      body: z.object({ note: z.string().trim().max(1000).optional() }),
    },
    async (req, res) => {
      const ctx = req.ctx;
      const a = await getAdj(req.v.params.id, ctx.orgId);
      if (!a) throw notFound('Idle adjustment request');
      await assertMemberAccess(ctx, 'idle.approve', a.member_id);
      if (a.status !== 'pending') throw conflict('INVALID_STATUS', `Request is already ${a.status}`);
      if (action === 'approve') {
        const idle = await getIdle(a.idle_period_id, ctx.orgId);
        if (idle.resolution === 'reassigned') throw conflict('IDLE_ALREADY_REASSIGNED', 'Reassigned idle time cannot be adjusted');
        if (idle.time_entry_id) {
          const e = await getEntry(idle.time_entry_id, ctx.orgId);
          if (e) await assertNotLocked(e);
        }
        await db.tx(async () => {
          await applyKeepDiscard(ctx, idle, a.requested_action === 'keep' ? 'kept' : 'discarded', req.body.note);
          await db.query(`UPDATE idle_adjustment_requests SET status = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`, [a.id, ctx.memberId, req.body.note ?? null]);
        });
      } else {
        await db.query(`UPDATE idle_adjustment_requests SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`, [a.id, ctx.memberId, req.body.note ?? null]);
      }
      await notify({
        orgId: ctx.orgId,
        memberIds: [a.member_id],
        type: 'approval.resolved',
        title: action === 'approve' ? 'Idle adjustment approved' : 'Idle adjustment rejected',
        body: `Your request to ${a.requested_action} idle time was ${action === 'approve' ? 'approved' : 'rejected'}${req.body.note ? `: ${req.body.note}` : '.'}`,
        link: `/time/idle`,
        data: { kind: 'idle_adjustment', requestId: a.id, decision: action === 'approve' ? 'approved' : 'rejected' },
      });
      ok(res, adjDto(await getAdj(a.id, ctx.orgId)));
    },
  );
}

export default [periods, timerIdle, adj];
