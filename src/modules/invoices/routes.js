import { z } from 'zod';
import { createRouter, zBool, zCurrency, zMoney } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, where, dateStr } from '../../lib/http.js';
import { notFound, badRequest, conflict, unprocessable } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { sendMail, layout, escapeHtml } from '../../lib/mailer.js';
import { notify } from '../notifications/service.js';
import { round2, convert } from '../currencies/service.js';
import { BILL_RATE_SQL, BILL_CURRENCY_SQL, WORKED_STATUSES } from '../billing/rates.js';
import {
  OPEN_STATUSES, nextInvoiceNumber, normalizeItems, computeTotals, insertItems, invoiceDto, loadInvoice, loadInvoiceFull,
  assertDraft, releaseEntries, renderInvoicePdf,
} from './service.js';

const r = createRouter('/invoices', 'Invoices');
const FEATURE = 'invoices';
const idParam = z.object({ id: z.uuid() });

const itemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  hours: zMoney.optional(),
  rate: zMoney.optional(),
  amount: zMoney.optional(),
  projectId: z.uuid().nullable().optional(),
  taskId: z.uuid().nullable().optional(),
  memberId: z.uuid().nullable().optional(),
});
const taxSchema = z.coerce.number().min(0).max(100);

async function orgToday(orgId) {
  return (await db.one(`SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS d FROM organizations WHERE id = $1`, [orgId])).d;
}
const addDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function loadClient(orgId, clientId) {
  const c = await db.one(`SELECT * FROM clients WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`, [clientId, orgId]);
  if (!c) throw notFound('Client');
  return c;
}

/** Make sure referenced projects/tasks/members belong to the org. */
async function assertItemRefs(orgId, items) {
  const check = async (table, ids, label) => {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return;
    const row = await db.one(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [orgId, list]);
    if (row.n !== list.length) throw badRequest(`Unknown ${label} referenced in items`, undefined, 'INVALID_REFERENCE');
  };
  await check('projects', items.map((i) => i.projectId), 'project');
  await check('tasks', items.map((i) => i.taskId), 'task');
  await check('organization_members', items.map((i) => i.memberId), 'member');
}

async function respondFull(res, orgId, id, status = 200) {
  const { inv, items, payments } = await loadInvoiceFull(orgId, id);
  res.status(status).json({ data: invoiceDto(inv, { items, payments }) });
}

