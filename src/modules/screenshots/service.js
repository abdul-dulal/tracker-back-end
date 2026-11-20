import { db } from '../../lib/db.js';
import { signedGetUrl, deleteObject } from '../../lib/storage.js';
import { where } from '../../lib/http.js';
import { activityLevel, getThresholds, visibleMemberIds } from '../activity/service.js';

/**
 * Screenshot helpers shared by the gallery, live view, exports and jobs (guide §M06).
 * Blur rule (SS-16): when `is_blurred` is set, anyone other than the screenshot's own member only
 * ever receives the blurred variants — never the original object (null until the worker made them).
 */
export const SHOT_SELECT = `
  SELECT s.*, u.first_name, u.last_name, p.name AS project_name, t.title AS task_title
  FROM screenshots s
  JOIN organization_members m ON m.id = s.member_id
  JOIN users u ON u.id = m.user_id
  LEFT JOIN projects p ON p.id = s.project_id
  LEFT JOIN tasks t ON t.id = s.task_id`;

/** Blurred thumbnail key derived from the blurred key (no extra column needed). */
export function blurredThumbKey(blurredKey) {
  if (!blurredKey) return null;
  return blurredKey.replace(/(\.[a-z0-9]+)?$/i, '_thumb.webp');
}

/** Which object keys may this viewer receive for a screenshot? */
export function visibleKeys(row, viewerMemberId) {
  const blurredForViewer = row.is_blurred && row.member_id !== viewerMemberId;
  if (blurredForViewer) {
    return { full: row.blurred_key ?? null, thumb: row.blurred_key ? blurredThumbKey(row.blurred_key) : null, blurred: true };
  }
  return { full: row.object_key, thumb: row.thumb_key ?? null, blurred: false };
}

export function screenshotDto(row, viewerMemberId, th) {
  const k = visibleKeys(row, viewerMemberId);
  return {
    id: row.id,
    memberId: row.member_id,
    member: row.first_name !== undefined ? { id: row.member_id, firstName: row.first_name, lastName: row.last_name } : undefined,
    timeEntryId: row.time_entry_id,
    project: row.project_id ? { id: row.project_id, name: row.project_name } : null,
    task: row.task_id ? { id: row.task_id, title: row.task_title } : null,
    deviceId: row.device_id,
    captureGroupId: row.capture_group_id,
    monitorIndex: row.monitor_index,
    capturedAt: row.captured_at,
    receivedAt: row.received_at,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    activityPercent: row.activity_percent,
    activityLevel: th ? activityLevel(row.activity_percent, th) : undefined,
    appName: row.app_name,
    windowTitle: row.window_title,
    isBlurred: row.is_blurred,
    blurredForViewer: k.blurred,
    processing: !row.thumb_key,
    url: signedGetUrl(k.full),
    thumbUrl: signedGetUrl(k.thumb ?? (k.blurred ? null : k.full)),
  };
}

/** Delete every stored object of a screenshot (original, thumb, blurred, blurred thumb). */
export async function deleteScreenshotObjects(row) {
  for (const key of [row.object_key, row.thumb_key, row.blurred_key, blurredThumbKey(row.blurred_key)]) {
    if (key) await deleteObject(key);
  }
}

export async function bumpScreenshotCounter(orgId, delta) {
  await db.query(
    `INSERT INTO usage_counters (organization_id, metric, value) VALUES ($1, 'screenshots', greatest($2::bigint, 0))
     ON CONFLICT (organization_id, metric) DO UPDATE SET value = greatest(usage_counters.value + $2::bigint, 0), updated_at = now()`,
    [orgId, delta],
  );
}

/** Build the WHERE clause for screenshot filters within the viewer's scope (SS-23, SS-26, SS-P3). */
export async function screenshotFilter(ctx, f, { perm = 'screenshots.view', memberIds } = {}) {
  const w = where([ctx.orgId]);
  w.raw('s.organization_id = $1 AND s.deleted_at IS NULL');
  const ids = memberIds !== undefined ? memberIds : await visibleMemberIds(ctx, perm);
  if (ids) w.add('s.member_id = ANY(?::uuid[])', ids);
  w.add('s.member_id = ?', f.memberId);
  w.add('s.project_id = ?', f.projectId);
  w.add('s.task_id = ?', f.taskId);
  if (f.teamId) w.add('s.member_id IN (SELECT member_id FROM team_members WHERE team_id = ?)', f.teamId);
  const tz = ctx.timezone ?? 'UTC';
  if (f.from) w.add('s.captured_at >= (?::date::timestamp AT TIME ZONE ?)', f.from, tz);
  if (f.to) w.add('s.captured_at < ((?::date + 1)::timestamp AT TIME ZONE ?)', f.to, tz);
  if (f.activityLevel) {
    const th = await getThresholds(ctx.orgId);
    if (f.activityLevel === 'low') w.add('coalesce(s.activity_percent, 0) <= ?', th.lowMax);
    if (f.activityLevel === 'moderate') w.add('s.activity_percent > ? AND s.activity_percent <= ?', th.lowMax, th.moderateMax);
    if (f.activityLevel === 'high') w.add('s.activity_percent > ?', th.moderateMax);
  }
  return w;
}

