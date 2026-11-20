import { z } from 'zod';
import { createRouter, zBool } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, pageClause, where, dateStr, uuidParam } from '../../lib/http.js';
import { badRequest, forbidden, notFound, conflict } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { scopeMembers, assertMemberAccess, getOrgMember } from '../../rbac/scope.js';
import { notify, usersWithPermission } from '../notifications/service.js';
import { ENTRY_SELECT, entryDto, getEntry, resolveProjectTask, checkWeeklyLimit, finalizeEntry, writeHistory } from './timer-service.js';
import { recomputeForEntry } from './summary-service.js';
import { orgSettings, canApproveMember, assertNotLocked, attachMembers } from './entry-service.js';

/** Time entries: history, manual entry, edit/delete, approval (TIME-06, TIME-24…30). */
const r = createRouter('/time-entries', 'Time entries');

const zDateTime = z.iso.datetime({ offset: true });
const FUTURE_TOLERANCE_MS = 60_000;

const listQuery = paginationQuery.extend({
  memberId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  taskId: z.uuid().optional(),
  clientId: z.uuid().optional(),
  status: z.enum(['running', 'paused', 'pending', 'approved', 'rejected', 'completed']).optional(),
  source: z.enum(['web_timer', 'desktop', 'manual', 'import', 'integration']).optional(),
  entryType: z.enum(['work', 'meeting']).optional(),
  isBillable: zBool.optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});

const SORTABLE = { startedAt: 'e.started_at', endedAt: 'e.ended_at', duration: 'e.duration_seconds', createdAt: 'e.created_at', status: 'e.status' };
const LOCAL_DATE = `((e.started_at AT TIME ZONE coalesce(m.timezone, o.timezone, 'UTC'))::date)`;

r.get('/', { summary: 'List time entries / timer history', ids: 'TIME-24, TIME-25', permission: 'time.view', query: listQuery }, async (req, res) => {
  const q = req.v.query;
  const ctx = req.ctx;
  if (q.memberId) await assertMemberAccess(ctx, 'time.view', q.memberId);
  const w = where();
  w.add('e.organization_id = ?', ctx.orgId);
  w.raw('e.deleted_at IS NULL');
  await scopeMembers(ctx, 'time.view', w, 'e.member_id');
  w.add('e.member_id = ?', q.memberId);
  w.add('e.project_id = ?', q.projectId);
  w.add('e.task_id = ?', q.taskId);
  w.add('e.client_id = ?', q.clientId);
  w.add('e.status = ?', q.status);
  w.add('e.source = ?', q.source);
  w.add('e.entry_type = ?', q.entryType);
  w.add('e.is_billable = ?', q.isBillable);
  w.add(`${LOCAL_DATE} >= ?::date`, q.from);
  w.add(`${LOCAL_DATE} <= ?::date`, q.to);
  if (q.search) w.add('e.note ILIKE ?', `%${q.search}%`);
  const from = `FROM time_entries e JOIN organization_members m ON m.id = e.member_id JOIN organizations o ON o.id = e.organization_id`;
  const agg = await db.one(
    `SELECT count(*)::int AS total, coalesce(sum(e.duration_seconds), 0)::int AS total_seconds,
            coalesce(sum(CASE WHEN e.is_billable THEN e.duration_seconds ELSE 0 END), 0)::int AS billable_seconds
     ${from} ${w.sql}`,
    w.params,
  );
  const pc = pageClause(q, SORTABLE, 'startedAt');
  const ids = await db.many(`SELECT e.id ${from} ${w.sql} ${pc.orderBy} LIMIT ${pc.limit} OFFSET ${pc.offset}`, w.params);
  let rows = [];
  if (ids.length) {
    const list = await db.many(`${ENTRY_SELECT} WHERE e.id = ANY($1::uuid[])`, [ids.map((x) => x.id)]);
    const byId = new Map(list.map((e) => [e.id, e]));
    rows = ids.map((x) => entryDto(byId.get(x.id)));
    await attachMembers(rows);
  }
  ok(res, rows, { ...pageMeta(q, agg.total), totalSeconds: agg.total_seconds, billableSeconds: agg.billable_seconds });
});

const createBody = z
  .object({
    memberId: z.uuid().optional(),
    projectId: z.uuid().nullish(),
    taskId: z.uuid().nullish(),
    startedAt: zDateTime,
    endedAt: zDateTime,
    note: z.string().trim().max(2000).nullish(),
    isBillable: z.boolean().optional(),
    entryType: z.enum(['work', 'meeting']).default('work'),
    isOffline: z.boolean().default(false),
  })
  .refine((b) => new Date(b.endedAt) > new Date(b.startedAt), { message: 'endedAt must be after startedAt', path: ['endedAt'] });