// ───────────── List ─────────────
r.get(
  '/',
  {
    summary: 'List invoices',
    ids: 'BILL-13, BILL-14',
    permission: 'invoices.view',
    feature: FEATURE,
    query: paginationQuery.extend({
      status: z.enum(['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void']).optional(),
      clientId: z.uuid().optional(),
      overdue: zBool.optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
    }),
  },
  async (req, res) => {
    const q = req.v.query;
    const w = where([req.ctx.orgId]).raw('i.organization_id = $1').raw('i.deleted_at IS NULL');
    w.add('i.status = ?', q.status);
    w.add('i.client_id = ?', q.clientId);
    w.add('i.issue_date >= ?::date', q.from);
    w.add('i.issue_date <= ?::date', q.to);
    if (q.overdue === true) w.raw(`(i.status = 'overdue' OR (i.status IN ('sent','partially_paid') AND i.due_date < current_date))`);
    if (q.overdue === false) w.raw(`NOT (i.status = 'overdue' OR (i.status IN ('sent','partially_paid') AND i.due_date < current_date))`);
    if (q.search) w.add('(i.number ILIKE ? OR c.name ILIKE ?)', `%${q.search}%`, `%${q.search}%`);
    const sortable = { issueDate: 'i.issue_date', dueDate: 'i.due_date', number: 'i.number', total: 'i.total', status: 'i.status', createdAt: 'i.created_at' };
    const col = sortable[q.sort] ?? 'i.created_at';
    const total = (await db.one(`SELECT count(*)::int AS n FROM invoices i JOIN clients c ON c.id = i.client_id ${w.sql}`, w.params)).n;
    const rows = await db.many(
      `SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id ${w.sql}
       ORDER BY ${col} ${q.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, i.number DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      w.params,
    );
    ok(res, rows.map((x) => invoiceDto(x)), pageMeta(q, total));
  },
);

// ───────────── Manual create ─────────────
r.post(
  '/',
  {
    summary: 'Create a manual draft invoice',
    ids: 'BILL-11, BILL-13',
    permission: 'invoices.manage',
    feature: FEATURE,
    body: z
      .object({
        clientId: z.uuid(),
        currency: zCurrency.optional(),
        issueDate: dateStr.optional(),
        dueDate: dateStr.optional(),
        taxPercent: taxSchema.default(0),
        discountAmount: zMoney.default(0),
        notes: z.string().max(5000).optional(),
        periodFrom: dateStr.optional(),
        periodTo: dateStr.optional(),
        items: z.array(itemSchema).max(500).default([]),
      })
      .refine((b) => !b.dueDate || !b.issueDate || b.dueDate >= b.issueDate, { message: 'dueDate must be on/after issueDate', path: ['dueDate'] }),
  },
  async (req, res) => {
    const b = req.body;
    const client = await loadClient(req.ctx.orgId, b.clientId);
    const items = normalizeItems(b.items);
    await assertItemRefs(req.ctx.orgId, items);
    const issueDate = b.issueDate ?? (await orgToday(req.ctx.orgId));
    const currency = b.currency ?? client.currency ?? req.ctx.currency ?? 'USD';
    const totals = computeTotals(items, b.taxPercent, b.discountAmount);
    const inv = await db.tx(async () => {
      const number = await nextInvoiceNumber(req.ctx.orgId);
      const row = await db.one(
        `INSERT INTO invoices (organization_id, client_id, number, issue_date, due_date, currency, subtotal, tax_percent, tax_amount,
           discount_amount, total, notes, period_from, period_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [req.ctx.orgId, client.id, number, issueDate, b.dueDate ?? addDays(issueDate, 30), currency, totals.subtotal, b.taxPercent,
          totals.taxAmount, b.discountAmount, totals.total, b.notes ?? null, b.periodFrom ?? null, b.periodTo ?? null, req.ctx.memberId ?? null],
      );
      await insertItems(row.id, items);
      return row;
    });
    await audit(req.ctx, 'invoice.created', { entityType: 'invoice', entityId: inv.id, after: { number: inv.number, total: totals.total } });
    await publish('invoice.created', { orgId: req.ctx.orgId, invoiceId: inv.id, number: inv.number, clientId: client.id });
    await respondFull(res, req.ctx.orgId, inv.id, 201);
  },
);

