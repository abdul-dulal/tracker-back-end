import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, dateStr, pageMeta } from '../../lib/http.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { signedGetUrl } from '../../lib/storage.js';

/** PRIV-03: employees can view their own tracked data. */
const r = createRouter('/me', 'Privacy');

const TYPES = {
  time: {
    col: 'te.started_at',
    sql: `SELECT te.id, te.started_at, te.ended_at, te.duration_seconds, te.status, te.source, te.is_billable, te.note,
            te.project_id, p.name AS project_name, te.task_id, t.title AS task_title
          FROM time_entries te LEFT JOIN projects p ON p.id = te.project_id LEFT JOIN tasks t ON t.id = te.task_id
          WHERE te.member_id = $1 AND te.deleted_at IS NULL`,
    dto: (x) => ({
      id: x.id,
      startedAt: x.started_at,
      endedAt: x.ended_at,
      durationSeconds: x.duration_seconds,
      status: x.status,
      source: x.source,
      isBillable: x.is_billable,
      note: x.note,
      project: x.project_id ? { id: x.project_id, name: x.project_name } : null,
      task: x.task_id ? { id: x.task_id, title: x.task_title } : null,
    }),
  },
  activity: {
    col: 'a.interval_start',
    sql: `SELECT a.interval_start, a.interval_seconds, a.keyboard_active_seconds, a.mouse_active_seconds, a.active_seconds, a.activity_percent
          FROM activity_samples a WHERE a.member_id = $1`,
    dto: (x) => ({
      intervalStart: x.interval_start,
      intervalSeconds: x.interval_seconds,
      keyboardActiveSeconds: x.keyboard_active_seconds,
      mouseActiveSeconds: x.mouse_active_seconds,
      activeSeconds: x.active_seconds,
      activityPercent: x.activity_percent,
    }),
  },
  screenshots: {
    col: 's.captured_at',
    sql: `SELECT s.id, s.captured_at, s.activity_percent, s.app_name, s.window_title, s.object_key, s.thumb_key, s.blurred_key, s.is_blurred
          FROM screenshots s WHERE s.member_id = $1 AND s.deleted_at IS NULL`,
    dto: (x) => ({
      id: x.id,
      capturedAt: x.captured_at,
      activityPercent: x.activity_percent,
      appName: x.app_name,
      windowTitle: x.window_title,
      isBlurred: x.is_blurred,
      thumbUrl: signedGetUrl(x.thumb_key ?? (x.is_blurred ? x.blurred_key : x.object_key)),
      url: signedGetUrl(x.is_blurred && x.blurred_key ? x.blurred_key : x.object_key),
    }),
  },
  apps: {
    col: 'u.started_at',
    sql: `SELECT u.app_identifier, u.app_name, u.window_title, u.started_at, u.ended_at, u.duration_seconds FROM app_usage u WHERE u.member_id = $1`,
    dto: (x) => ({ appIdentifier: x.app_identifier, appName: x.app_name, windowTitle: x.window_title, startedAt: x.started_at, endedAt: x.ended_at, durationSeconds: x.duration_seconds }),
  },
  websites: {
    col: 'w.started_at',
    sql: `SELECT w.browser, w.domain, w.url, w.title, w.started_at, w.ended_at, w.duration_seconds FROM web_usage w WHERE w.member_id = $1 AND NOT w.is_excluded`,
    dto: (x) => ({ browser: x.browser, domain: x.domain, url: x.url, title: x.title, startedAt: x.started_at, endedAt: x.ended_at, durationSeconds: x.duration_seconds }),
  },
  attendance: {
    col: 'ar.date',
    date: true,
    sql: `SELECT ar.date, ar.status, ar.check_in_at, ar.check_out_at, ar.late_minutes, ar.early_leave_minutes, ar.worked_seconds, ar.overtime_seconds, ar.work_mode
          FROM attendance_records ar WHERE ar.member_id = $1`,
    dto: (x) => ({
      date: x.date,
      status: x.status,
      checkInAt: x.check_in_at,
      checkOutAt: x.check_out_at,
      lateMinutes: x.late_minutes,
      earlyLeaveMinutes: x.early_leave_minutes,
      workedSeconds: x.worked_seconds,
      overtimeSeconds: x.overtime_seconds,
      workMode: x.work_mode,
    }),
  },
};

r.get(
  '/data',
  {
    summary: 'My own tracked data (time, activity, screenshots, apps, websites, attendance)',
    ids: 'PRIV-03',
    query: z.object({
      type: z.enum(Object.keys(TYPES)).default('time'),
      from: dateStr.optional(),
      to: dateStr.optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    if (!ctx.memberId || ctx.authType === 'api_key') throw forbidden('Only members can view their own data');
    const q = req.v.query;
    const today = new Date().toISOString().slice(0, 10);
    const to = q.to ?? today;
    const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw badRequest('from must be before to', undefined, 'INVALID_RANGE');
    if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw badRequest('Range cannot exceed one year', undefined, 'RANGE_TOO_LARGE');
    const t = TYPES[q.type];
    const range = t.date
      ? `AND ${t.col} BETWEEN $2::date AND $3::date`
      : `AND ${t.col} >= ($2::date::timestamp AT TIME ZONE $4) AND ${t.col} < (($3::date + 1)::timestamp AT TIME ZONE $4)`;
    const params = t.date ? [ctx.memberId, from, to] : [ctx.memberId, from, to, ctx.timezone ?? 'UTC'];
    const base = `${t.sql} ${range}`;
    const total = (await db.one(`SELECT count(*)::int AS n FROM (${base}) x`, params)).n;
    const rows = await db.many(`${base} ORDER BY ${t.col} DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, params);
    ok(res, rows.map(t.dto), { ...pageMeta(q, total), type: q.type, from, to });
  },
);

export default r;
