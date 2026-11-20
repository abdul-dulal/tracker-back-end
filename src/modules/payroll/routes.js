import { z } from 'zod';
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import { createRouter, zCurrency } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, noContent, paginationQuery, pageMeta, where, dateStr } from '../../lib/http.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { round2 } from '../currencies/service.js';
import { computeItems, writeItems, refreshRunTotal, loadRun, assertDraftRun, loadItems, runDto, hours } from './service.js';

const r = createRouter('/payroll', 'Payroll');
const FEATURE = 'payroll';
const idParam = z.object({ id: z.uuid() });

async function respondRun(res, orgId, id, status = 200) {
  const run = await loadRun(orgId, id);
  const items = await loadItems(id);
  res.status(status).json({ data: runDto(run, items) });
}

r.get(
  '/runs',
  {
    summary: 'List payroll runs',
    ids: 'BILL-09',
    permission: 'payroll.view',
    feature: FEATURE,
    query: paginationQuery.extend({ status: z.enum(['draft', 'finalized', 'paid', 'exported']).optional(), from: dateStr.optional(), to: dateStr.optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    const w = where([req.ctx.orgId]).raw('pr.organization_id = $1');
    w.add('pr.status = ?', q.status);
    w.add('pr.period_end >= ?::date', q.from);
    w.add('pr.period_start <= ?::date', q.to);
    const sortable = { periodStart: 'pr.period_start', createdAt: 'pr.created_at', totalAmount: 'pr.total_amount' };
    const total = (await db.one(`SELECT count(*)::int AS n FROM payroll_runs pr ${w.sql}`, w.params)).n;
    const rows = await db.many(
      `SELECT pr.*, (SELECT count(*) FROM payroll_items pi WHERE pi.payroll_run_id = pr.id) AS item_count
       FROM payroll_runs pr ${w.sql} ORDER BY ${sortable[q.sort] ?? 'pr.period_start'} ${q.order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      w.params,
    );
    ok(res, rows.map((x) => runDto(x)), pageMeta(q, total));
  },
);

r.post(
  '/runs',
  {
    summary: 'Create a payroll run (computes items per member)',
    ids: 'BILL-07, BILL-08, BILL-09',
    permission: 'payroll.manage',
    feature: FEATURE,
    body: z
      .object({ periodStart: dateStr, periodEnd: dateStr, currency: zCurrency.optional(), memberIds: z.array(z.uuid()).max(5000).optional() })
      .refine((b) => b.periodStart <= b.periodEnd, { message: 'periodEnd must be on/after periodStart', path: ['periodEnd'] })
      .refine((b) => (new Date(b.periodEnd) - new Date(b.periodStart)) / 86400_000 <= 366, { message: 'Period cannot exceed one year', path: ['periodEnd'] }),
  },
  async (req, res) => {
    const b = req.body;
    const orgId = req.ctx.orgId;
    if (b.memberIds?.length) {
      const ids = [...new Set(b.memberIds)];
      const n = (await db.one(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [orgId, ids])).n;
      if (n !== ids.length) throw badRequest('Unknown member referenced', undefined, 'INVALID_REFERENCE');
    }
    const existing = await db.one(`SELECT id FROM payroll_runs WHERE organization_id = $1 AND period_start = $2 AND period_end = $3`, [orgId, b.periodStart, b.periodEnd]);
    if (existing) throw conflict('PAYROLL_RUN_EXISTS', 'A payroll run already exists for this period', { id: existing.id });
    const currency = b.currency ?? req.ctx.currency ?? 'USD';
    const items = await computeItems(orgId, { ...b, currency });
    const run = await db.tx(async () => {
      const row = await db.one(
        `INSERT INTO payroll_runs (organization_id, period_start, period_end, currency, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [orgId, b.periodStart, b.periodEnd, currency, req.ctx.memberId ?? null],
      );
      await writeItems(row.id, items);
      return row;
    });
    await audit(req.ctx, 'payroll.run_created', { entityType: 'payroll_run', entityId: run.id, after: { periodStart: b.periodStart, periodEnd: b.periodEnd } });
    await respondRun(res, orgId, run.id, 201);
  },
);

r.get(
  '/summary',
  {
    summary: 'Monthly payroll summary by department',
    ids: 'BILL-09, BILL-15',
    permission: 'payroll.view',
    feature: FEATURE,
    query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM') }),
  },
  async (req, res) => {
    const month = req.v.query.month;
    const start = `${month}-01`;
    const runs = await db.many(
      `SELECT pr.* FROM payroll_runs pr WHERE pr.organization_id = $1
         AND pr.period_start >= $2::date AND pr.period_end < ($2::date + interval '1 month')::date
       ORDER BY pr.period_start`,
      [req.ctx.orgId, start],
    );
    const rows = runs.length
      ? await db.many(
          `SELECT d.id AS department_id, coalesce(d.name, 'No department') AS department_name, pi.currency,
                  count(DISTINCT pi.member_id)::int AS members, sum(pi.regular_seconds)::bigint AS regular_seconds,
                  sum(pi.overtime_seconds)::bigint AS overtime_seconds, sum(pi.paid_break_seconds)::bigint AS paid_break_seconds,
                  sum(pi.regular_amount) AS regular_amount, sum(pi.overtime_amount) AS overtime_amount,
                  sum(pi.adjustments) AS adjustments, sum(pi.total) AS total
           FROM payroll_items pi JOIN organization_members m ON m.id = pi.member_id LEFT JOIN departments d ON d.id = m.department_id
           WHERE pi.payroll_run_id = ANY($1::uuid[])
           GROUP BY d.id, d.name, pi.currency ORDER BY department_name`,
          [runs.map((x) => x.id)],
        )
      : [];
    const byDepartment = rows.map((x) => ({
      departmentId: x.department_id,
      departmentName: x.department_name,
      currency: x.currency,
      members: x.members,
      regularHours: hours(x.regular_seconds),
      overtimeHours: hours(x.overtime_seconds),
      paidBreakHours: hours(x.paid_break_seconds),
      regularAmount: round2(x.regular_amount),
      overtimeAmount: round2(x.overtime_amount),
      adjustments: round2(x.adjustments),
      total: round2(x.total),
    }));
    const totals = {};
    for (const d of byDepartment) {
      const t = (totals[d.currency] ??= { currency: d.currency, regularHours: 0, overtimeHours: 0, total: 0 });
      t.regularHours = round2(t.regularHours + d.regularHours);
      t.overtimeHours = round2(t.overtimeHours + d.overtimeHours);
      t.total = round2(t.total + d.total);
    }
    ok(res, { month, runs: runs.map((x) => runDto(x)), byDepartment, totals: Object.values(totals) });
  },
);

r.get('/runs/:id', { summary: 'Get payroll run with items', ids: 'BILL-09', permission: 'payroll.view', feature: FEATURE, params: idParam }, async (req, res) => {
  await respondRun(res, req.ctx.orgId, req.v.params.id);
});

r.patch(
  '/runs/:id/items/:itemId',
  {
    summary: 'Adjust a payroll item (draft runs only)',
    ids: 'BILL-07',
    permission: 'payroll.manage',
    feature: FEATURE,
    params: z.object({ id: z.uuid(), itemId: z.uuid() }),
    body: z.object({ adjustments: z.coerce.number().min(-1e10).max(1e10), adjustmentNote: z.string().trim().max(500).nullable().optional() }),
  },
  async (req, res) => {
    const { id, itemId } = req.v.params;
    await db.tx(async () => {
      const run = await loadRun(req.ctx.orgId, id, { lock: true });
      assertDraftRun(run);
      const adj = round2(req.body.adjustments);
      const row = await db.one(
        `UPDATE payroll_items SET adjustments = $3, adjustment_note = coalesce($4, adjustment_note), total = regular_amount + overtime_amount + $3
         WHERE id = $1 AND payroll_run_id = $2 RETURNING id`,
        [itemId, id, adj, req.body.adjustmentNote ?? null],
      );
      if (!row) throw badRequest('Item does not belong to this run', undefined, 'NOT_FOUND');
      await refreshRunTotal(id);
    });
    await audit(req.ctx, 'payroll.item_adjusted', { entityType: 'payroll_item', entityId: itemId, after: req.body });
    await respondRun(res, req.ctx.orgId, id);
  },
);

r.post('/runs/:id/recalculate', { summary: 'Recalculate a draft run (keeps adjustments)', ids: 'BILL-07, BILL-08', permission: 'payroll.manage', feature: FEATURE, params: idParam }, async (req, res) => {
  const orgId = req.ctx.orgId;
  const run = await loadRun(orgId, req.v.params.id);
  assertDraftRun(run);
  const prev = await db.many('SELECT member_id, adjustments, adjustment_note FROM payroll_items WHERE payroll_run_id = $1', [run.id]);
  const keepIds = prev.map((p) => p.member_id);
  const items = await computeItems(orgId, { periodStart: run.period_start, periodEnd: run.period_end, currency: run.currency, memberIds: keepIds.length ? keepIds : undefined });
  await db.tx(async () => {
    const locked = await loadRun(orgId, run.id, { lock: true });
    assertDraftRun(locked);
    await writeItems(run.id, items, new Map(prev.map((p) => [p.member_id, p])));
  });
  await respondRun(res, orgId, run.id);
});

r.post('/runs/:id/finalize', { summary: 'Finalize a payroll run (locks edits)', ids: 'BILL-09', permission: 'payroll.manage', feature: FEATURE, params: idParam }, async (req, res) => {
  const row = await db.one(
    `UPDATE payroll_runs SET status = 'finalized', finalized_by = $3, finalized_at = now() WHERE id = $1 AND organization_id = $2 AND status = 'draft' RETURNING id`,
    [req.v.params.id, req.ctx.orgId, req.ctx.memberId ?? null],
  );
  if (!row) {
    await loadRun(req.ctx.orgId, req.v.params.id); // 404 if missing
    throw conflict('PAYROLL_NOT_DRAFT', 'Only draft payroll runs can be finalized');
  }
  await audit(req.ctx, 'payroll.finalized', { entityType: 'payroll_run', entityId: row.id });
  await respondRun(res, req.ctx.orgId, row.id);
});

r.post('/runs/:id/mark-paid', { summary: 'Mark a finalized payroll run as paid', ids: 'BILL-09', permission: 'payroll.manage', feature: FEATURE, params: idParam }, async (req, res) => {
  const row = await db.one(
    `UPDATE payroll_runs SET status = 'paid', paid_at = now() WHERE id = $1 AND organization_id = $2 AND status IN ('finalized','exported') RETURNING id`,
    [req.v.params.id, req.ctx.orgId],
  );
  if (!row) {
    await loadRun(req.ctx.orgId, req.v.params.id);
    throw conflict('PAYROLL_NOT_FINALIZED', 'Only finalized payroll runs can be marked as paid');
  }
  await audit(req.ctx, 'payroll.paid', { entityType: 'payroll_run', entityId: row.id });
  await respondRun(res, req.ctx.orgId, row.id);
});

r.delete('/runs/:id', { summary: 'Delete a draft payroll run', ids: 'BILL-09', permission: 'payroll.manage', feature: FEATURE, params: idParam }, async (req, res) => {
  const run = await loadRun(req.ctx.orgId, req.v.params.id);
  assertDraftRun(run);
  await db.query('DELETE FROM payroll_runs WHERE id = $1', [run.id]);
  await audit(req.ctx, 'payroll.deleted', { entityType: 'payroll_run', entityId: run.id });
  noContent(res);
});

const EXPORT_COLUMNS = [
  ['employeeCode', 'Employee code'], ['name', 'Name'], ['email', 'Email'], ['department', 'Department'], ['payType', 'Pay type'],
  ['regularHours', 'Regular hours'], ['paidBreakHours', 'Paid break hours'], ['overtimeHours', 'Overtime hours'], ['rate', 'Rate'],
  ['overtimeRate', 'Overtime rate'], ['regularAmount', 'Regular amount'], ['overtimeAmount', 'Overtime amount'],
  ['adjustments', 'Adjustments'], ['adjustmentNote', 'Adjustment note'], ['total', 'Total'], ['currency', 'Currency'],
];

r.get(
  '/runs/:id/export',
  { summary: 'Export payroll run (CSV / XLSX)', ids: 'BILL-09, BILL-15', permission: 'payroll.manage', feature: FEATURE, params: idParam, query: z.object({ format: z.enum(['csv', 'xlsx']).default('csv') }) },
  async (req, res) => {
    const run = await loadRun(req.ctx.orgId, req.v.params.id);
    const items = await loadItems(run.id);
    const rows = items.map((i) => ({
      employeeCode: i.employee_code ?? '',
      name: i.name,
      email: i.email,
      department: i.department_name ?? '',
      payType: i.pay_type,
      regularHours: hours(i.regular_seconds),
      paidBreakHours: hours(i.paid_break_seconds),
      overtimeHours: hours(i.overtime_seconds),
      rate: Number(i.rate),
      overtimeRate: Number(i.overtime_rate),
      regularAmount: Number(i.regular_amount),
      overtimeAmount: Number(i.overtime_amount),
      adjustments: Number(i.adjustments),
      adjustmentNote: i.adjustment_note ?? '',
      total: Number(i.total),
      currency: i.currency,
    }));
    const base = `payroll_${run.period_start}_${run.period_end}`;
    if (run.status === 'finalized') await db.query(`UPDATE payroll_runs SET status = 'exported' WHERE id = $1`, [run.id]);
    await audit(req.ctx, 'payroll.exported', { entityType: 'payroll_run', entityId: run.id, after: { format: req.v.query.format } });
    if (req.v.query.format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Payroll');
      ws.columns = EXPORT_COLUMNS.map(([key, header]) => ({ key, header, width: Math.max(12, header.length + 2) }));
      ws.getRow(1).font = { bold: true };
      rows.forEach((x) => ws.addRow(x));
      ws.addRow({ name: 'TOTAL', total: round2(rows.reduce((s, x) => s + x.total, 0)), currency: run.currency });
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
      return res.send(buf);
    }
    const csv = stringify(rows.map((x) => EXPORT_COLUMNS.map(([k]) => x[k])), { header: true, columns: EXPORT_COLUMNS.map(([, h]) => h) });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    res.send(csv);
  },
);

export default r;
