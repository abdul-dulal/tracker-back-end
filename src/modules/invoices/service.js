import PDFDocument from 'pdfkit';
import { db } from '../../lib/db.js';
import { notFound, conflict } from '../../lib/errors.js';
import { round2 } from '../currencies/service.js';

/** Invoice helpers (BILL-11…14): numbering, totals, DTOs and PDF rendering. */

export const OPEN_STATUSES = ['sent', 'partially_paid', 'overdue'];

const n = (v) => (v === null || v === undefined ? 0 : Number(v));

/** Atomically take the next invoice number: prefix + zero-padded counter. */
export async function nextInvoiceNumber(orgId) {
  await db.query(`INSERT INTO organization_settings (organization_id) VALUES ($1) ON CONFLICT DO NOTHING`, [orgId]);
  const row = await db.one(
    `UPDATE organization_settings SET next_invoice_number = next_invoice_number + 1, updated_at = now()
     WHERE organization_id = $1 RETURNING invoice_prefix, next_invoice_number - 1 AS num`,
    [orgId],
  );
  return `${row.invoice_prefix}${String(row.num).padStart(4, '0')}`;
}

/** Normalise line items: amount = hours × rate unless given. */
export function normalizeItems(items = []) {
  return items.map((it, i) => {
    const hours = round2(n(it.hours));
    const rate = round2(n(it.rate));
    const amount = it.amount !== undefined && it.amount !== null ? round2(it.amount) : round2(hours * rate);
    return {
      projectId: it.projectId ?? null,
      taskId: it.taskId ?? null,
      memberId: it.memberId ?? null,
      description: it.description,
      hours,
      rate,
      amount,
      position: it.position ?? i,
    };
  });
}

export function computeTotals(items, taxPercent = 0, discountAmount = 0) {
  const subtotal = round2(items.reduce((s, it) => s + n(it.amount), 0));
  const taxAmount = round2((subtotal * n(taxPercent)) / 100);
  const total = round2(Math.max(0, subtotal + taxAmount - n(discountAmount)));
  return { subtotal, taxAmount, total };
}

