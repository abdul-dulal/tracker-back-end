import { db } from '../../lib/db.js';
import { round2, convert } from '../currencies/service.js';

/**
 * Rate resolution (BILL-01…03, BILL-16).
 *  billing rate: project_members.billable_rate → projects.hourly_rate → clients.hourly_rate → org default_billable_rate
 *  billing currency: project.currency → client.currency → organization.default_currency
 *  cost rate: member_rates 'cost' (else 'pay') effective at date; monthly salary → hourly via weekly_hours × 52 / 12.
 */

/** SQL fragments reused by queries joining time_entries e / projects p / clients c / project_members pm / settings s / organizations o. */
export const BILL_RATE_SQL = `coalesce(pm.billable_rate, p.hourly_rate, c.hourly_rate, s.default_billable_rate)`;
export const BILL_RATE_SOURCE_SQL = `CASE WHEN pm.billable_rate IS NOT NULL THEN 'project_member' WHEN p.hourly_rate IS NOT NULL THEN 'project'
  WHEN c.hourly_rate IS NOT NULL THEN 'client' WHEN s.default_billable_rate IS NOT NULL THEN 'organization' ELSE 'none' END`;
export const BILL_CURRENCY_SQL = `coalesce(p.currency, c.currency, o.default_currency)`;

/** Billable entry = not deleted, finished (completed/approved) and flagged billable (BILL-04). */
export const WORKED_STATUSES = `('completed','approved')`;

export async function orgBillingSettings(orgId) {
  const row = await db.one(
    `SELECT o.default_currency, o.timezone, o.name, s.default_billable_rate, s.overtime_mode, s.overtime_multiplier,
            s.invoice_prefix, s.next_invoice_number
     FROM organizations o LEFT JOIN organization_settings s ON s.organization_id = o.id WHERE o.id = $1`,
    [orgId],
  );
  return row;
}

/** Billing rate for a member on a project (BILL-02/03). */
export async function billingRate({ orgId, projectId, memberId }) {
  const row = await db.one(
    `SELECT ${BILL_RATE_SQL} AS rate, ${BILL_CURRENCY_SQL} AS currency, ${BILL_RATE_SOURCE_SQL} AS source
     FROM organizations o
     LEFT JOIN organization_settings s ON s.organization_id = o.id
     LEFT JOIN projects p ON p.id = $2 AND p.organization_id = o.id
     LEFT JOIN clients c ON c.id = p.client_id
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.member_id = $3
     WHERE o.id = $1`,
    [orgId, projectId ?? null, memberId ?? null],
  );
  return { rate: row?.rate === null || row?.rate === undefined ? 0 : Number(row.rate), currency: row?.currency ?? 'USD', source: row?.source ?? 'none' };
}

/** Hourly equivalent of a monthly salary. */
export const hourlyFromMonthly = (amount, weeklyHours) => {
  const hours = (Number(weeklyHours) || 40) * 52 / 12;
  return hours > 0 ? Number(amount) / hours : 0;
};

/** Effective member rate of a type on a date (or null). */
export async function memberRate(memberId, rateType, date) {
  return db.one(
    `SELECT r.amount, r.currency, r.pay_type, r.rate_type, m.weekly_hours FROM member_rates r
     JOIN organization_members m ON m.id = r.member_id
     WHERE r.member_id = $1 AND r.rate_type = $2 AND r.effective_from <= $3::date AND (r.effective_to IS NULL OR r.effective_to > $3::date)
     ORDER BY r.effective_from DESC LIMIT 1`,
    [memberId, rateType, date],
  );
}

/** Hourly cost rate of a member at a date (BILL-01, BILL-06): cost rate, else pay rate. */
export async function costRate(memberId, date) {
  const r = (await memberRate(memberId, 'cost', date)) ?? (await memberRate(memberId, 'pay', date));
  if (!r) return { rate: 0, currency: null, source: 'none' };
  const rate = r.pay_type === 'monthly_salary' ? hourlyFromMonthly(r.amount, r.weekly_hours) : Number(r.amount);
  return { rate: round2(rate), currency: r.currency, source: r.rate_type, payType: r.pay_type };
}

/**
 * Worked entries in [from, to] (org-local dates) with resolved billing & cost rates per entry.
 * filters: { projectId, clientId, projectIds, memberId }
 */
