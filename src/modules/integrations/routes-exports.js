import { z } from 'zod';
import { stringify } from 'csv-stringify/sync';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, dateStr } from '../../lib/http.js';
import { notFound, unauthenticated, forbidden } from '../../lib/errors.js';
import { getOrgPlan } from '../subscription/features.js';
import { calendarFeedUrl, verifyCalendarToken } from './providers/exports.js';

/** Calendar feed (INT-19), accounting CSV (INT-18) and payroll CSV (INT-17) exports. */
const r = createRouter('/integrations', 'Integrations');

// ─── Calendar (iCalendar feed) ───────────────────────────────────────────────
r.get('/calendar/feed-url', { summary: 'My personal iCalendar feed URL (tasks due dates + holidays)', ids: 'INT-19', feature: 'integrations' }, async (req, res) => {
  if (!req.ctx.memberId) throw forbidden('A member context is required');
  ok(res, { url: calendarFeedUrl(req.ctx.memberId) });
});

const icsEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d) => String(d).slice(0, 10).replace(/-/g, '');
const nextDay = (d) => {
  const x = new Date(`${String(d).slice(0, 10)}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};
/** Fold lines > 75 octets (RFC 5545 §3.1). */
const fold = (line) => {
  const out = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  out.push(rest);
  return out.join('\r\n');
};

r.get(
  '/calendar/feed.ics',
  { auth: 'public', summary: 'iCalendar feed (token from /integrations/calendar/feed-url)', ids: 'INT-19', query: z.object({ token: z.string().min(10).max(300) }) },
  async (req, res) => {
    const memberId = verifyCalendarToken(req.v.query.token);
    if (!memberId) throw unauthenticated('Invalid calendar token', 'INVALID_TOKEN');
    const m = await db.one(
      `SELECT m.id, m.organization_id, m.department_id, o.name AS org_name FROM organization_members m JOIN organizations o ON o.id = m.organization_id
       WHERE m.id = $1 AND m.status = 'active' AND m.deleted_at IS NULL AND o.status = 'active' AND o.deleted_at IS NULL`,
      [memberId],
    );
    if (!m) throw unauthenticated('Invalid calendar token', 'INVALID_TOKEN');
    const plan = await getOrgPlan(m.organization_id);
    if (!plan.features?.integrations) throw forbidden('Your plan does not include integrations', 'FEATURE_NOT_IN_PLAN');
    const tasks = await db.many(
      `SELECT t.id, t.title, t.description, t.due_date, t.completed_at, p.name AS project_name FROM tasks t
       JOIN task_assignees ta ON ta.task_id = t.id JOIN projects p ON p.id = t.project_id
       WHERE ta.member_id = $1 AND t.organization_id = $2 AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND t.due_date IS NOT NULL
         AND t.due_date >= current_date - 90 ORDER BY t.due_date LIMIT 1000`,
      [m.id, m.organization_id],
    );
    const holidays = await db.many(
      `SELECT id, name, date, recurring_yearly FROM holidays h WHERE h.organization_id = $1 AND (
         h.applies_to = 'org'
         OR (h.applies_to = 'department' AND h.scope_id = $3)
         OR (h.applies_to = 'team' AND h.scope_id IN (SELECT team_id FROM team_members WHERE member_id = $2)))
       ORDER BY date`,
      [m.organization_id, m.id, m.department_id ?? null],
    );
    const stamp = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tracker//Calendar Feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape(`Tracker — ${m.org_name}`)}`];
    for (const t of tasks) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:task-${t.id}@tracker`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(t.due_date)}`,
        `DTEND;VALUE=DATE:${icsDate(nextDay(t.due_date))}`,
        `SUMMARY:${icsEscape(`${t.completed_at ? '✓ ' : ''}Due: ${t.title}`)}`,
        `DESCRIPTION:${icsEscape(`Project: ${t.project_name}${t.description ? `\n${String(t.description).replace(/<[^>]+>/g, '')}` : ''}`)}`,
        'CATEGORIES:Task',
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    }
    for (const h of holidays) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:holiday-${h.id}@tracker`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(h.date)}`,
        `DTEND;VALUE=DATE:${icsDate(nextDay(h.date))}`,
        `SUMMARY:${icsEscape(h.name)}`,
        ...(h.recurring_yearly ? ['RRULE:FREQ=YEARLY'] : []),
        'CATEGORIES:Holiday',
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    }
    lines.push('END:VCALENDAR');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="tracker.ics"');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(`${lines.map(fold).join('\r\n')}\r\n`);
  },
);