// ───────────── Generate from time ─────────────
r.post(
  '/generate',
  {
    summary: 'Generate a draft invoice from un-invoiced billable time of a client',
    ids: 'BILL-10, BILL-11, BILL-17',
    permission: 'invoices.manage',
    feature: FEATURE,
    body: z
      .object({
        clientId: z.uuid(),
        from: dateStr,
        to: dateStr,
        projectIds: z.array(z.uuid()).max(200).optional(),
        groupBy: z.enum(['project', 'task', 'member']).default('project'),
        taxPercent: taxSchema.default(0),
        discountAmount: zMoney.default(0),
        dueInDays: z.coerce.number().int().min(0).max(365).default(30),
        notes: z.string().max(5000).optional(),
      })
      .refine((b) => b.from <= b.to, { message: 'from must be on or before to', path: ['to'] }),
  },
  async (req, res) => {
    const b = req.body;
    const orgId = req.ctx.orgId;
    const client = await loadClient(orgId, b.clientId);
    const projects = await db.many(
      `SELECT id FROM projects WHERE organization_id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [orgId, client.id],
    );
    let projectIds = projects.map((p) => p.id);
    if (b.projectIds?.length) {
      const bad = b.projectIds.filter((id) => !projectIds.includes(id));
      if (bad.length) throw badRequest('Some projects do not belong to this client', { projectIds: bad }, 'INVALID_REFERENCE');
      projectIds = [...new Set(b.projectIds)];
    }
    const currency = client.currency ?? req.ctx.currency ?? 'USD';
    const issueDate = await orgToday(orgId);

    const result = await db.tx(async () => {
      const entries = projectIds.length
        ? await db.many(
            `SELECT e.id, e.project_id, e.task_id, e.member_id, e.duration_seconds, p.name AS project_name, t.title AS task_title,
                    trim(u.first_name || ' ' || u.last_name) AS member_name,
                    ${BILL_RATE_SQL} AS rate, ${BILL_CURRENCY_SQL} AS rate_currency
             FROM time_entries e
             JOIN projects p ON p.id = e.project_id
             JOIN organizations o ON o.id = e.organization_id
             LEFT JOIN organization_settings s ON s.organization_id = e.organization_id
             LEFT JOIN clients c ON c.id = p.client_id
             LEFT JOIN project_members pm ON pm.project_id = e.project_id AND pm.member_id = e.member_id
             LEFT JOIN tasks t ON t.id = e.task_id
             JOIN organization_members m ON m.id = e.member_id JOIN users u ON u.id = m.user_id
             WHERE e.organization_id = $1 AND e.project_id = ANY($2::uuid[]) AND e.deleted_at IS NULL AND e.ended_at IS NOT NULL
               AND e.is_billable AND e.status IN ${WORKED_STATUSES} AND e.invoice_id IS NULL
               AND (e.started_at AT TIME ZONE o.timezone)::date BETWEEN $3::date AND $4::date
             ORDER BY e.started_at
             FOR UPDATE OF e`,
            [orgId, projectIds, b.from, b.to],
          )
        : [];
      const billable = entries.filter((e) => Number(e.duration_seconds) > 0);
      if (!billable.length) throw unprocessable('NOTHING_TO_INVOICE', 'No un-invoiced billable time found for this client and period');

      // Group by (key, rate) so every line has a single rate.
      const cache = new Map();
      const groups = new Map();
      for (const e of billable) {
        let rate = e.rate === null ? 0 : Number(e.rate);
        if (e.rate_currency && e.rate_currency !== currency && rate) {
          const conv = await convert(rate, e.rate_currency, currency, b.to, cache);
          if (conv === null)
            throw unprocessable('NO_EXCHANGE_RATE', `No exchange rate from ${e.rate_currency} to ${currency}`, { from: e.rate_currency, to: currency });
          rate = conv;
        }
        rate = round2(rate);
        let key;
        let desc;
        let refs = { projectId: e.project_id, taskId: null, memberId: null };
        if (b.groupBy === 'task') {
          key = `${e.project_id}|${e.task_id ?? '-'}`;
          desc = `${e.project_name} — ${e.task_title ?? 'General work'}`;
          refs.taskId = e.task_id;
        } else if (b.groupBy === 'member') {
          key = `${e.project_id}|${e.member_id}`;
          desc = `${e.project_name} — ${e.member_name}`;
          refs.memberId = e.member_id;
        } else {
          key = `${e.project_id}`;
          desc = e.project_name;
        }
        const gk = `${key}|${rate}`;
        if (!groups.has(gk)) groups.set(gk, { key, desc, rate, seconds: 0, ...refs });
        groups.get(gk).seconds += Number(e.duration_seconds);
      }
      // Distinguish duplicate descriptions (same group, different rates).
      const list = [...groups.values()];
      const counts = list.reduce((m, g) => m.set(g.key, (m.get(g.key) ?? 0) + 1), new Map());
      const items = normalizeItems(
        list
          .sort((a, b2) => a.desc.localeCompare(b2.desc) || a.rate - b2.rate)
          .map((g) => ({
            description: counts.get(g.key) > 1 ? `${g.desc} (@ ${g.rate.toFixed(2)}/h)` : g.desc,
            hours: round2(g.seconds / 3600),
            rate: g.rate,
            projectId: g.projectId,
            taskId: g.taskId,
            memberId: g.memberId,
          })),
      );
      const totals = computeTotals(items, b.taxPercent, b.discountAmount);
      const number = await nextInvoiceNumber(orgId);
      const inv = await db.one(
        `INSERT INTO invoices (organization_id, client_id, number, issue_date, due_date, currency, subtotal, tax_percent, tax_amount,
           discount_amount, total, notes, period_from, period_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [orgId, client.id, number, issueDate, addDays(issueDate, b.dueInDays), currency, totals.subtotal, b.taxPercent, totals.taxAmount,
          b.discountAmount, totals.total, b.notes ?? null, b.from, b.to, req.ctx.memberId ?? null],
      );
      await insertItems(inv.id, items);
      const upd = await db.query(
        `UPDATE time_entries SET invoice_id = $1, updated_at = now() WHERE id = ANY($2::uuid[]) AND invoice_id IS NULL`,
        [inv.id, billable.map((e) => e.id)],
      );
      if (upd.rowCount !== billable.length) throw conflict('DOUBLE_BILLING', 'Some entries were invoiced concurrently; try again');
      return inv;
    });
    await audit(req.ctx, 'invoice.generated', { entityType: 'invoice', entityId: result.id, after: { number: result.number, total: Number(result.total) } });
    await publish('invoice.created', { orgId, invoiceId: result.id, number: result.number, clientId: client.id });
    await respondFull(res, orgId, result.id, 201);
  },
);