export async function workedEntries(orgId, { from, to, projectId, clientId, projectIds } = {}) {
  const params = [orgId, from, to];
  const conds = [];
  if (projectId) {
    params.push(projectId);
    conds.push(`e.project_id = $${params.length}`);
  }
  if (clientId) {
    params.push(clientId);
    conds.push(`coalesce(p.client_id, e.client_id) = $${params.length}`);
  }
  if (projectIds) {
    params.push(projectIds);
    conds.push(`e.project_id = ANY($${params.length}::uuid[])`);
  }
  return db.many(
    `SELECT e.id, e.member_id, e.project_id, e.task_id, e.duration_seconds, e.is_billable, e.invoice_id,
            to_char((e.started_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD') AS local_date,
            p.name AS project_name, coalesce(p.client_id, e.client_id) AS client_id, c.name AS client_name,
            ${BILL_RATE_SQL} AS bill_rate, ${BILL_CURRENCY_SQL} AS bill_currency,
            cr.amount AS cost_amount, cr.pay_type AS cost_pay_type, cr.currency AS cost_currency, m.weekly_hours
     FROM time_entries e
     JOIN organizations o ON o.id = e.organization_id
     JOIN organization_members m ON m.id = e.member_id
     LEFT JOIN organization_settings s ON s.organization_id = e.organization_id
     LEFT JOIN projects p ON p.id = e.project_id
     LEFT JOIN clients c ON c.id = coalesce(p.client_id, e.client_id)
     LEFT JOIN project_members pm ON pm.project_id = e.project_id AND pm.member_id = e.member_id
     LEFT JOIN LATERAL (
       SELECT r.amount, r.pay_type, r.currency FROM member_rates r
       WHERE r.member_id = e.member_id AND r.rate_type IN ('cost','pay')
         AND r.effective_from <= (e.started_at AT TIME ZONE o.timezone)::date
         AND (r.effective_to IS NULL OR r.effective_to > (e.started_at AT TIME ZONE o.timezone)::date)
       ORDER BY (r.rate_type = 'cost') DESC, r.effective_from DESC LIMIT 1) cr ON true
     WHERE e.organization_id = $1 AND e.deleted_at IS NULL AND e.status IN ${WORKED_STATUSES} AND e.ended_at IS NOT NULL
       AND (e.started_at AT TIME ZONE o.timezone)::date BETWEEN $2::date AND $3::date
       ${conds.length ? `AND ${conds.join(' AND ')}` : ''}`,
    params,
  );
}

const emptyAgg = () => ({ billableSeconds: 0, nonBillableSeconds: 0, revenue: 0, cost: 0, missingRates: false });

function finishAgg(a) {
  const revenue = round2(a.revenue);
  const cost = round2(a.cost);
  const margin = round2(revenue - cost);
  return {
    billableHours: round2(a.billableSeconds / 3600),
    nonBillableHours: round2(a.nonBillableSeconds / 3600),
    totalHours: round2((a.billableSeconds + a.nonBillableSeconds) / 3600),
    revenue,
    cost,
    margin,
    marginPercent: revenue > 0 ? round2((margin / revenue) * 100) : null,
    ...(a.missingRates ? { missingExchangeRates: true } : {}),
  };
}

/**
 * Aggregate worked entries into billable/non-billable hours, revenue, cost and margin (BILL-04…06, BILL-10).
 * Amounts are reported in the organization's default currency (converted at entry date, BILL-17).
 */
export async function billingSummary(orgId, filters) {
  const org = await orgBillingSettings(orgId);
  const reporting = org.default_currency;
  const rows = await workedEntries(orgId, filters);
  const cache = new Map();
  const totals = emptyAgg();
  const byProject = new Map();
  const byClient = new Map();
  const byMember = new Map();
  for (const e of rows) {
    const secs = Number(e.duration_seconds) || 0;
    const hours = secs / 3600;
    let revenue = 0;
    let missing = false;
    if (e.is_billable && e.bill_rate !== null) {
      const native = hours * Number(e.bill_rate);
      const conv = await convert(native, e.bill_currency, reporting, e.local_date, cache);
      if (conv === null) missing = true;
      revenue = conv ?? native;
    }
    let cost = 0;
    if (e.cost_amount !== null && e.cost_amount !== undefined) {
      const hourly = e.cost_pay_type === 'monthly_salary' ? hourlyFromMonthly(e.cost_amount, e.weekly_hours) : Number(e.cost_amount);
      const native = hours * hourly;
      const conv = await convert(native, e.cost_currency, reporting, e.local_date, cache);
      if (conv === null) missing = true;
      cost = conv ?? native;
    }
    const groups = [
      totals,
      upsert(byProject, e.project_id ?? 'none', () => ({ projectId: e.project_id, projectName: e.project_name ?? 'No project', clientId: e.client_id, clientName: e.client_name, ...emptyAgg() })),
      upsert(byClient, e.client_id ?? 'none', () => ({ clientId: e.client_id, clientName: e.client_name ?? 'No client', ...emptyAgg() })),
      upsert(byMember, e.member_id, () => ({ memberId: e.member_id, ...emptyAgg() })),
    ];
    for (const g of groups) {
      if (e.is_billable) g.billableSeconds += secs;
      else g.nonBillableSeconds += secs;
      g.revenue += revenue;
      g.cost += cost;
      if (missing) g.missingRates = true;
    }
  }
  const fin = (m, keys) =>
    [...m.values()].map((g) => {
      const base = Object.fromEntries(keys.map((k) => [k, g[k] ?? null]));
      return { ...base, ...finishAgg(g) };
    });
  return {
    currency: reporting,
    totals: finishAgg(totals),
    byProject: fin(byProject, ['projectId', 'projectName', 'clientId', 'clientName']).sort((a, b) => b.revenue - a.revenue || b.totalHours - a.totalHours),
    byClient: fin(byClient, ['clientId', 'clientName']).sort((a, b) => b.revenue - a.revenue || b.totalHours - a.totalHours),
    byMember: fin(byMember, ['memberId']),
  };
}

function upsert(map, key, init) {
  if (!map.has(key)) map.set(key, init());
  return map.get(key);
}
