import { z } from 'zod';
import { db } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { resolveProjectTask, finalizeEntry, writeHistory, getEntry, entryDto } from '../time/timer-service.js';
import { recomputeRange } from '../time/summary-service.js';
import {
  zTs,
  activitySample,
  appUsageItem,
  webUsageItem,
  idleItem,
  screenshotItem,
  checkRange,
  findEntryAt,
  ingestActivity,
  ingestAppUsage,
  ingestWebUsage,
  ingestIdle,
  ingestScreenshots,
  memberSettings,
  summarize,
} from '../agent/service.js';

/**
 * Offline synchronization (guide §M20 SYNC-01…12).
 * Batches are idempotent by (device_id, batch_uuid): a replayed batch returns the stored results.
 * Every item carries a clientUuid; duplicates are detected per table (UNIQUE(device_id, client_uuid)).
 * Offline time entries that overlap existing entries are never written silently — they become
 * `sync_conflicts` rows for review (SYNC-08).
 */

const withUuid = (schema) => schema.extend({ clientUuid: z.uuid() });

export const syncEntryItem = z.strictObject({
  clientUuid: z.uuid(),
  projectId: z.uuid().nullable().optional(),
  taskId: z.uuid().nullable().optional(),
  startedAt: zTs,
  endedAt: zTs,
  note: z.string().max(2000).nullable().optional(),
  entryType: z.enum(['work', 'meeting']).default('work'),
  isBillable: z.boolean().optional(),
});
export const syncPauseItem = z.strictObject({
  clientUuid: z.uuid(),
  timeEntryClientUuid: z.uuid(),
  startedAt: zTs,
  endedAt: zTs,
  reason: z.enum(['manual', 'idle', 'break']).default('manual'),
});
export const syncBreakItem = z.strictObject({
  clientUuid: z.uuid(),
  breakTypeId: z.uuid().optional(),
  startedAt: zTs,
  endedAt: zTs,
});

const MAX = 1000;
export const syncBody = z.strictObject({
  batchUuid: z.uuid(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i, 'Expected SHA-256 hex'),
  pendingCount: z.number().int().min(0).optional(),
  items: z.strictObject({
    timeEntries: z.array(syncEntryItem).max(MAX).default([]),
    pauses: z.array(syncPauseItem).max(MAX).default([]),
    idlePeriods: z.array(withUuid(idleItem)).max(MAX).default([]),
    breaks: z.array(syncBreakItem).max(MAX).default([]),
    activity: z.array(activitySample).max(5000).default([]),
    appUsage: z.array(withUuid(appUsageItem)).max(5000).default([]),
    webUsage: z.array(withUuid(webUsageItem)).max(5000).default([]),
    screenshots: z.array(screenshotItem).max(MAX).default([]),
  }),
});

const res = (type, item, status, extra = {}) => ({ type, clientUuid: item.clientUuid ?? null, status, ...extra });

/** Existing non-deleted entries of the member overlapping [start, end). */
export async function overlappingEntries(memberId, start, end, excludeId = null) {
  return db.many(
    `SELECT * FROM time_entries WHERE member_id = $1 AND deleted_at IS NULL AND ($4::uuid IS NULL OR id <> $4)
       AND tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz), '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
     ORDER BY started_at`,
    [memberId, start, end, excludeId],
  );
}

/** Insert an offline (desktop) completed entry. */
export async function insertOfflineEntry(ic, item, { createdBy } = {}) {
  const ref = await resolveProjectTask(ic.orgId, ic.memberId, { projectId: item.projectId ?? undefined, taskId: item.taskId ?? undefined });
  const row = await db.one(
    `INSERT INTO time_entries (organization_id, member_id, project_id, task_id, client_id, device_id, client_uuid, started_at, ended_at,
       entry_type, source, is_offline, is_billable, note, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'desktop',true,$11,$12,'completed',$13) RETURNING id`,
    [ic.orgId, ic.memberId, ref.projectId, ref.taskId, ref.clientId, ic.deviceId, item.clientUuid, item.startedAt, item.endedAt,
      item.entryType ?? 'work', item.isBillable ?? ref.isBillableDefault, item.note ?? null, createdBy ?? ic.memberId],
  );
  await finalizeEntry(row.id);
  await writeHistory(ic.orgId, row.id, createdBy ?? ic.memberId, 'create', null, { startedAt: item.startedAt, endedAt: item.endedAt, offline: true }, 'Offline sync');
  const entry = await getEntry(row.id, ic.orgId);
  await publish('time_entry.created', { orgId: ic.orgId, memberId: ic.memberId, entry: entryDto(entry) });
  return entry;
}