// ───────────── Read / edit / delete ─────────────
r.get('/:id', { summary: 'Get invoice with items & payments', ids: 'BILL-13', permission: 'invoices.view', feature: FEATURE, params: idParam }, async (req, res) => {
  await respondFull(res, req.ctx.orgId, req.v.params.id);
});

r.patch(
  '/:id',
  {
    summary: 'Edit a draft invoice (items replaced when provided)',
    ids: 'BILL-11, BILL-13',
    permission: 'invoices.manage',
    feature: FEATURE,
    params: idParam,
    body: z.object({
      items: z.array(itemSchema).max(500).optional(),
      taxPercent: taxSchema.optional(),
      discountAmount: zMoney.optional(),
      notes: z.string().max(5000).nullable().optional(),
      issueDate: dateStr.optional(),
      dueDate: dateStr.nullable().optional(),
      currency: zCurrency.optional(),
    }),
  },
  async (req, res) => {
    const b = req.body;
    const orgId = req.ctx.orgId;
    await db.tx(async () => {
      const inv = await loadInvoice(orgId, req.v.params.id, { lock: true });
      assertDraft(inv);
      let items;
      if (b.items) {
        items = normalizeItems(b.items);
        await assertItemRefs(orgId, items);
        await db.query('DELETE FROM invoice_items WHERE invoice_id = $1', [inv.id]);
        await insertItems(inv.id, items);
      } else {
        items = await db.many('SELECT amount FROM invoice_items WHERE invoice_id = $1', [inv.id]);
      }
      const taxPercent = b.taxPercent ?? Number(inv.tax_percent);
      const discount = b.discountAmount ?? Number(inv.discount_amount);
      const issueDate = b.issueDate ?? inv.issue_date;
      const dueDate = b.dueDate === undefined ? inv.due_date : b.dueDate;
      if (dueDate && dueDate < issueDate) throw badRequest('dueDate must be on/after issueDate');
      const totals = computeTotals(items, taxPercent, discount);
      await db.query(
        `UPDATE invoices SET subtotal = $2, tax_percent = $3, tax_amount = $4, discount_amount = $5, total = $6,
           notes = $7, issue_date = $8, due_date = $9, currency = $10, updated_at = now() WHERE id = $1`,
        [inv.id, totals.subtotal, taxPercent, totals.taxAmount, discount, totals.total,
          b.notes === undefined ? inv.notes : b.notes, issueDate, dueDate, b.currency ?? inv.currency],
      );
    });
    await respondFull(res, orgId, req.v.params.id);
  },
);

