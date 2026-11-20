import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';
import { entryDto, ENTRY_SELECT } from '../time/timer-service.js';
import { getThresholds, activityLevel, pct, visibleMemberIds, ACTIVITY_NOTE } from '../activity/service.js';
import { screenshotDto } from '../screenshots/service.js';

/**
 * Live monitoring (ADM-06…09). Status per member:
 *   on_break  → open break
 *   idle      → running entry paused for idle
 *   tracking  → running entry (not paused)
 *   online    → heartbeat (member or device) within the last 2 minutes
 *   offline   → otherwise
 * Real-time updates are pushed to the socket room org:{id}:live (presence.updated, timer.*, screenshot.captured, idle.detected).
 */
const r = createRouter('/live', 'Live monitoring');

const PERM = 'activity.view';
const ONLINE_MS = 2 * 60_000;

async function liveMembers(ctx, { teamId } = {}) {
  const visible = await visibleMemberIds(ctx, PERM);
  const members = await db.many(
    `SELECT m.id, m.user_id, m.last_seen_at, m.designation, u.first_name, u.last_name, u.avatar_key, u.email,
            (SELECT max(d.last_seen_at) FROM devices d WHERE d.member_id = m.id AND d.status = 'active' AND d.online) AS device_seen_at,
            (SELECT row_to_json(x) FROM (SELECT d.id, d.os, d.app_version, d.hostname FROM devices d WHERE d.member_id = m.id AND d.status = 'active'
               ORDER BY d.last_seen_at DESC NULLS LAST LIMIT 1) x) AS device
     FROM organization_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
     WHERE m.organization_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL AND r.base_role <> 'client'
       AND ($2::uuid[] IS NULL OR m.id = ANY($2::uuid[]))
       AND ($3::uuid IS NULL OR m.id IN (SELECT member_id FROM team_members WHERE team_id = $3))
     ORDER BY lower(u.first_name), lower(u.last_name)`,
    [ctx.orgId, visible, teamId ?? null],
  );
  if (!members.length) return [];
  const ids = members.map((m) => m.id);
  const entries = await db.many(`${ENTRY_SELECT} WHERE e.member_id = ANY($1::uuid[]) AND e.ended_at IS NULL AND e.deleted_at IS NULL`, [ids]);
  const breaks = await db.many(
    `SELECT b.member_id, b.started_at, bt.name FROM breaks b JOIN break_types bt ON bt.id = b.break_type_id WHERE b.member_id = ANY($1::uuid[]) AND b.ended_at IS NULL`,
    [ids],
  );
  const acts = await db.many(
    `SELECT member_id, sum(active_seconds)::int AS active, sum(interval_seconds)::int AS total FROM activity_samples
     WHERE member_id = ANY($1::uuid[]) AND interval_start >= now() - interval '10 minutes' GROUP BY member_id`,
    [ids],
  );
  const shots = await db.many(
    `SELECT DISTINCT ON (s.member_id) s.*, p.name AS project_name, t.title AS task_title FROM screenshots s
     LEFT JOIN projects p ON p.id = s.project_id LEFT JOIN tasks t ON t.id = s.task_id
     WHERE s.member_id = ANY($1::uuid[]) AND s.deleted_at IS NULL AND s.captured_at > now() - interval '1 day'
     ORDER BY s.member_id, s.captured_at DESC, s.monitor_index`,
    [ids],
  );
  const th = await getThresholds(ctx.orgId);
  const E = new Map(entries.map((e) => [e.member_id, e]));
  const B = new Map(breaks.map((b) => [b.member_id, b]));
  const A = new Map(acts.map((a) => [a.member_id, a]));
  const S = new Map(shots.map((s) => [s.member_id, s]));
  const now = Date.now();
  return members.map((m) => {
    const e = E.get(m.id);
    const b = B.get(m.id);
    const a = A.get(m.id);
    const s = S.get(m.id);
    const seen = [m.last_seen_at, m.device_seen_at].filter(Boolean).map((d) => new Date(d).getTime());
    const lastSeen = seen.length ? Math.max(...seen) : null;
    let status = 'offline';
    if (b) status = 'on_break';
    else if (e && e.open_pause && e.open_pause.reason === 'idle') status = 'idle';
    else if (e && !e.open_pause) status = 'tracking';
    else if (lastSeen && now - lastSeen < ONLINE_MS) status = 'online';
    const timer = e ? entryDto(e) : null;
    const p = a?.total ? pct(a.active, a.total) : null;
    return {
      memberId: m.id,
      userId: m.user_id,
      firstName: m.first_name,
      lastName: m.last_name,
      email: m.email,
      designation: m.designation,
      avatarKey: m.avatar_key,
      status,
      lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
      device: m.device ? { id: m.device.id, os: m.device.os, appVersion: m.device.app_version, hostname: m.device.hostname } : null,
      project: timer?.project ?? null,
      task: timer?.task ?? null,
      timer: timer ? { entryId: timer.id, startedAt: timer.startedAt, seconds: timer.durationSeconds, paused: !!timer.pause, pauseReason: timer.pause?.reason ?? null, source: timer.source } : null,
      onBreak: b ? { breakType: b.name, startedAt: b.started_at } : null,
      activityPercent10m: p,
      activityLevel: activityLevel(p, th),
      latestScreenshot: s ? (({ id, capturedAt, thumbUrl, isBlurred, blurredForViewer, activityPercent }) => ({ id, capturedAt, thumbUrl, isBlurred, blurredForViewer, activityPercent }))(screenshotDto(s, ctx.memberId, th)) : null,
    };
  });
}

r.get(
  '/members',
  {
    summary: 'Live status of members (tracking / idle / on break / online / offline)',
    ids: 'ADM-06, ADM-07, ADM-08, ADM-09',
    query: z.object({ teamId: z.uuid().optional(), status: z.enum(['online', 'tracking', 'idle', 'on_break', 'offline', 'active']).optional() }),
  },
  async (req, res) => {
    let rows = await liveMembers(req.ctx, req.v.query);
    const st = req.v.query.status;
    if (st === 'active') rows = rows.filter((x) => x.status !== 'offline');
    else if (st) rows = rows.filter((x) => x.status === st);
    ok(res, rows, { total: rows.length, note: ACTIVITY_NOTE, serverTime: new Date().toISOString() });
  },
);

r.get('/summary', { summary: 'Live status counts', ids: 'ADM-07, ADM-08', query: z.object({ teamId: z.uuid().optional() }) }, async (req, res) => {
  const rows = await liveMembers(req.ctx, req.v.query);
  const counts = { tracking: 0, idle: 0, on_break: 0, online: 0, offline: 0 };
  for (const x of rows) counts[x.status]++;
  const withAct = rows.filter((x) => x.activityPercent10m !== null);
  ok(res, {
    total: rows.length,
    active: rows.length - counts.offline,
    counts,
    averageActivityPercent10m: withAct.length ? Math.round(withAct.reduce((s, x) => s + x.activityPercent10m, 0) / withAct.length) : null,
    serverTime: new Date().toISOString(),
    note: ACTIVITY_NOTE,
  });
});

export default r;