async function syncTimeEntry(ic, item) {
  const err = checkRange(item.startedAt, item.endedAt);
  if (err) return res('timeEntries', item, 'error', { message: err });
  const dup = await db.one('SELECT id FROM time_entries WHERE device_id = $1 AND client_uuid = $2', [ic.deviceId, item.clientUuid]);
  if (dup) return res('timeEntries', item, 'duplicate', { id: dup.id });
  const prior = await db.one(
    `SELECT id FROM sync_conflicts WHERE device_id = $1 AND entity_type = 'time_entry' AND payload->>'clientUuid' = $2`,
    [ic.deviceId, item.clientUuid],
  );
  if (prior) return res('timeEntries', item, 'conflict', { conflictId: prior.id, message: 'Overlaps an existing entry (pending review)' });
  const overlaps = await overlappingEntries(ic.memberId, item.startedAt, item.endedAt);
  const recordConflict = async (other) => {
    const c = await db.one(
      `INSERT INTO sync_conflicts (organization_id, device_id, member_id, entity_type, payload, conflicting_entity_id)
       VALUES ($1,$2,$3,'time_entry',$4,$5) RETURNING id`,
      [ic.orgId, ic.deviceId, ic.memberId, db.json({ ...item, deviceId: ic.deviceId }), other?.id ?? null],
    );
    return res('timeEntries', item, 'conflict', { conflictId: c.id, conflictingEntryId: other?.id ?? null, message: 'Overlaps an existing entry; sent for review' });
  };
  if (overlaps.length) return recordConflict(overlaps[0]);
  try {
    const entry = await insertOfflineEntry(ic, item);
    return res('timeEntries', item, 'ok', { id: entry.id });
  } catch (e) {
    if (e?.code === '23P01') return recordConflict((await overlappingEntries(ic.memberId, item.startedAt, item.endedAt))[0]);
    throw e;
  }
}

async function syncPause(ic, item) {
  const err = checkRange(item.startedAt, item.endedAt);
  if (err) return res('pauses', item, 'error', { message: err });
  const entry = await db.one('SELECT * FROM time_entries WHERE device_id = $1 AND client_uuid = $2 AND deleted_at IS NULL', [ic.deviceId, item.timeEntryClientUuid]);
  if (!entry) return res('pauses', item, 'error', { message: 'Time entry not found (not synced or in conflict)' });
  if (entry.status === 'approved' || entry.invoice_id) return res('pauses', item, 'error', { message: 'Time entry is locked' });
  if (!entry.ended_at || new Date(item.startedAt) < new Date(entry.started_at) || new Date(item.endedAt) > new Date(entry.ended_at))
    return res('pauses', item, 'error', { message: 'Pause is outside the time entry' });
  const dup = await db.one('SELECT id FROM time_entry_pauses WHERE time_entry_id = $1 AND started_at = $2', [entry.id, item.startedAt]);
  if (dup) return res('pauses', item, 'duplicate', { id: dup.id });
  const p = await db.one(
    `INSERT INTO time_entry_pauses (time_entry_id, started_at, ended_at, reason) VALUES ($1,$2,$3,$4)
     RETURNING id, extract(epoch FROM (ended_at - started_at))::int AS secs`,
    [entry.id, item.startedAt, item.endedAt, item.reason],
  );
  await db.query('UPDATE time_entries SET paused_seconds = least(paused_seconds + $2, greatest(extract(epoch FROM (ended_at - started_at))::int, 0)) WHERE id = $1', [entry.id, p.secs]);
  await finalizeEntry(entry.id);
  return res('pauses', item, 'ok', { id: p.id, timeEntryId: entry.id });
}

async function syncBreak(ic, item) {
  const err = checkRange(item.startedAt, item.endedAt);
  if (err) return res('breaks', item, 'error', { message: err });
  const dup = await db.one('SELECT id FROM breaks WHERE device_id = $1 AND client_uuid = $2', [ic.deviceId, item.clientUuid]);
  if (dup) return res('breaks', item, 'duplicate', { id: dup.id });
  const type = item.breakTypeId
    ? await db.one('SELECT * FROM break_types WHERE id = $1 AND organization_id = $2', [item.breakTypeId, ic.orgId])
    : await db.one('SELECT * FROM break_types WHERE organization_id = $1 AND archived_at IS NULL ORDER BY is_system DESC, created_at LIMIT 1', [ic.orgId]);
  if (!type) return res('breaks', item, 'error', { message: 'Break type not found' });
  const secs = Math.max(0, Math.round((new Date(item.endedAt) - new Date(item.startedAt)) / 1000));
  const entry = await findEntryAt(ic.memberId, item.startedAt);
  const row = await db.one(
    `INSERT INTO breaks (organization_id, member_id, break_type_id, time_entry_id, device_id, client_uuid, started_at, ended_at, duration_seconds, is_paid, exceeded)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (device_id, client_uuid) WHERE client_uuid IS NOT NULL DO NOTHING RETURNING id`,
    [ic.orgId, ic.memberId, type.id, entry?.id ?? null, ic.deviceId, item.clientUuid, item.startedAt, item.endedAt, secs, type.is_paid,
      !!(type.max_minutes && secs > type.max_minutes * 60)],
  );
  if (!row) return res('breaks', item, 'duplicate');
  return res('breaks', item, 'ok', { id: row.id });
}