r.delete('/:id', { summary: 'Delete a draft invoice (releases time entries)', ids: 'BILL-11', permission: 'invoices.manage', feature: FEATURE, params: idParam }, async (req, res) => {
  const orgId = req.ctx.orgId;
  await db.tx(async () => {
    const inv = await loadInvoice(orgId, req.v.params.id, { lock: true });
    assertDraft(inv);
    await releaseEntries(inv.id);
    await db.query('UPDATE invoices SET deleted_at = now(), updated_at = now() WHERE id = $1', [inv.id]);
  });
  await audit(req.ctx, 'invoice.deleted', { entityType: 'invoice', entityId: req.v.params.id });
  noContent(res);
});

// ───────────── Lifecycle ─────────────
r.post('/:id/send', { summary: 'Send invoice to the client (email with PDF)', ids: 'BILL-12, BILL-13, CLI-16, CLI-17', permission: 'invoices.manage', feature: FEATURE, params: idParam, body: z.object({ message: z.string().max(2000).optional() }).optional() }, async (req, res) => {
  const orgId = req.ctx.orgId;
  const inv = await loadInvoice(orgId, req.v.params.id);
  if (!['draft', ...OPEN_STATUSES].includes(inv.status)) throw conflict('INVALID_INVOICE_STATUS', `Cannot send an invoice that is ${inv.status}`);
  const client = await db.one('SELECT * FROM clients WHERE id = $1', [inv.client_id]);
  const clientUsers = await db.many(
    `SELECT m.id AS member_id, m.user_id, u.email, u.first_name FROM organization_members m JOIN roles ro ON ro.id = m.role_id JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND m.client_id = $2 AND ro.base_role = 'client' AND m.status = 'active' AND m.deleted_at IS NULL`,
    [orgId, inv.client_id],
  );
  const recipients = [...new Set([client.email, ...clientUsers.map((u) => u.email)].filter(Boolean).map((e) => String(e).toLowerCase()))];
  if (!recipients.length) throw unprocessable('NO_RECIPIENTS', 'The client has no email address and no portal users');
  const updated = await db.one(
    `UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = now(), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [inv.id],
  );
  const { buffer } = await renderInvoicePdf(orgId, inv.id);
  const org = await db.one('SELECT name FROM organizations WHERE id = $1', [orgId]);
  const balance = round2(Number(updated.total) - Number(updated.amount_paid));
  const msg = req.body?.message;
  for (const to of recipients) {
    await sendMail({
      to,
      subject: `Invoice ${updated.number} from ${org.name}`,
      html: layout({
        title: `Invoice ${updated.number}`,
        body: `<p>${escapeHtml(org.name)} has sent you invoice <b>${escapeHtml(updated.number)}</b> for <b>${updated.currency} ${balance.toFixed(2)}</b>${updated.due_date ? `, due ${escapeHtml(updated.due_date)}` : ''}.</p>${msg ? `<p>${escapeHtml(msg)}</p>` : ''}<p>The invoice is attached as a PDF.</p>`,
      }),
      text: `Invoice ${updated.number} from ${org.name}: ${updated.currency} ${balance.toFixed(2)}${updated.due_date ? ` due ${updated.due_date}` : ''}.${msg ? `\n\n${msg}` : ''}`,
      attachments: [{ filename: `${updated.number}.pdf`, content: buffer, contentType: 'application/pdf' }],
    });
  }
  if (clientUsers.length)
    await notify({
      orgId,
      userIds: clientUsers.map((u) => u.user_id),
      type: 'invoice.sent',
      title: `New invoice ${updated.number}`,
      body: `Invoice ${updated.number} for ${updated.currency} ${balance.toFixed(2)} is available.`,
      link: `/client-portal/invoices/${updated.id}`,
      data: { invoiceId: updated.id },
      email: false,
    });
  await audit(req.ctx, 'invoice.sent', { entityType: 'invoice', entityId: inv.id, after: { recipients } });
  await publish('invoice.sent', { orgId, invoiceId: inv.id, number: updated.number, clientId: inv.client_id });
  await respondFull(res, orgId, inv.id);
});

r.post('/:id/void', { summary: 'Void an invoice (releases time entries)', ids: 'BILL-13', permission: 'invoices.manage', feature: FEATURE, params: idParam }, async (req, res) => {
  const orgId = req.ctx.orgId;
  await db.tx(async () => {
    const inv = await loadInvoice(orgId, req.v.params.id, { lock: true });
    if (inv.status === 'void') throw conflict('INVALID_INVOICE_STATUS', 'Invoice is already void');
    if (Number(inv.amount_paid) > 0) throw conflict('INVOICE_HAS_PAYMENTS', 'Invoices with recorded payments cannot be voided');
    await releaseEntries(inv.id);
    await db.query(`UPDATE invoices SET status = 'void', updated_at = now() WHERE id = $1`, [inv.id]);
  });
  await audit(req.ctx, 'invoice.voided', { entityType: 'invoice', entityId: req.v.params.id });
  await respondFull(res, orgId, req.v.params.id);
});

r.post(
  '/:id/payments',
  {
    summary: 'Record a payment',
    ids: 'BILL-13, BILL-14',
    permission: 'invoices.manage',
    feature: FEATURE,
    params: idParam,
    body: z.object({
      amount: z.coerce.number().positive().max(1e12),
      paidAt: dateStr.optional(),
      method: z.string().trim().max(40).optional(),
      reference: z.string().trim().max(120).optional(),
    }),
  },
  async (req, res) => {
    const b = req.body;
    const orgId = req.ctx.orgId;
    const amount = round2(b.amount);
    const updated = await db.tx(async () => {
      const inv = await loadInvoice(orgId, req.v.params.id, { lock: true });
      if (!OPEN_STATUSES.includes(inv.status)) throw conflict('INVALID_INVOICE_STATUS', `Cannot record a payment on a ${inv.status} invoice`);
      const balance = round2(Number(inv.total) - Number(inv.amount_paid));
      if (amount > balance) throw unprocessable('PAYMENT_EXCEEDS_BALANCE', `Payment exceeds the balance (${balance.toFixed(2)})`, { balance });
      await db.query(
        `INSERT INTO invoice_payments (organization_id, invoice_id, amount, paid_at, method, reference) VALUES ($1,$2,$3,$4,$5,$6)`,
        [orgId, inv.id, amount, b.paidAt ?? (await orgToday(orgId)), b.method ?? null, b.reference ?? null],
      );
      const paid = round2(Number(inv.amount_paid) + amount);
      const status = paid >= Number(inv.total) ? 'paid' : 'partially_paid';
      return db.one(`UPDATE invoices SET amount_paid = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING *`, [inv.id, paid, status]);
    });
    await audit(req.ctx, 'invoice.payment_recorded', { entityType: 'invoice', entityId: updated.id, after: { amount, status: updated.status } });
    if (updated.status === 'paid') await publish('invoice.paid', { orgId, invoiceId: updated.id, number: updated.number, clientId: updated.client_id });
    await respondFull(res, orgId, updated.id, 201);
  },
);

r.get('/:id/pdf', { summary: 'Download invoice PDF', ids: 'BILL-12', permission: 'invoices.view', feature: FEATURE, params: idParam }, async (req, res) => {
  const { buffer, inv } = await renderInvoicePdf(req.ctx.orgId, req.v.params.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${inv.number.replace(/[^\w.-]/g, '_')}.pdf"`);
  res.send(buffer);
});

export default r;
