import { db } from '../../lib/db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { emitToUser } from '../../lib/realtime.js';
import { getEntry, entryDto, resolveProjectTask, finalizeEntry, writeHistory } from '../time/timer-service.js';
import { recomputeRange } from '../time/summary-service.js';
import { assertNotLocked, recalcPausedSeconds } from '../time/entry-service.js';

/**
 * Idle periods (TIME-16, TIME-20, TIME-22, BRK-10…15). Resolution never auto-resumes silently:
 * the employee (or an approver) decides keep / discard / reassign.
 */

export function idleDto(i) {
  return {
    id: i.id,
    memberId: i.member_id,
    timeEntryId: i.time_entry_id,
    deviceId: i.device_id,
    startedAt: i.started_at,
    endedAt: i.ended_at,
    durationSeconds: i.duration_seconds,
    resolution: i.resolution,
    resolvedAt: i.resolved_at,
    reassignedEntryId: i.reassigned_entry_id,
    note: i.note,
    createdAt: i.created_at,
  };
}

export async function getIdle(id, orgId) {
  return db.one('SELECT * FROM idle_periods WHERE id = $1 AND organization_id = $2', [id, orgId]);
}

async function userOf(memberId) {
  return (await db.one('SELECT user_id FROM organization_members WHERE id = $1', [memberId]))?.user_id;
}

/** Apply keep/discard to an idle period (also used by adjustment approval). */
export async function applyKeepDiscard(ctx, idle, resolution, note) {
  await db.tx(async () => {
    await db.query(`UPDATE idle_periods SET resolution = $2, resolved_at = now(), note = coalesce($3, note) WHERE id = $1`, [idle.id, resolution, note ?? null]);
    if (idle.time_entry_id) {
      await finalizeEntry(idle.time_entry_id);
      await writeHistory(ctx.orgId, idle.time_entry_id, ctx.memberId, 'update', { idlePeriodId: idle.id, resolution: idle.resolution }, { idlePeriodId: idle.id, resolution }, note ?? `idle ${resolution}`);
    }
  });
  await recomputeRange(idle.member_id, idle.started_at, idle.ended_at);
}

/**
 * Reassign idle time to another project/task by splitting the original entry in one transaction:
 *   original [s, idle.start) · new completed [idle.start, idle.end) · continuation [idle.end, original end or running).
 */
