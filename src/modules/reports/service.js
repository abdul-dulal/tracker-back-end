import { z } from 'zod';
import { db } from '../../lib/db.js';
import { dateStr } from '../../lib/http.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { sendMail, layout, escapeHtml } from '../../lib/mailer.js';
import { RANGES, zDims, filtersSchema, memberContext } from './common.js';
import { REPORT_TYPES, GROUP_DIMS, runReport } from './engine.js';
import { renderReport } from './render.js';

/** A report definition as stored in saved_reports / report_shares / sent to /reports/run. */
export const definitionSchema = z.object({
  reportType: z.enum(REPORT_TYPES),
  from: dateStr.optional(),
  to: dateStr.optional(),
  range: z.enum(RANGES).optional(),
  groupBy: zDims.pipe(z.array(z.enum(GROUP_DIMS)).max(3)).optional(),
  metrics: z.array(z.string().max(40)).max(30).optional(),
  filters: filtersSchema.optional(),
  title: z.string().max(150).optional(),
});

export const formatSchema = z.enum(['pdf', 'csv', 'xlsx']);
export const recipientsSchema = z.array(z.email()).min(1).max(50);

export function savedReportDto(r) {
  return {
    id: r.id,
    name: r.name,
    reportType: r.report_type,
    definition: r.definition,
    ownerMemberId: r.owner_member_id,
    isSharedInOrg: r.is_shared_in_org,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Saved report visible to ctx (owner, shared in org, or admin). */
export async function getAccessibleSavedReport(ctx, id) {
  const r = await db.one('SELECT * FROM saved_reports WHERE id = $1 AND organization_id = $2', [id, ctx.orgId]);
  if (!r || !(r.owner_member_id === ctx.memberId || r.is_shared_in_org || ctx.isAdminLike())) throw notFound('Saved report');
  return r;
}

/** Default range for scheduled runs when the definition has no fixed dates. */
const SCHEDULE_RANGE = { daily: 'yesterday', weekly: 'last_week', monthly: 'last_month' };

export function definitionForSchedule(def, frequency) {
  if (def.from && def.to) return def;
  return { ...def, range: def.range ?? SCHEDULE_RANGE[frequency] };
}

/**
 * Next run time strictly after `after` for a schedule
 * {frequency, day_of_week (0=Sun), day_of_month (1–28), time_of_day, timezone}.
 */
export async function computeNextRun(s, after = new Date()) {
  const r = await db.one(
    `SELECT min(ts) AS next FROM (
       SELECT ((d::date + $2::time) AT TIME ZONE $3) AS ts, d::date AS d
       FROM generate_series(($6::timestamptz AT TIME ZONE $3)::date, ($6::timestamptz AT TIME ZONE $3)::date + 62, interval '1 day') d) x
     WHERE ts > $6::timestamptz AND ($1 = 'daily'
       OR ($1 = 'weekly' AND extract(dow FROM d)::int = $4)
       OR ($1 = 'monthly' AND extract(day FROM d)::int = $5))`,
    [s.frequency, s.time_of_day ?? s.timeOfDay ?? '08:00', s.timezone ?? 'UTC', s.day_of_week ?? s.dayOfWeek ?? 1, s.day_of_month ?? s.dayOfMonth ?? 1, after],
  );
  if (!r?.next) throw badRequest('Could not compute the next run time');
  return r.next;
}

async function orgName(orgId) {
  return (await db.one('SELECT name FROM organizations WHERE id = $1', [orgId]))?.name ?? '';
}

/** Run + render a definition. */
export async function buildReportFile(ctx, def, format, title) {
  const report = await runReport(ctx, def);
  const file = await renderReport(report, format, { title: title ?? def.title ?? `${def.reportType} report`, orgName: await orgName(ctx.orgId) });
  return { report, file };
}

/** Generate a report and email it as an attachment (RPT-A15). */
export async function emailReport(ctx, { definition, format, recipients, title }) {
  const name = title ?? definition.title ?? `${definition.reportType} report`;
  const { report, file } = await buildReportFile(ctx, definition, format, name);
  const subject = `${name} (${report.from} – ${report.to})`;
  for (const to of recipients) {
    await sendMail({
      to,
      subject,
      html: layout({
        title: name,
        body: `<p>Your report for <b>${escapeHtml(report.from)} – ${escapeHtml(report.to)}</b> is attached (${escapeHtml(format.toUpperCase())}).</p>`,
      }),
      text: `${name}\n${report.from} – ${report.to}\nThe report is attached.`,
      attachments: [{ filename: file.filename, content: file.buffer, contentType: file.contentType }],
    });
  }
  return { sent: recipients.length, filename: file.filename, from: report.from, to: report.to };
}

/** Process due scheduled reports (cron 'reports.scheduled'). */
export async function runDueSchedules(now = new Date()) {
  const due = await db.many(
    `SELECT s.*, r.definition, r.name, r.report_type, r.owner_member_id
     FROM report_schedules s JOIN saved_reports r ON r.id = s.saved_report_id
     WHERE s.active AND s.next_run_at <= $1 ORDER BY s.next_run_at LIMIT 50`,
    [now],
  );
  const results = [];
  for (const s of due) {
    const next = await computeNextRun(s, now);
    try {
      const ctx = await memberContext(s.created_by ?? s.owner_member_id);
      if (!ctx) {
        await db.query('UPDATE report_schedules SET active = false, next_run_at = $2 WHERE id = $1', [s.id, next]);
        results.push({ id: s.id, status: 'deactivated' });
        continue;
      }
      const def = definitionForSchedule({ ...s.definition, reportType: s.definition.reportType ?? s.report_type }, s.frequency);
      await emailReport(ctx, { definition: def, format: s.format, recipients: s.recipients, title: s.name });
      results.push({ id: s.id, status: 'sent' });
    } catch (err) {
      results.push({ id: s.id, status: 'failed', error: err.message });
    }
    await db.query('UPDATE report_schedules SET last_run_at = $2, next_run_at = $3 WHERE id = $1', [s.id, now, next]);
  }
  return results;
}
