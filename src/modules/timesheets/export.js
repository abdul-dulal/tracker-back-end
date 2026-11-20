import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import { db } from '../../lib/db.js';
import { memberTimezone } from '../time/summary-service.js';
import { entryInPeriodSql, addDays } from './service.js';

/** Per-day per-project hours of a timesheet (TS-18/19/20). */
export async function timesheetBreakdown(ts) {
  const tz = await memberTimezone(ts.member_id);
  const rows = await db.many(
    `SELECT to_char((e.started_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS date, e.project_id, coalesce(p.name, 'No project') AS project,
            sum(e.duration_seconds)::int AS seconds, sum(e.duration_seconds) FILTER (WHERE e.is_billable)::int AS billable
     FROM time_entries e LEFT JOIN projects p ON p.id = e.project_id
     WHERE e.member_id = $1 AND e.ended_at IS NOT NULL AND ${entryInPeriodSql('$2', '$3', '$4')}
     GROUP BY 1, 2, 3 ORDER BY 1, 3`,
    [ts.member_id, tz, ts.period_start, ts.period_end],
  );
  const days = [];
  for (let d = ts.period_start; d <= ts.period_end; d = addDays(d, 1)) days.push(d);
  const projects = new Map();
  for (const r of rows) {
    const key = r.project_id ?? 'none';
    if (!projects.has(key)) projects.set(key, { projectId: r.project_id, project: r.project, days: {}, totalSeconds: 0 });
    const p = projects.get(key);
    p.days[r.date] = (p.days[r.date] ?? 0) + r.seconds;
    p.totalSeconds += r.seconds;
  }
  const dayTotals = Object.fromEntries(days.map((d) => [d, rows.filter((r) => r.date === d).reduce((s, r) => s + r.seconds, 0)]));
  const total = rows.reduce((s, r) => s + r.seconds, 0);
  const billable = rows.reduce((s, r) => s + (r.billable ?? 0), 0);
  return { days, rows: [...projects.values()], dayTotals, totalSeconds: total, billableSeconds: billable };
}

const hrs = (s) => Math.round(((s ?? 0) / 3600) * 100) / 100;

export async function renderExport(ts, format) {
  const b = await timesheetBreakdown(ts);
  const member = `${ts.first_name ?? ''} ${ts.last_name ?? ''}`.trim();
  const base = `timesheet-${(member || 'member').replace(/[^A-Za-z0-9]+/g, '-')}-${ts.period_start}`;
  const header = ['Project', ...b.days, 'Total'];
  const body = b.rows.map((r) => [r.project, ...b.days.map((d) => hrs(r.days[d])), hrs(r.totalSeconds)]);
  const totalRow = ['Total', ...b.days.map((d) => hrs(b.dayTotals[d])), hrs(b.totalSeconds)];

  if (format === 'csv') {
    const lines = [
      ['Member', member],
      ['Employee code', ts.employee_code ?? ''],
      ['Period', `${ts.period_start} to ${ts.period_end}`],
      ['Status', ts.status],
      ['Revision', ts.revision],
      [],
      header,
      ...body,
      totalRow,
      [],
      ['Billable hours', hrs(b.billableSeconds)],
      ['Overtime hours', hrs(ts.overtime_seconds)],
    ];
    return { buffer: Buffer.from(stringify(lines), 'utf8'), contentType: 'text/csv; charset=utf-8', filename: `${base}.csv` };
  }

  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Tracker';
    const ws = wb.addWorksheet('Timesheet');
    ws.addRow(['Member', member]);
    ws.addRow(['Employee code', ts.employee_code ?? '']);
    ws.addRow(['Period', `${ts.period_start} to ${ts.period_end}`]);
    ws.addRow(['Status', ts.status]);
    ws.addRow([]);
    const h = ws.addRow(header);
    h.font = { bold: true };
    for (const r of body) ws.addRow(r);
    const t = ws.addRow(totalRow);
    t.font = { bold: true };
    ws.addRow([]);
    ws.addRow(['Billable hours', hrs(b.billableSeconds)]);
    ws.addRow(['Overtime hours', hrs(ts.overtime_seconds)]);
    ws.getColumn(1).width = 28;
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${base}.xlsx` };
  }

  // PDF
  const doc = new PDFDocument({ size: 'A4', layout: b.days.length > 7 ? 'landscape' : 'portrait', margin: 36 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));
  doc.fontSize(16).text('Timesheet', { underline: false });
  doc.moveDown(0.5).fontSize(10);
  doc.text(`Member: ${member}${ts.employee_code ? ` (${ts.employee_code})` : ''}`);
  doc.text(`Period: ${ts.period_start} to ${ts.period_end}`);
  doc.text(`Status: ${ts.status} (revision ${ts.revision})`);
  doc.moveDown();
  const cols = header.length;
  const usable = doc.page.width - 72;
  const firstW = Math.min(140, usable * 0.3);
  const cellW = (usable - firstW) / (cols - 1);
  const drawRow = (cells, bold) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(b.days.length > 14 ? 6 : 8);
    cells.forEach((c, i) => {
      const x = 36 + (i === 0 ? 0 : firstW + (i - 1) * cellW);
      const label = i > 0 && i < cols - 1 && bold && /^\d{4}-/.test(String(c)) ? String(c).slice(5) : String(c);
      doc.text(label, x, y, { width: i === 0 ? firstW : cellW, align: i === 0 ? 'left' : 'right' });
    });
    doc.moveDown(0.4);
    doc.x = 36;
  };
  drawRow(header, true);
  for (const r of body) drawRow(r, false);
  drawRow(totalRow, true);
  doc.moveDown().font('Helvetica').fontSize(10);
  doc.text(`Total hours: ${hrs(b.totalSeconds)}   Billable: ${hrs(b.billableSeconds)}   Overtime: ${hrs(ts.overtime_seconds)}`, 36);
  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), contentType: 'application/pdf', filename: `${base}.pdf` };
}