async function reassign(ctx, idle, { projectId, taskId, note }, { allowAnyProject }) {
  const original = idle.time_entry_id ? await getEntry(idle.time_entry_id, ctx.orgId) : null;
  if (original) {
    const oStart = new Date(original.started_at).getTime();
    const oEnd = original.ended_at ? new Date(original.ended_at).getTime() : Infinity;
    if (new Date(idle.started_at).getTime() < oStart || new Date(idle.ended_at).getTime() > oEnd)
      throw conflict('IDLE_OUTSIDE_ENTRY', 'The idle period is not within its time entry');
    await assertNotLocked(original);
  }
  const ref = await resolveProjectTask(ctx.orgId, idle.member_id, { projectId: projectId ?? undefined, taskId: taskId ?? undefined }, { allowAnyProject });
  const idleStart = new Date(idle.started_at);
  const idleEnd = new Date(idle.ended_at);

  const result = await db.tx(async () => {
    let continuationId = null;
    if (original) {
      const running = !original.ended_at;
      const needsContinuation = running || new Date(original.ended_at) > idleEnd;
      const before = { startedAt: original.started_at, endedAt: original.ended_at, status: original.status };
      const newStatus = running ? 'completed' : original.status;
      // 1. shrink the original to [start, idle.start)
      await db.query(
        `UPDATE time_entries SET ended_at = $2, status = $3, updated_at = now() WHERE id = $1`,
        [original.id, idleStart, newStatus],
      );
      // 2. continuation [idle.end, original end)
      if (needsContinuation) {
        const pausedOpen = running && original.open_pause;
        const c = await db.one(
          `INSERT INTO time_entries (organization_id, member_id, project_id, task_id, client_id, device_id, started_at, ended_at, entry_type, source,
             is_offline, is_billable, note, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [ctx.orgId, original.member_id, original.project_id, original.task_id, original.client_id, original.device_id, idleEnd, original.ended_at,
            original.entry_type, original.source, original.is_offline, original.is_billable, original.note,
            running ? (pausedOpen ? 'paused' : 'running') : original.status, ctx.memberId],
        );
        continuationId = c.id;
        // pauses that extend past idle end (incl. an open pause) move to the continuation
        await db.query(
          `UPDATE time_entry_pauses SET time_entry_id = $2, started_at = greatest(started_at, $3)
           WHERE time_entry_id = $1 AND coalesce(ended_at, 'infinity'::timestamptz) > $3 AND started_at >= $4`,
          [original.id, continuationId, idleEnd, idleStart],
        );
        await db.query(
          `INSERT INTO time_entry_pauses (time_entry_id, started_at, ended_at, reason)
           SELECT $2, $3, ended_at, reason FROM time_entry_pauses
           WHERE time_entry_id = $1 AND started_at < $4 AND coalesce(ended_at, 'infinity'::timestamptz) > $3`,
          [original.id, continuationId, idleEnd, idleStart],
        );
        // child rows recorded after the idle period follow the continuation
        await db.query(`UPDATE idle_periods SET time_entry_id = $2 WHERE time_entry_id = $1 AND started_at >= $3 AND id <> $4`, [original.id, continuationId, idleEnd, idle.id]);
        await db.query(`UPDATE activity_samples SET time_entry_id = $2 WHERE time_entry_id = $1 AND interval_start >= $3`, [original.id, continuationId, idleEnd]);
        await db.query(`UPDATE screenshots SET time_entry_id = $2 WHERE time_entry_id = $1 AND captured_at >= $3`, [original.id, continuationId, idleEnd]);
        await db.query(`UPDATE app_usage SET time_entry_id = $2 WHERE time_entry_id = $1 AND started_at >= $3`, [original.id, continuationId, idleEnd]);
        await db.query(`UPDATE web_usage SET time_entry_id = $2 WHERE time_entry_id = $1 AND started_at >= $3`, [original.id, continuationId, idleEnd]);
        await db.query(`UPDATE breaks SET time_entry_id = $2 WHERE time_entry_id = $1 AND started_at >= $3`, [original.id, continuationId, idleEnd]);
      }
      // clamp/drop remaining pauses of the original to [start, idle.start)
      await db.query(`DELETE FROM time_entry_pauses WHERE time_entry_id = $1 AND started_at >= $2`, [original.id, idleStart]);
      await db.query(
        `UPDATE time_entry_pauses SET ended_at = $2 WHERE time_entry_id = $1 AND (ended_at IS NULL OR ended_at > $2)`,
        [original.id, idleStart],
      );
      await recalcPausedSeconds(original.id);
      if (continuationId) await recalcPausedSeconds(continuationId);
      await writeHistory(ctx.orgId, original.id, ctx.memberId, 'update', before, { startedAt: original.started_at, endedAt: idleStart, status: newStatus }, `idle period ${idle.id} reassigned`);
      if (continuationId)
        await writeHistory(ctx.orgId, continuationId, ctx.memberId, 'create', null, { splitFrom: original.id, startedAt: idleEnd, endedAt: original.ended_at }, `continuation after idle period ${idle.id}`);
    }
    // 3. the reassigned idle time as its own completed entry
    const n = await db.one(
      `INSERT INTO time_entries (organization_id, member_id, project_id, task_id, client_id, device_id, started_at, ended_at, entry_type, source,
         is_offline, is_billable, note, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'completed',$14) RETURNING id`,
      [ctx.orgId, idle.member_id, ref.projectId, ref.taskId, ref.clientId, original?.device_id ?? idle.device_id ?? null, idleStart, idleEnd,
        original?.entry_type ?? 'work', original?.source ?? 'web_timer', original?.is_offline ?? false, ref.projectId ? ref.isBillableDefault : (original?.is_billable ?? true),
        note ?? original?.note ?? null, ctx.memberId],
    );
    await db.query(
      `UPDATE idle_periods SET resolution = 'reassigned', resolved_at = now(), reassigned_entry_id = $2, time_entry_id = NULL, note = coalesce($3, note) WHERE id = $1`,
      [idle.id, n.id, note ?? null],
    );
    await writeHistory(ctx.orgId, n.id, ctx.memberId, 'create', null, { reassignedFromIdle: idle.id, splitFrom: original?.id ?? null, projectId: ref.projectId, taskId: ref.taskId, startedAt: idleStart, endedAt: idleEnd }, 'idle time reassigned');
    if (original) await finalizeEntry(original.id);
    if (continuationId) await finalizeEntry(continuationId);
    await finalizeEntry(n.id);
    return { originalId: original?.id ?? null, newId: n.id, continuationId };
  });
  await recomputeRange(idle.member_id, original?.started_at ?? idleStart, original?.ended_at ?? new Date());
  const entries = {
    original: result.originalId ? entryDto(await getEntry(result.originalId, ctx.orgId)) : null,
    reassigned: entryDto(await getEntry(result.newId, ctx.orgId)),
    continuation: result.continuationId ? entryDto(await getEntry(result.continuationId, ctx.orgId)) : null,
  };
  if (entries.original) await publish('time_entry.updated', { orgId: ctx.orgId, memberId: idle.member_id, entry: entries.original });
  await publish('time_entry.created', { orgId: ctx.orgId, memberId: idle.member_id, entry: entries.reassigned });
  if (entries.continuation) {
    await publish('time_entry.created', { orgId: ctx.orgId, memberId: idle.member_id, entry: entries.continuation });
    if (!entries.continuation.endedAt) emitToUser(await userOf(idle.member_id), 'timer.updated', entries.continuation);
  }
  return entries;
}

/**
 * Resolve a pending idle period.
 * @param {{action:'keep'|'discard'|'reassign', projectId?, taskId?, note?}} input
 */
export async function resolveIdle(ctx, idleId, input, { allowAnyProject = false } = {}) {
  const idle = await getIdle(idleId, ctx.orgId);
  if (!idle) throw notFound('Idle period');
  if (idle.resolution !== 'pending') throw conflict('IDLE_ALREADY_RESOLVED', 'This idle period has already been resolved');
  let entries = null;
  if (input.action === 'reassign') {
    if (!input.projectId && !input.taskId) throw badRequest('projectId or taskId is required to reassign idle time', undefined, 'VALIDATION_ERROR');
    entries = await reassign(ctx, idle, input, { allowAnyProject });
  } else {
    if (input.action === 'discard' && idle.time_entry_id) {
      const e = await getEntry(idle.time_entry_id, ctx.orgId);
      if (e) await assertNotLocked(e);
    }
    await applyKeepDiscard(ctx, idle, input.action === 'keep' ? 'kept' : 'discarded', input.note);
  }
  const fresh = await getIdle(idleId, ctx.orgId);
  const entry = !entries && fresh.time_entry_id ? entryDto(await getEntry(fresh.time_entry_id, ctx.orgId)) : null;
  if (entry) await publish('time_entry.updated', { orgId: ctx.orgId, memberId: idle.member_id, entry });
  return { idlePeriod: idleDto(fresh), entry, entries };
}