export async function insertItems(invoiceId, items) {
  for (const it of items) {
    await db.query(
      `INSERT INTO invoice_items (invoice_id, project_id, task_id, member_id, description, hours, rate, amount, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [invoiceId, it.projectId, it.taskId, it.memberId, it.description, it.hours, it.rate, it.amount, it.position],
    );
  }
}

export function invoiceDto(i, { items, payments, client } = {}) {
  const total = n(i.total);
  const paid = n(i.amount_paid);
  return {
    id: i.id,
    number: i.number,
    status: i.status,
    clientId: i.client_id,
    clientName: i.client_name ?? client?.name ?? null,
    issueDate: i.issue_date,
    dueDate: i.due_date,
    currency: i.currency,
    subtotal: n(i.subtotal),
    taxPercent: n(i.tax_percent),
    taxAmount: n(i.tax_amount),
    discountAmount: n(i.discount_amount),
    total,
    amountPaid: paid,
    balance: round2(total - paid),
    notes: i.notes,
    periodFrom: i.period_from,
    periodTo: i.period_to,
    sentAt: i.sent_at,
    isOverdue: OPEN_STATUSES.includes(i.status) && !!i.due_date && i.due_date < new Date().toISOString().slice(0, 10),
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    ...(i.entry_count !== undefined ? { entryCount: Number(i.entry_count) } : {}),
    ...(items ? { items: items.map(itemDto) } : {}),
    ...(payments ? { payments: payments.map(paymentDto) } : {}),
  };
}

export const itemDto = (it) => ({
  id: it.id,
  projectId: it.project_id,
  projectName: it.project_name ?? null,
  taskId: it.task_id,
  memberId: it.member_id,
  description: it.description,
  hours: n(it.hours),
  rate: n(it.rate),
  amount: n(it.amount),
  position: it.position,
});

export const paymentDto = (p) => ({
  id: p.id,
  amount: n(p.amount),
  paidAt: p.paid_at,
  method: p.method,
  reference: p.reference,
  createdAt: p.created_at,
});

/** Load invoice with items & payments (org-scoped). Optional extra filter e.g. clientId for the portal. */
export async function loadInvoice(orgId, id, { clientId, lock = false } = {}) {
  const inv = await db.one(
    `SELECT i.*, c.name AS client_name,
            (SELECT count(*) FROM time_entries te WHERE te.invoice_id = i.id) AS entry_count
     FROM invoices i JOIN clients c ON c.id = i.client_id
     WHERE i.id = $1 AND i.organization_id = $2 AND i.deleted_at IS NULL ${clientId ? 'AND i.client_id = $3' : ''}
     ${lock ? 'FOR UPDATE OF i' : ''}`,
    clientId ? [id, orgId, clientId] : [id, orgId],
  );
  if (!inv) throw notFound('Invoice');
  return inv;
}

export async function loadInvoiceFull(orgId, id, opts) {
  const inv = await loadInvoice(orgId, id, opts);
  const items = await db.many(
    `SELECT it.*, p.name AS project_name FROM invoice_items it LEFT JOIN projects p ON p.id = it.project_id
     WHERE it.invoice_id = $1 ORDER BY it.position, it.description`,
    [id],
  );
  const payments = await db.many(`SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY paid_at, created_at`, [id]);
  return { inv, items, payments };
}

export function assertDraft(inv) {
  if (inv.status !== 'draft') throw conflict('INVOICE_NOT_DRAFT', 'Only draft invoices can be changed');
}

/** Release time entries attached to an invoice (void / delete). */
export async function releaseEntries(invoiceId) {
  const r = await db.query(`UPDATE time_entries SET invoice_id = NULL, updated_at = now() WHERE invoice_id = $1`, [invoiceId]);
  return r.rowCount;
}

const money = (v, cur) => `${cur} ${n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Render an invoice PDF (BILL-12). Returns a Buffer. */
export async function renderInvoicePdf(orgId, id, opts) {
  const { inv, items, payments } = await loadInvoiceFull(orgId, id, opts);
  const org = await db.one(`SELECT name, address, country FROM organizations WHERE id = $1`, [orgId]);
  const client = await db.one(`SELECT name, company, email, phone, address FROM clients WHERE id = $1`, [inv.client_id]);
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${inv.number}`, Author: org.name } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const addr = (a) => (a && typeof a === 'object' ? Object.values(a).filter((x) => typeof x === 'string' && x).join(', ') : '');

  doc.fontSize(20).text(org.name, 50, 50);
  if (addr(org.address)) doc.fontSize(9).fillColor('#555').text(addr(org.address));
  doc.fillColor('#000').fontSize(24).text('INVOICE', 350, 50, { width: 195, align: 'right' });
  doc.fontSize(10)
    .text(`Number: ${inv.number}`, 350, 82, { width: 195, align: 'right' })
    .text(`Status: ${inv.status.replace('_', ' ')}`, { width: 195, align: 'right' })
    .text(`Issue date: ${inv.issue_date}`, { width: 195, align: 'right' })
    .text(`Due date: ${inv.due_date ?? '—'}`, { width: 195, align: 'right' });
  if (inv.period_from) doc.text(`Period: ${inv.period_from} – ${inv.period_to}`, { width: 195, align: 'right' });

  doc.fontSize(11).text('Bill to:', 50, 150, { underline: true });
  doc.fontSize(10).text(client.company ? `${client.name} (${client.company})` : client.name);
  if (client.email) doc.text(client.email);
  if (client.phone) doc.text(client.phone);
  if (addr(client.address)) doc.text(addr(client.address));

  // Items table
  let y = 240;
  const cols = { desc: 50, hours: 330, rate: 395, amount: 465 };
  const header = () => {
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text('Description', cols.desc, y).text('Hours', cols.hours, y, { width: 55, align: 'right' })
      .text('Rate', cols.rate, y, { width: 60, align: 'right' }).text('Amount', cols.amount, y, { width: 80, align: 'right' });
    doc.font('Helvetica');
    y += 16;
    doc.moveTo(50, y - 3).lineTo(545, y - 3).strokeColor('#999').stroke();
  };
  header();
  for (const it of items) {
    const h = doc.heightOfString(it.description, { width: 270 });
    if (y + h > 740) {
      doc.addPage();
      y = 50;
      header();
    }
    doc.fontSize(9).text(it.description, cols.desc, y, { width: 270 });
    doc.text(n(it.hours).toFixed(2), cols.hours, y, { width: 55, align: 'right' })
      .text(n(it.rate).toFixed(2), cols.rate, y, { width: 60, align: 'right' })
      .text(n(it.amount).toFixed(2), cols.amount, y, { width: 80, align: 'right' });
    y += Math.max(h, 12) + 6;
  }
  if (y > 640) {
    doc.addPage();
    y = 50;
  }
  doc.moveTo(50, y).lineTo(545, y).strokeColor('#999').stroke();
  y += 10;
  const line = (label, value, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
    doc.text(label, 330, y, { width: 125, align: 'right' }).text(value, cols.amount, y, { width: 80, align: 'right' });
    y += 15;
  };
  const balance = round2(n(inv.total) - n(inv.amount_paid));
  line('Subtotal', money(inv.subtotal, inv.currency));
  line(`Tax (${n(inv.tax_percent)}%)`, money(inv.tax_amount, inv.currency));
  if (n(inv.discount_amount)) line('Discount', `-${money(inv.discount_amount, inv.currency)}`);
  line('Total', money(inv.total, inv.currency), true);
  line('Paid', money(inv.amount_paid, inv.currency));
  line('Balance due', money(balance, inv.currency), true);
  doc.font('Helvetica');
  if (payments.length) {
    y += 10;
    doc.fontSize(9).text('Payments:', 50, y);
    for (const p of payments) doc.text(`${p.paid_at}  ${money(p.amount, inv.currency)}${p.method ? `  ${p.method}` : ''}${p.reference ? `  (${p.reference})` : ''}`);
  }
  if (inv.notes) {
    doc.moveDown().fontSize(9).text('Notes:', 50).text(inv.notes, { width: 495 });
  }
  doc.end();
  return { buffer: await done, inv };
}
