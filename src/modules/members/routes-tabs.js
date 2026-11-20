import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';
import { assertMemberAccess, getOrgMember } from '../../rbac/scope.js';
import { resolveRange, summariesByMember, metrics, realDate } from '../teams/service.js';

/** Member profile tabs (EMP-17…EMP-20, ATT-19). Mounted under /members. */
const r = createRouter('/members', 'Members');

const tabOpts = (summary, ids, permission) => ({
  summary,
  ids,
  permission,
  params: z.object({ id: z.uuid() }),
  query: z.object({ from: realDate.optional(), to: realDate.optional() }),
});

async function prepare(req, perm) {
  const m = await getOrgMember(req.ctx.orgId, req.v.params.id);
  await assertMemberAccess(req.ctx, perm, m.id);
  const tz = m.timezone || req.ctx.orgTimezone || 'UTC';
  return { m, tz, range: resolveRange(req.v.query, tz) };
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));

// ─── EMP-17 activity history ────────────────────────────────────────────────
r.get('/:id/activity', tabOpts('Employee activity history (daily + hourly activity levels)', 'EMP-17', 'activity.view'), async (req, res) => {
  const { m, tz, range } = await prepare(req, 'activity.view');
  const daily = await db.many(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, tracked_seconds, active_seconds, idle_seconds, break_seconds, productive_seconds,
            unproductive_seconds, neutral_seconds, billable_seconds, overtime_seconds, screenshot_count
     FROM daily_summaries WHERE member_id = $1 AND organization_id = $2 AND date BETWEEN $3::date AND $4::date ORDER BY date`,
    [m.id, req.ctx.orgId, range.from, range.to],
  );
  const hourly = await db.many(
    `SELECT extract(hour FROM interval_start AT TIME ZONE $3)::int AS hour,
            sum(interval_seconds)::int AS seconds, sum(active_seconds)::int AS active_seconds,
            sum(keyboard_active_seconds)::int AS keyboard_seconds, sum(mouse_active_seconds)::int AS mouse_seconds
     FROM activity_samples
     WHERE member_id = $1 AND organization_id = $2
       AND interval_start >= ($4::date::timestamp AT TIME ZONE $3) AND interval_start < (($5::date + 1)::timestamp AT TIME ZONE $3)
     GROUP BY 1 ORDER BY 1`,
    [m.id, req.ctx.orgId, tz, range.from, range.to],
  );
  const totals = daily.reduce((a, d) => {
    for (const k of Object.keys(d)) if (k !== 'date') a[k] = (a[k] ?? 0) + num(d[k]);
    return a;
  }, {});
  ok(res, {
    memberId: m.id,
    from: range.from,
    to: range.to,
    timezone: tz,
    totals: metrics(totals),
    daily: daily.map((d) => ({ date: d.date, ...metrics(d) })),
    hourly: hourly.map((h) => ({
      hour: h.hour,
      seconds: h.seconds,
      activeSeconds: h.active_seconds,
      keyboardSeconds: h.keyboard_seconds,
      mouseSeconds: h.mouse_seconds,
      activityPercent: h.seconds ? Math.round((h.active_seconds / h.seconds) * 100) : 0,
    })),
  });
});

// ─── EMP-18 working history ─────────────────────────────────────────────────
r.get('/:id/work-history', tabOpts('Employee working history (entries + attendance by day)', 'EMP-18', 'time.view'), async (req, res) => {
  const { m, tz, range } = await prepare(req, 'time.view');
  const entries = await db.many(
    `SELECT e.id, e.started_at, e.ended_at, e.duration_seconds, e.active_seconds, e.idle_seconds, e.status, e.source, e.entry_type,
            e.is_billable, e.note, e.project_id, p.name AS project_name, e.task_id, t.title AS task_title,
            to_char((e.started_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS local_date
     FROM time_entries e LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN tasks t ON t.id = e.task_id
     WHERE e.member_id = $1 AND e.organization_id = $2 AND e.deleted_at IS NULL
       AND e.started_at >= ($4::date::timestamp AT TIME ZONE $3) AND e.started_at < (($5::date + 1)::timestamp AT TIME ZONE $3)
     ORDER BY e.started_at`,
    [m.id, req.ctx.orgId, tz, range.from, range.to],
  );
  const summaries = await db.many(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, tracked_seconds, active_seconds, idle_seconds, break_seconds, billable_seconds, overtime_seconds,
            productive_seconds, unproductive_seconds, neutral_seconds
     FROM daily_summaries WHERE member_id = $1 AND date BETWEEN $2::date AND $3::date`,
    [m.id, range.from, range.to],
  );
  const attendance = await db.many(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, status, check_in_at, check_out_at, late_minutes, early_leave_minutes, work_mode
     FROM attendance_records WHERE member_id = $1 AND date BETWEEN $2::date AND $3::date`,
    [m.id, range.from, range.to],
  );
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { date, summary: metrics({}), attendance: null, entries: [] });
    return days.get(date);
  };
  for (const s of summaries) day(s.date).summary = metrics(s);
  for (const a of attendance)
    day(a.date).attendance = { status: a.status, checkInAt: a.check_in_at, checkOutAt: a.check_out_at, lateMinutes: a.late_minutes, earlyLeaveMinutes: a.early_leave_minutes, workMode: a.work_mode };
  for (const e of entries)
    day(e.local_date).entries.push({
      id: e.id,
      startedAt: e.started_at,
      endedAt: e.ended_at,
      durationSeconds: e.duration_seconds,
      activeSeconds: e.active_seconds,
      idleSeconds: e.idle_seconds,
      status: e.status,
      source: e.source,
      entryType: e.entry_type,
      isBillable: e.is_billable,
      note: e.note,
      project: e.project_id ? { id: e.project_id, name: e.project_name } : null,
      task: e.task_id ? { id: e.task_id, title: e.task_title } : null,
    });
  const list = [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  const totalTracked = list.reduce((a, d) => a + d.summary.trackedSeconds, 0);
  ok(res, { memberId: m.id, from: range.from, to: range.to, timezone: tz, totalTrackedSeconds: totalTracked, days: list });
});

// ─── EMP-19 devices ─────────────────────────────────────────────────────────
r.get('/:id/devices', { summary: 'Employee device information (OS, app version, last seen, sync status)', ids: 'EMP-19', permission: 'members.view', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const m = await getOrgMember(req.ctx.orgId, req.v.params.id);
  await assertMemberAccess(req.ctx, 'members.view', m.id);
  const rows = await db.many(
    `SELECT d.*, EXISTS (SELECT 1 FROM device_tokens t WHERE t.device_id = d.id AND t.revoked_at IS NULL AND t.expires_at > now()) AS has_token
     FROM devices d WHERE d.member_id = $1 AND d.organization_id = $2 ORDER BY d.last_seen_at DESC NULLS LAST`,
    [m.id, req.ctx.orgId],
  );
  ok(
    res,
    rows.map((d) => ({
      id: d.id,
      kind: d.kind,
      os: d.os,
      osVersion: d.os_version,
      appVersion: d.app_version,
      hostname: d.hostname,
      status: d.status,
      online: d.online,
      lastSeenAt: d.last_seen_at,
      lastSyncAt: d.last_sync_at,
      pendingCount: d.pending_count,
      syncStatus: d.status !== 'active' ? 'revoked' : d.pending_count > 0 ? 'pending' : 'synced',
      signedIn: d.has_token,
      createdAt: d.created_at,
    })),
  );
});

// ─── EMP-20 performance overview ────────────────────────────────────────────
r.get('/:id/performance', tabOpts('Employee performance overview', 'EMP-20, PERF-01', 'performance.view'), async (req, res) => {
  const { m, range } = await prepare(req, 'performance.view');
  const [sum] = await summariesByMember(req.ctx.orgId, [m.id], range.from, range.to);
  const met = metrics(sum ?? {});
  const tasks = await db.one(
    `SELECT count(*) FILTER (WHERE t.completed_at IS NOT NULL AND (t.completed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date)::int AS completed,
            count(*) FILTER (WHERE t.completed_at IS NOT NULL AND t.due_date IS NOT NULL AND (t.completed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
                             AND (t.completed_at AT TIME ZONE $4)::date <= t.due_date)::int AS on_time,
            count(*) FILTER (WHERE t.completed_at IS NULL AND t.due_date < (now() AT TIME ZONE $4)::date)::int AS overdue,
            count(*) FILTER (WHERE t.completed_at IS NULL)::int AS open
     FROM tasks t JOIN task_assignees a ON a.task_id = t.id
     WHERE a.member_id = $1 AND t.deleted_at IS NULL`,
    [m.id, range.from, range.to, req.ctx.orgTimezone ?? 'UTC'],
  );
  const att = await db.one(
    `SELECT count(*) FILTER (WHERE status IN ('present','late','half_day'))::int AS present,
            count(*) FILTER (WHERE status = 'late')::int AS late, count(*) FILTER (WHERE status = 'absent')::int AS absent,
            coalesce(sum(overtime_seconds),0)::int AS overtime_seconds
     FROM attendance_records WHERE member_id = $1 AND date BETWEEN $2::date AND $3::date`,
    [m.id, range.from, range.to],
  );
  const settings = await db.one('SELECT productivity_weights FROM organization_settings WHERE organization_id = $1', [req.ctx.orgId]);
  const wts = settings?.productivity_weights ?? { activity: 0.4, productive: 0.4, tasks: 0.2 };
  const taskRate = tasks.completed + tasks.overdue > 0 ? Math.round((tasks.completed / (tasks.completed + tasks.overdue)) * 100) : met.trackedSeconds ? 100 : 0;
  const wsum = num(wts.activity) + num(wts.productive) + num(wts.tasks) || 1;
  const score = Math.round((met.activityPercent * num(wts.activity) + met.productivityPercent * num(wts.productive) + taskRate * num(wts.tasks)) / wsum);
  const weekly = await db.many(
    `SELECT to_char(date_trunc('week', date), 'YYYY-MM-DD') AS week, sum(tracked_seconds)::int AS tracked_seconds, sum(active_seconds)::int AS active_seconds,
            sum(productive_seconds)::int AS productive_seconds, sum(unproductive_seconds)::int AS unproductive_seconds, sum(neutral_seconds)::int AS neutral_seconds
     FROM daily_summaries WHERE member_id = $1 AND date BETWEEN $2::date AND $3::date GROUP BY 1 ORDER BY 1`,
    [m.id, range.from, range.to],
  );
  ok(res, {
    memberId: m.id,
    from: range.from,
    to: range.to,
    score,
    weights: wts,
    ...met,
    tasks: { completed: tasks.completed, completedOnTime: tasks.on_time, overdue: tasks.overdue, open: tasks.open, completionRate: taskRate },
    attendance: { presentDays: att.present, lateDays: att.late, absentDays: att.absent, overtimeSeconds: att.overtime_seconds },
    trend: weekly.map((w) => ({ week: w.week, ...metrics(w) })),
  });
});

// ─── ATT-19 attendance history ──────────────────────────────────────────────
r.get('/:id/attendance', tabOpts('Employee attendance history', 'ATT-19', 'attendance.view'), async (req, res) => {
  const { m, range } = await prepare(req, 'attendance.view');
  const rows = await db.many(
    `SELECT a.*, to_char(a.date,'YYYY-MM-DD') AS d, s.name AS shift_name FROM attendance_records a LEFT JOIN shifts s ON s.id = a.shift_id
     WHERE a.member_id = $1 AND a.organization_id = $2 AND a.date BETWEEN $3::date AND $4::date ORDER BY a.date DESC`,
    [m.id, req.ctx.orgId, range.from, range.to],
  );
  const summary = { present: 0, late: 0, absent: 0, halfDay: 0, holiday: 0, weekend: 0, leave: 0, workedSeconds: 0, overtimeSeconds: 0, lateMinutes: 0 };
  const key = { present: 'present', late: 'late', absent: 'absent', half_day: 'halfDay', holiday: 'holiday', weekend: 'weekend', leave: 'leave' };
  for (const a of rows) {
    summary[key[a.status]]++;
    summary.workedSeconds += a.worked_seconds;
    summary.overtimeSeconds += a.overtime_seconds;
    summary.lateMinutes += a.late_minutes;
  }
  ok(res, {
    memberId: m.id,
    from: range.from,
    to: range.to,
    summary,
    records: rows.map((a) => ({
      id: a.id,
      date: a.d,
      status: a.status,
      checkInAt: a.check_in_at,
      checkOutAt: a.check_out_at,
      checkInSource: a.check_in_source,
      lateMinutes: a.late_minutes,
      earlyLeaveMinutes: a.early_leave_minutes,
      workedSeconds: a.worked_seconds,
      overtimeSeconds: a.overtime_seconds,
      workMode: a.work_mode,
      shift: a.shift_id ? { id: a.shift_id, name: a.shift_name } : null,
      note: a.note,
    })),
  });
});

export default r;
