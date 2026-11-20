import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, dateStr } from '../../lib/http.js';
import { notFound, badRequest, forbidden } from '../../lib/errors.js';
import { accessibleProjectIds } from '../../rbac/scope.js';
import { billingSummary, billingRate, costRate, orgBillingSettings } from './rates.js';
import { round2 } from '../currencies/service.js';

const r = createRouter('/billing', 'Billing');

/** Default range = current org-local month. */
async function resolveRange(orgId, q) {
  if (q.from && q.to) {
    if (q.from > q.to) throw badRequest('from must be on or before to');
    return { from: q.from, to: q.to };
  }
  const row = await db.one(
    `SELECT to_char(date_trunc('month', (now() AT TIME ZONE o.timezone))::date, 'YYYY-MM-DD') AS f,
            to_char((date_trunc('month', (now() AT TIME ZONE o.timezone)) + interval '1 month - 1 day')::date, 'YYYY-MM-DD') AS t
     FROM organizations o WHERE o.id = $1`,
    [orgId],
  );
  return { from: q.from ?? row.f, to: q.to ?? row.t };
}

async function memberNames(orgId, ids) {
  if (!ids.length) return new Map();
  const rows = await db.many(
    `SELECT m.id, trim(u.first_name || ' ' || u.last_name) AS name FROM organization_members m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND m.id = ANY($2::uuid[])`,
    [orgId, ids],
  );
  return new Map(rows.map((x) => [x.id, x.name]));
}

r.get(
  '/summary',
  {
    summary: 'Billing summary: billable vs non-billable hours, revenue, cost & margin by project and client',
    ids: 'BILL-04, BILL-05, BILL-06, BILL-10, BILL-17',
    permission: 'billing.view',
    query: z.object({ from: dateStr.optional(), to: dateStr.optional(), projectId: z.uuid().optional(), clientId: z.uuid().optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    const range = await resolveRange(req.ctx.orgId, q);
    const scoped = await accessibleProjectIds(req.ctx, 'billing.view');
    if (scoped && q.projectId && !scoped.includes(q.projectId)) throw forbidden('You do not have access to this project');
    const sum = await billingSummary(req.ctx.orgId, { ...range, projectId: q.projectId, clientId: q.clientId, projectIds: scoped ?? undefined });
    const names = await memberNames(req.ctx.orgId, sum.byMember.map((m) => m.memberId));
    sum.byMember = sum.byMember.map((m) => ({ ...m, memberName: names.get(m.memberId) ?? null }));
    ok(res, { ...range, ...sum });
  },
);

r.get(
  '/projects/:id',
  {
    summary: 'Project billing summary (hours × billing rate, cost, budget)',
    ids: 'BILL-02, BILL-06, BILL-10',
    permission: 'billing.view',
    params: z.object({ id: z.uuid() }),
    query: z.object({ from: dateStr.optional(), to: dateStr.optional() }),
  },
  async (req, res) => {
    const { id } = req.v.params;
    const p = await db.one(
      `SELECT p.*, c.name AS client_name, c.hourly_rate AS client_rate, c.currency AS client_currency, to_char(p.created_at, 'YYYY-MM-DD') AS created_date
       FROM projects p LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1 AND p.organization_id = $2 AND p.deleted_at IS NULL`,
      [id, req.ctx.orgId],
    );
    if (!p) throw notFound('Project');
    const scoped = await accessibleProjectIds(req.ctx, 'billing.view');
    if (scoped && !scoped.includes(id)) throw forbidden('You do not have access to this project');
    // Whole project life by default.
    const from = req.v.query.from ?? (p.start_date && p.start_date < p.created_date ? p.start_date : p.created_date);
    const to = req.v.query.to ?? new Date().toISOString().slice(0, 10);
    if (from > to) throw badRequest('from must be on or before to');
    const sum = await billingSummary(req.ctx.orgId, { from, to, projectId: id });
    const org = await orgBillingSettings(req.ctx.orgId);
    const projRate = await billingRate({ orgId: req.ctx.orgId, projectId: id });
    const members = await db.many(
      `SELECT pm.member_id, pm.role, pm.billable_rate, trim(u.first_name || ' ' || u.last_name) AS name
       FROM project_members pm JOIN organization_members m ON m.id = pm.member_id JOIN users u ON u.id = m.user_id
       WHERE pm.project_id = $1`,
      [id],
    );
    const memberIds = [...new Set([...members.map((m) => m.member_id), ...sum.byMember.map((m) => m.memberId)])];
    const names = await memberNames(req.ctx.orgId, memberIds);
    const byMember = [];
    for (const mid of memberIds) {
      const pm = members.find((m) => m.member_id === mid);
      const agg = sum.byMember.find((m) => m.memberId === mid);
      const br = await billingRate({ orgId: req.ctx.orgId, projectId: id, memberId: mid });
      const cr = await costRate(mid, to);
      byMember.push({
        memberId: mid,
        memberName: names.get(mid) ?? null,
        projectRole: pm?.role ?? null,
        billingRate: br.rate,
        billingRateSource: br.source,
        costRate: cr.rate,
        costCurrency: cr.currency,
        ...(agg ? { ...agg, memberId: mid } : { billableHours: 0, nonBillableHours: 0, totalHours: 0, revenue: 0, cost: 0, margin: 0, marginPercent: null }),
      });
    }
    let budget = null;
    if (p.budget_type !== 'none' && p.budget_value !== null) {
      const value = Number(p.budget_value);
      const used = p.budget_type === 'hours' ? sum.totals.totalHours : sum.totals.revenue;
      budget = { type: p.budget_type, value, used: round2(used), remaining: round2(value - used), percentUsed: value > 0 ? round2((used / value) * 100) : null };
    }
    ok(res, {
      project: { id: p.id, name: p.name, clientId: p.client_id, clientName: p.client_name, isBillableDefault: p.is_billable_default },
      from,
      to,
      currency: sum.currency,
      billingRate: projRate.rate,
      billingRateSource: projRate.source,
      billingCurrency: projRate.currency,
      defaultBillableRate: org.default_billable_rate === null ? null : Number(org.default_billable_rate),
      totals: sum.totals,
      budget,
      byMember,
    });
  },
);

export default r;
