import { db } from '../../lib/db.js';
import { badRequest, conflict, unprocessable } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { emitToUser, emitToLive } from '../../lib/realtime.js';
import { getRunningEntry, pauseTimer, resumeTimer, currentTimer } from '../time/timer-service.js';
import { recomputeRange } from '../time/summary-service.js';

/**
 * Breaks (BRK-01…08, TIME-17). Starting a break pauses the running timer (pause reason 'break');
 * ending it resumes the timer only if it is still paused for that break.
 * Reusable by the desktop agent module: startBreak(ctx, { breakTypeId, memberId?, deviceId?, at? }).
 */

export const BREAK_SELECT = `
  SELECT b.*, bt.name AS type_name, bt.color AS type_color, bt.max_minutes
  FROM breaks b JOIN break_types bt ON bt.id = b.break_type_id`;

export function breakDto(b) {
  if (!b) return null;
  const running = !b.ended_at;
  const duration = running ? Math.max(0, Math.floor((Date.now() - new Date(b.started_at).getTime()) / 1000)) : b.duration_seconds;
  return {
    id: b.id,
    memberId: b.member_id,
    breakType: { id: b.break_type_id, name: b.type_name, color: b.type_color, maxMinutes: b.max_minutes },
    timeEntryId: b.time_entry_id,
    startedAt: b.started_at,
    endedAt: b.ended_at,
    durationSeconds: duration,
    isPaid: b.is_paid,
    exceeded: running ? !!(b.max_minutes && duration > b.max_minutes * 60) : b.exceeded,
    deviceId: b.device_id,
    createdAt: b.created_at,
  };
}

export async function getOpenBreak(memberId) {
  return db.one(`${BREAK_SELECT} WHERE b.member_id = $1 AND b.ended_at IS NULL`, [memberId]);
}

async function memberUserId(memberId) {
  return (await db.one('SELECT user_id FROM organization_members WHERE id = $1', [memberId]))?.user_id;
}

export async function startBreak(ctx, { breakTypeId, memberId, deviceId, at } = {}) {
  memberId = memberId ?? ctx.memberId;
  const type = await db.one('SELECT * FROM break_types WHERE id = $1 AND organization_id = $2', [breakTypeId, ctx.orgId]);
  if (!type) throw badRequest('Break type not found', [{ path: 'body.breakTypeId', message: 'Unknown break type' }], 'INVALID_REFERENCE');
  if (type.archived_at) throw unprocessable('BREAK_TYPE_ARCHIVED', 'This break type is archived');
  if (await getOpenBreak(memberId)) throw conflict('BREAK_ALREADY_ACTIVE', 'A break is already in progress');
  const startedAt = at ? new Date(at) : new Date();
  const running = await getRunningEntry(memberId);
  let timerPaused = false;
  if (running && !running.open_pause) {
    await pauseTimer(ctx, { memberId, reason: 'break', at: startedAt });
    timerPaused = true;
  }
  const row = await db.one(
    `INSERT INTO breaks (organization_id, member_id, break_type_id, time_entry_id, device_id, started_at, is_paid)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.orgId, memberId, type.id, running?.id ?? null, deviceId ?? null, startedAt, type.is_paid],
  );
  const brk = breakDto(await db.one(`${BREAK_SELECT} WHERE b.id = $1`, [row.id]));
  const userId = await memberUserId(memberId);
  emitToUser(userId, 'break.started', brk);
  emitToLive(ctx.orgId, 'break.started', { memberId, break: brk });
  await publish('break.started', { orgId: ctx.orgId, memberId, break: brk });
  await recomputeRange(memberId, startedAt, new Date());
  return { break: brk, timerPaused, entry: await currentTimer(memberId) };
}

export async function endBreak(ctx, { memberId, resumeTimer: resume = true, at } = {}) {
  memberId = memberId ?? ctx.memberId;
  const open = await getOpenBreak(memberId);
  if (!open) throw conflict('NO_ACTIVE_BREAK', 'No break is in progress');
  const endedAt = at ? new Date(Math.max(new Date(at).getTime(), new Date(open.started_at).getTime())) : new Date();
  const duration = Math.max(0, Math.floor((endedAt - new Date(open.started_at)) / 1000));
  const exceeded = !!(open.max_minutes && duration > open.max_minutes * 60);
  await db.query('UPDATE breaks SET ended_at = $2, duration_seconds = $3, exceeded = $4 WHERE id = $1', [open.id, endedAt, duration, exceeded]);
  let timerResumed = false;
  if (resume && open.time_entry_id) {
    const running = await getRunningEntry(memberId);
    if (running && running.id === open.time_entry_id && running.open_pause?.reason === 'break') {
      await resumeTimer(ctx, { memberId, at: endedAt });
      timerResumed = true;
    }
  }
  const brk = breakDto(await db.one(`${BREAK_SELECT} WHERE b.id = $1`, [open.id]));
  const userId = await memberUserId(memberId);
  emitToUser(userId, 'break.ended', brk);
  emitToLive(ctx.orgId, 'break.ended', { memberId, break: brk });
  await publish('break.ended', { orgId: ctx.orgId, memberId, break: brk });
  await recomputeRange(memberId, open.started_at, endedAt);
  return { break: brk, timerResumed, entry: await currentTimer(memberId) };
}
