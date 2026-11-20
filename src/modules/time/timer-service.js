import { db } from '../../lib/db.js';
import { conflict, badRequest, notFound, forbidden, unprocessable } from '../../lib/errors.js';
import { camel } from '../../lib/http.js';
import { publish } from '../../lib/events.js';
import { emitToUser, emitToLive } from '../../lib/realtime.js';
import { getEffectiveSettings, assertConsent } from '../settings/effective.js';
import { memberProjectIds } from '../../rbac/scope.js';
import { recomputeForEntry, memberTimezone } from './summary-service.js';

/**
 * Timer state machine (TIME-01…04, TIME-10, TIME-21/22, TIME-31). Shared by the web timer
 * (/timer/*) and the desktop agent (/agent/timer/*), so both always see one server-side state.
 *
 * States: running ⇄ paused → (stop) completed. Exactly one open entry per member is enforced by
 * a partial unique index; overlapping entries are rejected by an exclusion constraint.
 * duration_seconds (net worked) = (ended_at − started_at) − paused_seconds − idle_discarded_seconds.
 */

export const ENTRY_SELECT = `
  SELECT e.*, p.name AS project_name, p.color AS project_color, t.title AS task_title, c.name AS client_name,
         (SELECT row_to_json(x) FROM (SELECT id, started_at, reason FROM time_entry_pauses WHERE time_entry_id = e.id AND ended_at IS NULL) x) AS open_pause
  FROM time_entries e
  LEFT JOIN projects p ON p.id = e.project_id
  LEFT JOIN tasks t ON t.id = e.task_id
  LEFT JOIN clients c ON c.id = e.client_id`;

export function entryDto(e) {
  if (!e) return null;
  const now = Date.now();
  const running = !e.ended_at;
  let liveSeconds = e.duration_seconds;
  if (running) {
    const openPause = e.open_pause ? now - new Date(e.open_pause.started_at).getTime() : 0;
    liveSeconds = Math.max(0, Math.floor((now - new Date(e.started_at).getTime() - openPause) / 1000) - e.paused_seconds - e.idle_discarded_seconds);
  }
  return {
    id: e.id,
    memberId: e.member_id,
    project: e.project_id ? { id: e.project_id, name: e.project_name, color: e.project_color } : null,
    task: e.task_id ? { id: e.task_id, title: e.task_title } : null,
    client: e.client_id ? { id: e.client_id, name: e.client_name } : null,
    startedAt: e.started_at,
    endedAt: e.ended_at,
    durationSeconds: liveSeconds,
    pausedSeconds: e.paused_seconds,
    idleSeconds: e.idle_seconds,
    idleDiscardedSeconds: e.idle_discarded_seconds,
    activeSeconds: e.active_seconds,
    entryType: e.entry_type,
    source: e.source,
    isOffline: e.is_offline,
    isBillable: e.is_billable,
    note: e.note,
    status: e.status,
    approvalReason: e.approval_reason,
    approvedBy: e.approved_by,
    approvedAt: e.approved_at,
    timesheetId: e.timesheet_id,
    invoiceId: e.invoice_id,
    // Hard lock = invoiced. Approved entries remain editable by approvers with an edit reason;
    // timesheet-period locks are evaluated by the time-entries module (entry-service).
    locked: !!e.invoice_id,
    pause: e.open_pause ? { id: e.open_pause.id, startedAt: e.open_pause.started_at, reason: e.open_pause.reason } : null,
    deviceId: e.device_id,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    serverNow: new Date(now).toISOString(),
  };
}

export async function getEntry(id, orgId) {
  return db.one(`${ENTRY_SELECT} WHERE e.id = $1 AND e.organization_id = $2 AND e.deleted_at IS NULL`, [id, orgId]);
}

export async function getRunningEntry(memberId) {
  return db.one(`${ENTRY_SELECT} WHERE e.member_id = $1 AND e.ended_at IS NULL AND e.deleted_at IS NULL`, [memberId]);
}