/** Process one validated sync batch. `rawItemsJson` is JSON.stringify of the items as sent. */
export async function processSyncBatch(ic, body, rawItemsJson) {
  const { createHash } = await import('node:crypto');
  const actual = createHash('sha256').update(rawItemsJson ?? '').digest('hex');
  if (actual !== body.checksum.toLowerCase())
    throw new AppError(400, 'CHECKSUM_MISMATCH', 'Payload checksum does not match', { expected: actual });

  const stored = await db.one('SELECT * FROM sync_batches WHERE device_id = $1 AND batch_uuid = $2', [ic.deviceId, body.batchUuid]);
  if (stored) return { batchUuid: body.batchUuid, replayed: true, results: stored.results ?? [], summary: summarize(stored.results ?? []), receivedAt: stored.received_at };

  const it = body.items;
  const results = [];
  const guard = async (type, item, fn) => {
    try {
      results.push(await fn());
    } catch (e) {
      if (!(e instanceof AppError) && !e?.code) throw e;
      results.push(res(type, item, 'error', { message: e.message, code: e.code }));
    }
  };
  for (const item of it.timeEntries) await guard('timeEntries', item, () => syncTimeEntry(ic, item));
  for (const item of it.pauses) await guard('pauses', item, () => syncPause(ic, item));
  if (it.idlePeriods.length) results.push(...(await ingestIdle(ic, it.idlePeriods, { live: false })));
  for (const item of it.breaks) await guard('breaks', item, () => syncBreak(ic, item));
  const settings = it.activity.length || it.appUsage.length || it.webUsage.length ? await memberSettings(ic.orgId, ic.memberId) : null;
  if (it.activity.length) results.push(...(await ingestActivity(ic, it.activity, { settings })));
  if (it.appUsage.length) results.push(...(await ingestAppUsage(ic, it.appUsage, { settings })));
  if (it.webUsage.length) results.push(...(await ingestWebUsage(ic, it.webUsage, { settings })));
  if (it.screenshots.length) results.push(...(await ingestScreenshots(ic, it.screenshots)));

  // Summaries for every synced entry/break range.
  const times = [...it.timeEntries, ...it.breaks].flatMap((x) => [new Date(x.startedAt), new Date(x.endedAt)]).filter((d) => !Number.isNaN(d.getTime()));
  if (times.length) {
    const min = new Date(Math.max(Math.min(...times), Date.now() - 31 * 86400_000));
    const max = new Date(Math.min(Math.max(...times), Date.now() + 300_000));
    if (min <= max) await recomputeRange(ic.memberId, min, max);
  }

  const counts = Object.fromEntries(Object.entries(it).map(([k, v]) => [k, v.length]));
  const row = await db.one(
    `INSERT INTO sync_batches (organization_id, device_id, member_id, batch_uuid, item_counts, results, checksum)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (device_id, batch_uuid) DO NOTHING RETURNING received_at`,
    [ic.orgId, ic.deviceId, ic.memberId, body.batchUuid, db.json(counts), db.json(results), body.checksum.toLowerCase()],
  );
  await db.query('UPDATE devices SET last_sync_at = now(), pending_count = coalesce($2, pending_count) WHERE id = $1', [ic.deviceId, body.pendingCount ?? null]);
  return { batchUuid: body.batchUuid, replayed: false, results, summary: summarize(results), receivedAt: row?.received_at ?? new Date() };
}

export function conflictDto(c) {
  return {
    id: c.id,
    memberId: c.member_id,
    member: c.first_name !== undefined ? { id: c.member_id, firstName: c.first_name, lastName: c.last_name } : undefined,
    deviceId: c.device_id,
    entityType: c.entity_type,
    payload: c.payload,
    conflictingEntityId: c.conflicting_entity_id,
    conflictingEntry: c.conflicting_started_at
      ? { id: c.conflicting_entity_id, startedAt: c.conflicting_started_at, endedAt: c.conflicting_ended_at, status: c.conflicting_status }
      : null,
    status: c.status,
    resolution: c.resolution,
    resolvedBy: c.resolved_by,
    resolvedAt: c.resolved_at,
    createdAt: c.created_at,
  };
}

export { memberSettings };
