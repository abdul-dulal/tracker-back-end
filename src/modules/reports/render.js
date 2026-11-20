import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';

/**
 * Report file rendering (RPT-A13): PDF (pdfkit), Excel (exceljs) and CSV (csv-stringify).
 * Durations are exported as decimal hours.
 */

export const FORMATS = {
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const header = (c) => (c.type === 'seconds' ? `${c.label} (h)` : c.label);

function cell(c, v) {
  if (v === null || v === undefined) return '';
  if (c.type === 'seconds') return Math.round((Number(v) / 3600) * 100) / 100;
  if (['number', 'percent', 'money'].includes(c.type)) return typeof v === 'number' ? v : Number(v);
  return String(v);
}

function totalsRow(report) {
  const t = report.totals ?? {};
  return report.columns.map((c, i) => (i === 0 && !(c.key in t) ? 'Total' : c.key in t ? cell(c, t[c.key]) : ''));
}

function tableData(report) {
  const head = report.columns.map(header);
  const body = report.rows.map((r) => report.columns.map((c) => cell(c, r[c.key])));
  return { head, body, total: totalsRow(report) };
}

export const slug = (s) =>
  String(s ?? 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'report';

function renderCsv(report) {
  const { head, body, total } = tableData(report);
  return Buffer.from(`﻿${stringify([head, ...body, total])}`, 'utf8');
}

async function renderXlsx(report, { title, orgName }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Tracker';
  wb.created = new Date();
  const ws = wb.addWorksheet('Report');
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([`${orgName ?? ''}  ${report.from} – ${report.to} (${report.timezone ?? 'UTC'})`]);
  ws.addRow([]);
  const { head, body, total } = tableData(report);
  ws.addRow(head).font = { bold: true };
  for (const r of body) ws.addRow(r);
  ws.addRow(total).font = { bold: true };
  ws.columns.forEach((col, i) => {
    col.width = Math.min(40, Math.max(12, String(head[i] ?? '').length + 4));
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function renderPdf(report, { title, orgName }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: report.columns.length > 6 ? 'landscape' : 'portrait', margin: 36 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(16).text(title);
    doc.fontSize(9).fillColor('#555').text(`${orgName ?? ''}  ·  ${report.from} – ${report.to} (${report.timezone ?? 'UTC'})  ·  generated ${new Date().toISOString()}`);
    doc.moveDown();
    const { head, body, total } = tableData(report);
    const width = doc.page.width - 72;
    const colW = width / Math.max(1, head.length);
    const drawRow = (cells, bold) => {
      if (doc.y > doc.page.height - 60) doc.addPage();
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#111');
      let h = 0;
      cells.forEach((v, i) => {
        const text = String(v ?? '');
        doc.text(text, 36 + i * colW, y, { width: colW - 4, ellipsis: true, height: 22 });
        h = Math.max(h, doc.heightOfString(text, { width: colW - 4 }));
      });
      doc.y = y + Math.min(h, 22) + 4;
      doc.x = 36;
    };
    drawRow(head, true);
    for (const r of body) drawRow(r, false);
    drawRow(total, true);
    if (report.disclaimer) {
      doc.moveDown();
      doc.font('Helvetica-Oblique').fontSize(7).fillColor('#666').text(report.disclaimer, 36, doc.y, { width });
    }
    doc.end();
  });
}

/**
 * @returns {Promise<{buffer:Buffer, contentType:string, filename:string}>}
 */
export async function renderReport(report, format, { title, orgName } = {}) {
  const t = title ?? `${report.reportType} report`;
  let buffer;
  if (format === 'csv') buffer = renderCsv(report);
  else if (format === 'xlsx') buffer = await renderXlsx(report, { title: t, orgName });
  else buffer = await renderPdf(report, { title: t, orgName });
  return { buffer, contentType: FORMATS[format] ?? FORMATS.pdf, filename: `${slug(t)}-${report.from}-${report.to}.${format}` };
}

export function sendFile(res, { buffer, contentType, filename }) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.status(200).end(buffer);
}