export async function writeHistory(orgId, entryId, actorMemberId, action, before, after, reason) {
  await db.query(
    `INSERT INTO time_entry_history (organization_id, time_entry_id, changed_by, action, before, after, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orgId, entryId, actorMemberId ?? null, action, db.json(before), db.json(after), reason ?? null],
  );
}

/**
 * Validate project/task for a member and return { projectId, taskId, clientId, isBillableDefault }.
 * The member must belong to the project unless `allowAnyProject` (admin manual entry).
 */
export async function resolveProjectTask(orgId, memberId, { projectId, taskId }, { allowAnyProject = false } = {}) {
  let project = null;
  if (taskId) {
    const task = await db.one('SELECT id, project_id FROM tasks WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [taskId, orgId]);
    if (!task) throw badRequest('Task not found', undefined, 'INVALID_REFERENCE');
    if (projectId && projectId !== task.project_id) throw badRequest('Task does not belong to the selected project', undefined, 'INVALID_REFERENCE');
    projectId = task.project_id;
  }
  if (projectId) {
    project = await db.one('SELECT id, client_id, is_billable_default, archived_at, status FROM projects WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [projectId, orgId]);
    if (!project) throw badRequest('Project not found', undefined, 'INVALID_REFERENCE');
    if (project.archived_at) throw unprocessable('PROJECT_ARCHIVED', 'Time cannot be tracked on an archived project');
    if (!allowAnyProject) {
      const ids = await memberProjectIds({ memberId, cache: new Map() }, memberId);
      if (!ids.includes(projectId)) throw forbidden('You are not assigned to this project', 'NOT_ASSIGNED_TO_PROJECT');
    }
  }
  return { projectId: projectId ?? null, taskId: taskId ?? null, clientId: project?.client_id ?? null, isBillableDefault: project?.is_billable_default ?? true };
}

/** Worked seconds of the member in the current local week (for TIME-31 weekly limits). */
export async function workedThisWeek(memberId, extraSeconds = 0) {
  const tz = await memberTimezone(memberId);
  const org = await db.one('SELECT o.week_start FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.id = $1', [memberId]);
  const r = await db.one(
    `WITH bounds AS (
       SELECT ((date_trunc('day', now() AT TIME ZONE $2) - (((extract(dow FROM now() AT TIME ZONE $2)::int - $3 + 7) % 7) || ' days')::interval) AT TIME ZONE $2) AS ws)
     SELECT coalesce(sum(CASE WHEN ended_at IS NULL
                THEN greatest(extract(epoch FROM (now() - greatest(started_at, b.ws))) - paused_seconds - idle_discarded_seconds, 0)
                ELSE duration_seconds * least(1, extract(epoch FROM (ended_at - greatest(started_at, b.ws))) / nullif(extract(epoch FROM (ended_at - started_at)), 0)) END), 0)::int AS s
     FROM time_entries, bounds b
     WHERE member_id = $1 AND deleted_at IS NULL AND status <> 'rejected' AND coalesce(ended_at, now()) > b.ws`,
    [memberId, tz, org?.week_start ?? 1],
  );
  return r.s + extraSeconds;
}

/** Check the weekly limit; returns { warning } or throws in block mode. */
export async function checkWeeklyLimit(orgId, memberId, projectId, extraSeconds = 0) {
  const { settings } = await getEffectiveSettings(orgId, { memberId, projectId });
  if (!settings.weeklyLimitHours) return { warning: null };
  const worked = await workedThisWeek(memberId, extraSeconds);
  const limit = settings.weeklyLimitHours * 3600;
  if (worked >= limit) {
    if (settings.limitMode === 'block')
      throw unprocessable('WEEKLY_LIMIT_EXCEEDED', `Weekly limit of ${settings.weeklyLimitHours}h reached`, { limitHours: settings.weeklyLimitHours, workedSeconds: worked });
    return { warning: { code: 'WEEKLY_LIMIT_EXCEEDED', limitHours: settings.weeklyLimitHours, workedSeconds: worked } };
  }
  if (worked >= limit * 0.9) return { warning: { code: 'WEEKLY_LIMIT_NEAR', limitHours: settings.weeklyLimitHours, workedSeconds: worked } };
  return { warning: null };
}

async function broadcast(event, orgId, entry, extra = {}) {
  const dto = entryDto(entry);
  const userRow = await db.one('SELECT user_id FROM organization_members WHERE id = $1', [entry.member_id]);
  emitToUser(userRow.user_id, event, dto);
  emitToLive(orgId, event, { memberId: entry.member_id, entry: dto, ...extra });
  await publish(event, { orgId, memberId: entry.member_id, entry: dto, ...extra });
  return dto;
}

/**
 * Start a timer.
 * @param {object} ctx request context (orgId, memberId of the actor)
 * @param {{memberId?:string, projectId?:string, taskId?:string, note?:string, entryType?:'work'|'meeting', source?:string, deviceId?:string, startedAt?:Date|string, isBillable?:boolean}} opts
 */
export async function startTimer(ctx, opts = {}) {
  const memberId = opts.memberId ?? ctx.memberId;
  await assertConsent(ctx.orgId, memberId);
  const existing = await getRunningEntry(memberId);
  if (existing) throw conflict('TIMER_ALREADY_RUNNING', 'A timer is already running. Stop it first or switch tasks.', { entry: entryDto(existing) });
  const ref = await resolveProjectTask(ctx.orgId, memberId, opts);
  const { warning } = await checkWeeklyLimit(ctx.orgId, memberId, ref.projectId);
  const startedAt = opts.startedAt ? new Date(opts.startedAt) : new Date();
  if (startedAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('Start time cannot be in the future', undefined, 'INVALID_TIME');
  const row = await db.tx(async () => {
    const e = await db.one(
      `INSERT INTO time_entries (organization_id, member_id, project_id, task_id, client_id, device_id, started_at, entry_type, source,
         is_billable, note, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'running',$12) RETURNING id`,
      [ctx.orgId, memberId, ref.projectId, ref.taskId, ref.clientId, opts.deviceId ?? null, startedAt, opts.entryType ?? 'work', opts.source ?? 'web_timer', opts.isBillable ?? ref.isBillableDefault, opts.note ?? null, ctx.memberId ?? null],
    );
    await writeHistory(ctx.orgId, e.id, ctx.memberId, 'start', null, { projectId: ref.projectId, taskId: ref.taskId, startedAt });
    return e;
  });
  const entry = await getEntry(row.id, ctx.orgId);
  const dto = await broadcast('timer.started', ctx.orgId, entry);
  return { entry: dto, warning };
}

/** Pause the running timer (manual, idle auto-pause, or break). */
export async function pauseTimer(ctx, { memberId, reason = 'manual', at } = {}) {
  memberId = memberId ?? ctx.memberId;
  const entry = await getRunningEntry(memberId);
  if (!entry) throw conflict('NO_RUNNING_TIMER', 'No timer is running');
  if (entry.open_pause) throw conflict('TIMER_ALREADY_PAUSED', 'Timer is already paused');
  const pausedAt = at ? new Date(at) : new Date();
  await db.tx(async () => {
    await db.query(`INSERT INTO time_entry_pauses (time_entry_id, started_at, reason) VALUES ($1,$2,$3)`, [entry.id, pausedAt, reason]);
    await db.query(`UPDATE time_entries SET status = 'paused', updated_at = now() WHERE id = $1`, [entry.id]);
    await writeHistory(ctx.orgId, entry.id, ctx.memberId, 'pause', null, { at: pausedAt, reason });
  });
  const fresh = await getEntry(entry.id, ctx.orgId);
  return { entry: await broadcast('timer.paused', ctx.orgId, fresh, { reason }) };
}

/** Close an open pause and add its length to paused_seconds. */
async function closePause(entryId, at) {
  const p = await db.one(
    `UPDATE time_entry_pauses SET ended_at = greatest($2::timestamptz, started_at) WHERE time_entry_id = $1 AND ended_at IS NULL
     RETURNING extract(epoch FROM (ended_at - started_at))::int AS secs`,
    [entryId, at],
  );
  if (p) await db.query('UPDATE time_entries SET paused_seconds = paused_seconds + $2 WHERE id = $1', [entryId, p.secs]);
  return p?.secs ?? 0;
}

export async function resumeTimer(ctx, { memberId, at } = {}) {
  memberId = memberId ?? ctx.memberId;
  const entry = await getRunningEntry(memberId);
  if (!entry) throw conflict('NO_RUNNING_TIMER', 'No timer is running');
  if (!entry.open_pause) throw conflict('TIMER_NOT_PAUSED', 'Timer is not paused');
  const resumedAt = at ? new Date(at) : new Date();
  await db.tx(async () => {
    await closePause(entry.id, resumedAt);
    await db.query(`UPDATE time_entries SET status = 'running', updated_at = now() WHERE id = $1`, [entry.id]);
    await writeHistory(ctx.orgId, entry.id, ctx.memberId, 'resume', null, { at: resumedAt });
  });
  const fresh = await getEntry(entry.id, ctx.orgId);
  return { entry: await broadcast('timer.resumed', ctx.orgId, fresh) };
}

/** Finalize computed fields of a closed entry (duration, active seconds, idle seconds). */
export async function finalizeEntry(entryId) {
  await db.query(
    `UPDATE time_entries e SET
       idle_seconds = coalesce((SELECT sum(duration_seconds) FROM idle_periods WHERE time_entry_id = e.id), 0),
       idle_discarded_seconds = coalesce((SELECT sum(duration_seconds) FROM idle_periods WHERE time_entry_id = e.id AND resolution IN ('discarded','reassigned')), 0),
       active_seconds = coalesce((SELECT sum(active_seconds) FROM activity_samples WHERE time_entry_id = e.id), 0),
       updated_at = now()
     WHERE e.id = $1`,
    [entryId],
  );
  await db.query(
    `UPDATE time_entries SET duration_seconds = greatest(0, extract(epoch FROM (ended_at - started_at))::int - paused_seconds - idle_discarded_seconds)
     WHERE id = $1 AND ended_at IS NOT NULL`,
    [entryId],
  );
}

export async function stopTimer(ctx, { memberId, at, note } = {}) {
  memberId = memberId ?? ctx.memberId;
  const entry = await getRunningEntry(memberId);
  if (!entry) throw conflict('NO_RUNNING_TIMER', 'No timer is running');
  const endedAt = at ? new Date(at) : new Date();
  if (endedAt < new Date(entry.started_at)) throw badRequest('Stop time is before start time', undefined, 'INVALID_TIME');
  await db.tx(async () => {
    await closePause(entry.id, endedAt);
    await db.query(
      `UPDATE time_entries SET ended_at = $2, status = 'completed', note = coalesce($3, note), updated_at = now() WHERE id = $1`,
      [entry.id, endedAt, note ?? null],
    );
    await finalizeEntry(entry.id);
    await writeHistory(ctx.orgId, entry.id, ctx.memberId, 'stop', null, { at: endedAt });
  });
  const fresh = await getEntry(entry.id, ctx.orgId);
  await recomputeForEntry(fresh);
  return { entry: await broadcast('timer.stopped', ctx.orgId, fresh) };
}

/** Atomically stop the current timer and start a new one (TIME-07/08 task switch). */
export async function switchTimer(ctx, opts) {
  const memberId = opts.memberId ?? ctx.memberId;
  const now = new Date();
  const running = await getRunningEntry(memberId);
  if (running) await stopTimer(ctx, { memberId, at: now });
  return startTimer(ctx, { ...opts, memberId, startedAt: now });
}

/** Current timer state for a member. */
export async function currentTimer(memberId) {
  const e = await getRunningEntry(memberId);
  return e ? entryDto(e) : null;
}

export { notFound, camel };