// ─── Accounting CSV (QuickBooks / Xero) ───────────────────────────────────────
const sendCsv = (res, filename, rows, opts = {}) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(stringify(rows, { header: true, ...opts }));
};
const money = (v) => (Math.round(Number(v ?? 0) * 100) / 100).toFixed(2);
const usDate = (d) => {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${m}/${day}/${y}`;
};

r.get(
  '/accounting/invoices.csv',
  {
    summary: 'Invoices as a QuickBooks/Xero-compatible CSV',
    ids: 'INT-18',
    permission: 'integrations.manage',
    feature: 'integrations',
    query: z.object({ from: dateStr.optional(), to: dateStr.optional(), format: z.enum(['quickbooks', 'xero']).default('quickbooks') }),
  },
  async (req, res) => {
    const q = req.v.query;
    const integ = await db.one(`SELECT settings FROM integrations WHERE organization_id = $1 AND provider = $2 AND status <> 'disconnected'`, [req.ctx.orgId, q.format]);
    const s = integ?.settings ?? {};
    const rows = await db.many(
      `SELECT i.number, i.issue_date, i.due_date, i.currency, i.status, i.tax_percent, i.tax_amount, i.discount_amount, i.total, i.notes,
              c.name AS client_name, c.email AS client_email, it.description, it.hours, it.rate, it.amount, it.position
       FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN invoice_items it ON it.invoice_id = i.id
       WHERE i.organization_id = $1 AND i.deleted_at IS NULL AND i.status NOT IN ('draft','void')
         AND ($2::date IS NULL OR i.issue_date >= $2::date) AND ($3::date IS NULL OR i.issue_date <= $3::date)
       ORDER BY i.issue_date, i.number, it.position`,
      [req.ctx.orgId, q.from ?? null, q.to ?? null],
    );
    const desc = (x) => x.description ?? `Invoice ${x.number}`;
    if (q.format === 'xero') {
      sendCsv(
        res,
        `xero-invoices-${q.from ?? 'all'}-${q.to ?? 'all'}.csv`,
        rows.map((x) => ({
          '*ContactName': x.client_name,
          EmailAddress: x.client_email ?? '',
          '*InvoiceNumber': x.number,
          '*InvoiceDate': x.issue_date,
          '*DueDate': x.due_date ?? x.issue_date,
          '*Description': desc(x),
          '*Quantity': x.hours !== null && x.hours !== undefined ? Number(x.hours) : 1,
          '*UnitAmount': money(x.rate ?? x.total),
          '*AccountCode': s.incomeAccount ?? '200',
          '*TaxType': s.taxType ?? (Number(x.tax_percent) > 0 ? 'Tax on Sales' : 'Tax Exempt'),
          Discount: '',
          Currency: x.currency,
        })),
      );
      return;
    }
    sendCsv(
      res,
      `quickbooks-invoices-${q.from ?? 'all'}-${q.to ?? 'all'}.csv`,
      rows.map((x) => ({
        InvoiceNo: x.number,
        Customer: x.client_name,
        InvoiceDate: usDate(x.issue_date),
        DueDate: usDate(x.due_date ?? x.issue_date),
        Item: s.incomeAccount ?? 'Services',
        ItemDescription: desc(x),
        ItemQuantity: x.hours !== null && x.hours !== undefined ? Number(x.hours) : 1,
        ItemRate: money(x.rate ?? x.total),
        ItemAmount: money(x.amount ?? x.total),
        ItemTaxAmount: money(0),
        InvoiceTaxAmount: money(x.tax_amount),
        Discount: money(x.discount_amount),
        Currency: x.currency,
        Memo: x.notes ?? '',
      })),
    );
  },
);

// ─── Payroll CSV ─────────────────────────────────────────────────────────────
r.get(
  '/payroll/:runId.csv',
  {
    summary: 'Generic payroll CSV export of a payroll run',
    ids: 'INT-17',
    permission: ['payroll.manage', 'integrations.manage'],
    feature: 'integrations',
    params: z.object({ runId: z.uuid() }),
  },
  async (req, res) => {
    if (req.ctx.can('payroll.manage') !== 'org' && req.ctx.can('integrations.manage') !== 'org') throw forbidden('Organization-wide payroll access required');
    const run = await db.one('SELECT * FROM payroll_runs WHERE id = $1 AND organization_id = $2', [req.v.params.runId, req.ctx.orgId]);
    if (!run) throw notFound('Payroll run');
    const settings = (await db.one(`SELECT settings FROM integrations WHERE organization_id = $1 AND provider = 'payroll_csv' AND status <> 'disconnected'`, [req.ctx.orgId]))?.settings ?? {};
    const dec = settings.hoursDecimals ?? 2;
    const h = (s) => (Number(s ?? 0) / 3600).toFixed(dec);
    const items = await db.many(
      `SELECT pi.*, m.employee_code, u.first_name, u.last_name, u.email FROM payroll_items pi
       JOIN organization_members m ON m.id = pi.member_id JOIN users u ON u.id = m.user_id
       WHERE pi.payroll_run_id = $1 ORDER BY u.last_name, u.first_name`,
      [run.id],
    );
    sendCsv(
      res,
      `payroll-${run.period_start}-${run.period_end}.csv`,
      items.map((i) => ({
        EmployeeCode: i.employee_code ?? '',
        FirstName: i.first_name,
        LastName: i.last_name,
        Email: i.email,
        PeriodStart: run.period_start,
        PeriodEnd: run.period_end,
        PayType: i.pay_type,
        RegularHours: h(i.regular_seconds),
        OvertimeHours: h(i.overtime_seconds),
        PaidBreakHours: h(i.paid_break_seconds),
        Rate: money(i.rate),
        OvertimeRate: money(i.overtime_rate),
        RegularAmount: money(i.regular_amount),
        OvertimeAmount: money(i.overtime_amount),
        Adjustments: money(i.adjustments),
        AdjustmentNote: i.adjustment_note ?? '',
        Total: money(i.total),
        Currency: i.currency,
      })),
      { delimiter: settings.delimiter ?? ',' },
    );
  },
);

export default r;