async function notifyApprovers(ctx, entry, title, body) {
  const userIds = await usersWithPermission(ctx.orgId, 'time.approve', { memberId: entry.member_id });
  if (userIds.length)
    await notify({ orgId: ctx.orgId, userIds, type: 'approval.requested', title, body, link: `/time/approvals?entryId=${entry.id}`, data: { kind: 'time_entry', entryId: entry.id, memberId: entry.member_id } });
}

r.post('/', { summary: 'Create a manual time entry', ids: 'TIME-06, TIME-19', permission: ['time.create', 'time.manual'], body: createBody }, async (req, res) => {
  const ctx = req.ctx;
  const b = req.body;
  const memberId = b.memberId ?? ctx.memberId;
  if (memberId === ctx.memberId) {
    if (!ctx.can('time.create') && !ctx.can('time.manual')) throw forbidden('Missing permission: time.create');
  } else {
    if (!ctx.can('time.manual')) throw forbidden('Missing permission: time.manual');
    await getOrgMember(ctx.orgId, memberId);
    await assertMemberAccess(ctx, 'time.manual', memberId);
  }
  const startedAt = new Date(b.startedAt);
  const endedAt = new Date(b.endedAt);
  if (endedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw badRequest('Manual entries cannot end in the future', undefined, 'INVALID_TIME');
  const ref = await resolveProjectTask(ctx.orgId, memberId, { projectId: b.projectId ?? undefined, taskId: b.taskId ?? undefined }, { allowAnyProject: ctx.can('time.manual') === 'org' });
  const duration = Math.floor((endedAt - startedAt) / 1000);
  const { warning } = await checkWeeklyLimit(ctx.orgId, memberId, ref.projectId, duration);
  const settings = await orgSettings(ctx.orgId);
  const needsApproval = settings.require_manual_time_approval && !(await canApproveMember(ctx, memberId));
  const status = needsApproval ? 'pending' : 'approved';
  const row = await db.tx(async () => {
    const e = await db.one(
      `INSERT INTO time_entries (organization_id, member_id, project_id, task_id, client_id, started_at, ended_at, duration_seconds,
         entry_type, source, is_offline, is_billable, note, status, approved_by, approved_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [ctx.orgId, memberId, ref.projectId, ref.taskId, ref.clientId, startedAt, endedAt, duration, b.entryType, b.isOffline, b.isBillable ?? ref.isBillableDefault, b.note ?? null, status,
        status === 'approved' ? ctx.memberId : null, status === 'approved' ? new Date() : null, ctx.memberId],
    );
    await finalizeEntry(e.id);
    await writeHistory(ctx.orgId, e.id, ctx.memberId, 'create', null, { projectId: ref.projectId, taskId: ref.taskId, startedAt, endedAt, status, source: 'manual' });
    return e;
  });
  const entry = await getEntry(row.id, ctx.orgId);
  if (needsApproval) await notifyApprovers(ctx, entry, 'Manual time entry awaiting approval', `A manual time entry of ${(duration / 3600).toFixed(2)}h needs your approval.`);
  if (memberId !== ctx.memberId) await audit(ctx, 'time_entry.created_for_member', { entityType: 'time_entry', entityId: entry.id, after: { memberId, startedAt, endedAt } });
  await recomputeForEntry(entry);
  const dto = entryDto(entry);
  await publish('time_entry.created', { orgId: ctx.orgId, memberId, entry: dto });
  created(res, { entry: dto, warning: warning ?? null });
});

const bulkBody = z.object({ ids: z.array(z.uuid()).min(1).max(200), reason: z.string().trim().max(1000).optional() });

/** Approve/reject one entry; returns null on success or a skip reason. */
async function decide(ctx, id, action, reason) {
  const entry = await getEntry(id, ctx.orgId);
  if (!entry) return { error: notFound('Time entry') };
  try {
    await assertMemberAccess(ctx, 'time.approve', entry.member_id);
    if (!entry.ended_at) throw conflict('ENTRY_RUNNING', 'A running entry cannot be approved or rejected');
    const target = action === 'approve' ? 'approved' : 'rejected';
    if (entry.status === target) throw conflict('INVALID_STATUS', `Entry is already ${target}`);
    if (action === 'reject' && entry.invoice_id) throw conflict('TIMESHEET_LOCKED', 'This entry has been invoiced');
    await db.tx(async () => {
      await db.query(
        `UPDATE time_entries SET status = $2, approval_reason = $3, approved_by = $4, approved_at = now(), updated_at = now() WHERE id = $1`,
        [id, target, reason ?? null, ctx.memberId],
      );
      await writeHistory(ctx.orgId, id, ctx.memberId, action, { status: entry.status }, { status: target }, reason);
    });
    const fresh = await getEntry(id, ctx.orgId);
    await recomputeForEntry(fresh);
    const dto = entryDto(fresh);
    await notify({
      orgId: ctx.orgId,
      memberIds: [entry.member_id],
      type: 'approval.resolved',
      title: action === 'approve' ? 'Time entry approved' : 'Time entry rejected',
      body: action === 'approve' ? 'Your time entry was approved.' : `Your time entry was rejected${reason ? `: ${reason}` : '.'}`,
      link: `/time/entries/${id}`,
      data: { kind: 'time_entry', entryId: id, decision: target, reason: reason ?? null },
    });
    await publish(action === 'approve' ? 'time_entry.approved' : 'time_entry.rejected', { orgId: ctx.orgId, memberId: entry.member_id, entry: dto, reason: reason ?? null });
    return { dto };
  } catch (err) {
    return { error: err };
  }
}

for (const action of ['approve', 'reject']) {
  r.post(
    `/bulk-${action}`,
    {
      summary: `Bulk ${action} time entries`,
      ids: action === 'approve' ? 'TIME-28' : 'TIME-29',
      permission: 'time.approve',
      body: action === 'reject' ? bulkBody.extend({ reason: z.string().trim().min(1).max(1000) }) : bulkBody,
    },
    async (req, res) => {
      const done = [];
      const skipped = [];
      for (const id of [...new Set(req.body.ids)]) {
        const out = await decide(req.ctx, id, action, req.body.reason);
        if (out.error) skipped.push({ id, code: out.error.code ?? 'ERROR', message: out.error.message });
        else done.push(out.dto);
      }
      ok(res, { [action === 'approve' ? 'approved' : 'rejected']: done.map((d) => d.id), skipped, entries: done });
    },
  );
}

r.get('/:id', { summary: 'Time entry detail', ids: 'TIME-25', permission: 'time.view', params: uuidParam }, async (req, res) => {
  const entry = await getEntry(req.v.params.id, req.ctx.orgId);
  if (!entry) throw notFound('Time entry');
  await assertMemberAccess(req.ctx, 'time.view', entry.member_id);
  const dto = entryDto(entry);
  await attachMembers([dto]);
  const pauses = await db.many('SELECT id, started_at, ended_at, reason FROM time_entry_pauses WHERE time_entry_id = $1 ORDER BY started_at', [entry.id]);
  const idle = await db.many(
    'SELECT id, started_at, ended_at, duration_seconds, resolution, resolved_at, note FROM idle_periods WHERE time_entry_id = $1 ORDER BY started_at',
    [entry.id],
  );
  dto.pauses = pauses.map((p) => ({ id: p.id, startedAt: p.started_at, endedAt: p.ended_at, reason: p.reason }));
  dto.idlePeriods = idle.map((i) => ({ id: i.id, startedAt: i.started_at, endedAt: i.ended_at, durationSeconds: i.duration_seconds, resolution: i.resolution, resolvedAt: i.resolved_at, note: i.note }));
  ok(res, dto);
});

r.get('/:id/history', { summary: 'Time entry edit history', ids: 'TIME-25, TIME-26', permission: 'time.view', params: uuidParam }, async (req, res) => {
  const entry = await db.one('SELECT id, member_id FROM time_entries WHERE id = $1 AND organization_id = $2', [req.v.params.id, req.ctx.orgId]);
  if (!entry) throw notFound('Time entry');
  await assertMemberAccess(req.ctx, 'time.view', entry.member_id);
  const rows = await db.many(
    `SELECT h.*, u.first_name, u.last_name FROM time_entry_history h
     LEFT JOIN organization_members m ON m.id = h.changed_by LEFT JOIN users u ON u.id = m.user_id
     WHERE h.time_entry_id = $1 ORDER BY h.created_at, h.id`,
    [entry.id],
  );
  ok(
    res,
    rows.map((h) => ({
      id: h.id,
      action: h.action,
      changedBy: h.changed_by ? { id: h.changed_by, name: [h.first_name, h.last_name].filter(Boolean).join(' ') } : null,
      before: h.before,
      after: h.after,
      reason: h.reason,
      createdAt: h.created_at,
    })),
  );
});

const patchBody = z
  .object({
    startedAt: zDateTime.optional(),
    endedAt: zDateTime.optional(),
    projectId: z.uuid().nullable().optional(),
    taskId: z.uuid().nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    isBillable: z.boolean().optional(),
    entryType: z.enum(['work', 'meeting']).optional(),
    editReason: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((b) => Object.keys(b).some((k) => k !== 'editReason' && b[k] !== undefined), { message: 'Nothing to update' });

/**
 * Resolve who may modify an entry. Returns { own, privileged, settings }.
 * Privileged = holds time.approve over the entry's member (managers/admins). Non-privileged editing own
 * entries needs the org setting allow_employee_edit_time / allow_employee_delete_time.
 */
async function modifyAccess(ctx, entry, perm) {
  const own = entry.member_id === ctx.memberId;
  if (!own) await assertMemberAccess(ctx, perm, entry.member_id);
  const privileged = await canApproveMember(ctx, entry.member_id);
  const settings = await orgSettings(ctx.orgId);
  if (own && !privileged) {
    const allowed = perm === 'time.update' ? settings.allow_employee_edit_time : settings.allow_employee_delete_time;
    if (!allowed)
      throw forbidden(perm === 'time.update' ? 'Your organization does not allow editing time entries' : 'Your organization does not allow deleting time entries', 'TIME_EDIT_NOT_ALLOWED');
  }
  return { own, privileged, settings };
}

r.patch('/:id', { summary: 'Edit a time entry', ids: 'TIME-26, TIME-30', permission: 'time.update', params: uuidParam, body: patchBody }, async (req, res) => {
  const ctx = req.ctx;
  const b = req.body;
  const entry = await getEntry(req.v.params.id, ctx.orgId);
  if (!entry) throw notFound('Time entry');
  const { own, privileged, settings } = await modifyAccess(ctx, entry, 'time.update');
  if ((!own || entry.status === 'approved') && !b.editReason)
    throw badRequest('editReason is required when editing another member’s entry or an approved entry', [{ path: 'body.editReason', message: 'Required' }], 'EDIT_REASON_REQUIRED');

  const running = !entry.ended_at;
  if (running && (b.startedAt !== undefined || b.endedAt !== undefined || b.isBillable !== undefined || b.entryType !== undefined))
    throw conflict('ENTRY_RUNNING', 'Only note, project and task can be changed while the timer is running');

  const startedAt = b.startedAt ? new Date(b.startedAt) : new Date(entry.started_at);
  const endedAt = running ? null : b.endedAt ? new Date(b.endedAt) : new Date(entry.ended_at);
  const timeChanged = !running && (startedAt.getTime() !== new Date(entry.started_at).getTime() || endedAt.getTime() !== new Date(entry.ended_at).getTime());
  if (!running) {
    if (endedAt <= startedAt) throw badRequest('endedAt must be after startedAt', [{ path: 'body.endedAt', message: 'Must be after startedAt' }], 'INVALID_TIME');
    if (endedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw badRequest('Entries cannot end in the future', undefined, 'INVALID_TIME');
  }
  await assertNotLocked(entry, timeChanged ? [{ start: startedAt, end: endedAt }] : []);

  // Project / task changes
  let ref = { projectId: entry.project_id, taskId: entry.task_id, clientId: entry.client_id };
  if (b.projectId !== undefined || b.taskId !== undefined) {
    let projectId = b.projectId !== undefined ? b.projectId : entry.project_id;
    let taskId = b.taskId !== undefined ? b.taskId : entry.task_id;
    if (b.projectId !== undefined && b.taskId === undefined && b.projectId !== entry.project_id) taskId = null;
    if (b.taskId && b.projectId === undefined) projectId = null; // derive from task
    if (!projectId && !taskId) ref = { projectId: null, taskId: null, clientId: null };
    else
      ref = await resolveProjectTask(ctx.orgId, entry.member_id, { projectId: projectId ?? undefined, taskId: taskId ?? undefined }, {
        allowAnyProject: ctx.can('time.manual') === 'org' || ctx.isAdminLike(),
      });
  }

  let status = entry.status;
  if (own && !privileged && !running) {
    if (entry.source !== 'manual') status = 'pending';
    else if (settings.require_manual_time_approval) status = 'pending';
  }

  const before = {
    startedAt: entry.started_at, endedAt: entry.ended_at, projectId: entry.project_id, taskId: entry.task_id,
    note: entry.note, isBillable: entry.is_billable, entryType: entry.entry_type, status: entry.status,
  };
  const after = {
    startedAt, endedAt, projectId: ref.projectId, taskId: ref.taskId,
    note: b.note !== undefined ? b.note : entry.note,
    isBillable: b.isBillable ?? entry.is_billable,
    entryType: b.entryType ?? entry.entry_type,
    status,
  };
  await db.tx(async () => {
    await db.query(
      `UPDATE time_entries SET started_at = $2, ended_at = $3, project_id = $4, task_id = $5, client_id = $6, note = $7, is_billable = $8,
         entry_type = $9, status = $10, edit_reason = coalesce($11, edit_reason),
         approved_by = CASE WHEN $10 = 'pending' THEN NULL ELSE approved_by END,
         approved_at = CASE WHEN $10 = 'pending' THEN NULL ELSE approved_at END, updated_at = now()
       WHERE id = $1`,
      [entry.id, startedAt, endedAt, ref.projectId, ref.taskId, ref.clientId, after.note, after.isBillable, after.entryType, status, b.editReason ?? null],
    );
    if (timeChanged) {
      // Clamp pauses to the new range so durations stay consistent.
      await db.query(`DELETE FROM time_entry_pauses WHERE time_entry_id = $1 AND (started_at >= $3 OR ended_at <= $2)`, [entry.id, startedAt, endedAt]);
      await db.query(
        `UPDATE time_entry_pauses SET started_at = greatest(started_at, $2), ended_at = least(ended_at, $3) WHERE time_entry_id = $1`,
        [entry.id, startedAt, endedAt],
      );
      await db.query(
        `UPDATE time_entries SET paused_seconds = coalesce((SELECT sum(extract(epoch FROM (ended_at - started_at)))::int FROM time_entry_pauses WHERE time_entry_id = $1 AND ended_at IS NOT NULL), 0) WHERE id = $1`,
        [entry.id],
      );
    }
    await finalizeEntry(entry.id);
    await writeHistory(ctx.orgId, entry.id, ctx.memberId, 'update', before, after, b.editReason);
  });
  const fresh = await getEntry(entry.id, ctx.orgId);
  if (!own) await audit(ctx, 'time_entry.updated', { entityType: 'time_entry', entityId: entry.id, before, after });
  if (status === 'pending' && entry.status !== 'pending')
    await notifyApprovers(ctx, fresh, 'Edited time entry awaiting approval', 'A time entry was edited and needs your approval.');
  await recomputeForEntry(fresh, entry);
  const dto = entryDto(fresh);
  await publish('time_entry.updated', { orgId: ctx.orgId, memberId: entry.member_id, entry: dto, before });
  ok(res, dto);
});

r.delete(
  '/:id',
  { summary: 'Delete a time entry (soft delete)', ids: 'TIME-27', permission: 'time.delete', params: uuidParam, body: z.object({ reason: z.string().trim().max(1000).optional() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const entry = await getEntry(req.v.params.id, ctx.orgId);
    if (!entry) throw notFound('Time entry');
    await modifyAccess(ctx, entry, 'time.delete');
    if (!entry.ended_at) throw conflict('ENTRY_RUNNING', 'Stop the timer before deleting this entry');
    await assertNotLocked(entry);
    await db.tx(async () => {
      await db.query('UPDATE time_entries SET deleted_at = now(), updated_at = now() WHERE id = $1', [entry.id]);
      await writeHistory(ctx.orgId, entry.id, ctx.memberId, 'delete', { status: entry.status, startedAt: entry.started_at, endedAt: entry.ended_at }, null, req.body?.reason);
    });
    await audit(ctx, 'time_entry.deleted', { entityType: 'time_entry', entityId: entry.id, before: { memberId: entry.member_id, startedAt: entry.started_at, endedAt: entry.ended_at, durationSeconds: entry.duration_seconds } });
    await recomputeForEntry(entry);
    await publish('time_entry.deleted', { orgId: ctx.orgId, memberId: entry.member_id, entryId: entry.id, entry: entryDto(entry) });
    noContent(res);
  },
);

for (const action of ['approve', 'reject']) {
  r.post(
    `/:id/${action}`,
    {
      summary: `${action === 'approve' ? 'Approve' : 'Reject'} a time entry`,
      ids: action === 'approve' ? 'TIME-28' : 'TIME-29',
      permission: 'time.approve',
      params: uuidParam,
      body: z.object({ reason: action === 'reject' ? z.string().trim().min(1).max(1000) : z.string().trim().max(1000).optional() }),
    },
    async (req, res) => {
      const out = await decide(req.ctx, req.v.params.id, action, req.body.reason);
      if (out.error) throw out.error;
      ok(res, out.dto);
    },
  );
}

export default r;
