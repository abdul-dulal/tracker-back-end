import { db } from '../../lib/db.js';
import { unprocessable, notFound, conflict } from '../../lib/errors.js';
import { expectedSecondsForDate } from '../time/summary-service.js';
import { round2, getRate } from '../currencies/service.js';
import { hourlyFromMonthly, memberRate } from '../billing/rates.js';

/**
 * Payroll calculation (BILL-07…09).
 *  - Worked time: daily_summaries.tracked_seconds; paid breaks (paid_break_seconds) are paid at the regular rate.
 *  - Overtime per organization_settings.overtime_mode:
 *      daily  → per day: tracked − expectedSecondsForDate
 *      weekly → per week (org week_start): week total − member weekly_hours
 *      both   → daily first, then weekly on the remaining regular time
 *      none   → no overtime
 *  - Pay rate: member_rates 'pay' effective at period end.
 *      hourly         → (regular + paid breaks) hours × rate
 *      monthly_salary → salary prorated by calendar days of each month in the period
 *    Overtime: overtime hours × (hourly rate | salary hourly equivalent) × overtime_multiplier.
 */

const DAY = 86400_000;
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);

/** Start of the week (YYYY-MM-DD) containing date, weeks starting on weekStart (0=Sun..6=Sat). */
export function weekKey(date, weekStart = 1) {
  const d = toDate(date);
  const diff = (d.getUTCDay() - weekStart + 7) % 7;
  return fmt(new Date(d.getTime() - diff * DAY));
}

/** Monthly salary prorated over [start, end] by calendar days per month. */
export function proratedSalary(amount, start, end) {
  let total = 0;
  let cur = toDate(start);
  const last = toDate(end);
  while (cur <= last) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth();
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const monthEnd = new Date(Date.UTC(y, m, dim));
    const segEnd = monthEnd < last ? monthEnd : last;
    const days = Math.round((segEnd - cur) / DAY) + 1;
    total += (Number(amount) * days) / dim;
    cur = new Date(segEnd.getTime() + DAY);
  }
  return total;
}

/**
 * Split tracked seconds into regular / overtime.
 * @param {{date:string, tracked:number}[]} days
 * @param {{mode:string, weeklyHours:number, weekStart:number, expected:(date)=>Promise<number>}} opts
 */
export async function splitOvertime(days, { mode, weeklyHours, weekStart, expected }) {
  let overtime = 0;
  const regularByDay = [];
  for (const d of days) {
    let reg = d.tracked;
    if (mode === 'daily' || mode === 'both') {
      const exp = await expected(d.date);
      const ot = Math.max(0, d.tracked - exp);
      overtime += ot;
      reg = d.tracked - ot;
    }
    regularByDay.push({ date: d.date, regular: reg });
  }
  if (mode === 'weekly' || mode === 'both') {
    const limit = Math.round((Number(weeklyHours) || 40) * 3600);
    const weeks = new Map();
    for (const d of regularByDay) weeks.set(weekKey(d.date, weekStart), (weeks.get(weekKey(d.date, weekStart)) ?? 0) + d.regular);
    for (const total of weeks.values()) overtime += Math.max(0, total - limit);
  }
  const tracked = days.reduce((s, d) => s + d.tracked, 0);
  return { regular: tracked - overtime, overtime };
}

async function runSettings(orgId) {
  return db.one(
    `SELECT o.default_currency, o.week_start, coalesce(s.overtime_mode, 'weekly') AS overtime_mode, coalesce(s.overtime_multiplier, 1.5) AS overtime_multiplier
     FROM organizations o LEFT JOIN organization_settings s ON s.organization_id = o.id WHERE o.id = $1`,
    [orgId],
  );
}

/** Compute payroll items for a run (not persisted). */
export async function computeItems(orgId, { periodStart, periodEnd, currency, memberIds }) {
  const st = await runSettings(orgId);
  const multiplier = Number(st.overtime_multiplier);
  const members = await db.many(
    `SELECT m.id, m.weekly_hours FROM organization_members m JOIN roles r ON r.id = m.role_id
     WHERE m.organization_id = $1 AND m.deleted_at IS NULL AND m.status = 'active' AND r.base_role <> 'client'
       ${memberIds?.length ? 'AND m.id = ANY($2::uuid[])' : ''}
     ORDER BY m.created_at`,
    memberIds?.length ? [orgId, memberIds] : [orgId],
  );
  const cache = new Map();
  const items = [];
  for (const m of members) {
    const days = (
      await db.many(
        `SELECT date, tracked_seconds, paid_break_seconds FROM daily_summaries
         WHERE member_id = $1 AND date BETWEEN $2::date AND $3::date ORDER BY date`,
        [m.id, periodStart, periodEnd],
      )
    ).map((d) => ({ date: d.date, tracked: Number(d.tracked_seconds) || 0, paidBreak: Number(d.paid_break_seconds) || 0 }));
    const paidBreak = days.reduce((s, d) => s + d.paidBreak, 0);
    const { regular, overtime } = await splitOvertime(
      days.filter((d) => d.tracked > 0),
      { mode: st.overtime_mode, weeklyHours: m.weekly_hours, weekStart: st.week_start ?? 1, expected: (date) => expectedSecondsForDate(m.id, date) },
    );
    const pay = await memberRate(m.id, 'pay', periodEnd);
    let factor = 1;
    if (pay && pay.currency !== currency) {
      const fx = await getRate(pay.currency, currency, periodEnd, cache);
      if (fx === null)
        throw unprocessable('NO_EXCHANGE_RATE', `No exchange rate from ${pay.currency} to ${currency}`, { from: pay.currency, to: currency, memberId: m.id });
      factor = fx;
    }
    const payType = pay?.pay_type ?? 'hourly';
    let rate = 0;
    let hourly = 0;
    let regularAmount = 0;
    if (pay && payType === 'monthly_salary') {
      rate = Number(pay.amount) * factor;
      hourly = hourlyFromMonthly(rate, m.weekly_hours);
      regularAmount = proratedSalary(rate, periodStart, periodEnd);
    } else if (pay) {
      rate = Number(pay.amount) * factor;
      hourly = rate;
      regularAmount = ((regular + paidBreak) / 3600) * rate;
    }
    const overtimeRate = round2(hourly * multiplier);
    const overtimeAmount = round2((overtime / 3600) * overtimeRate);
    items.push({
      memberId: m.id,
      payType,
      regularSeconds: regular,
      overtimeSeconds: overtime,
      paidBreakSeconds: paidBreak,
      rate: round2(rate),
      overtimeRate,
      regularAmount: round2(regularAmount),
      overtimeAmount,
      currency,
    });
  }
  return items;
}

/** Replace a run's items (keeping adjustments per member) and refresh totals. */
export async function writeItems(runId, items, keep = new Map()) {
  await db.query('DELETE FROM payroll_items WHERE payroll_run_id = $1', [runId]);
  for (const it of items) {
    const adj = keep.get(it.memberId);
    const adjustments = round2(adj?.adjustments ?? 0);
    await db.query(
      `INSERT INTO payroll_items (payroll_run_id, member_id, pay_type, regular_seconds, overtime_seconds, paid_break_seconds, rate, overtime_rate,
         regular_amount, overtime_amount, adjustments, adjustment_note, total, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [runId, it.memberId, it.payType, it.regularSeconds, it.overtimeSeconds, it.paidBreakSeconds, it.rate, it.overtimeRate,
        it.regularAmount, it.overtimeAmount, adjustments, adj?.adjustment_note ?? null,
        round2(it.regularAmount + it.overtimeAmount + adjustments), it.currency],
    );
  }
  await refreshRunTotal(runId);
}

export async function refreshRunTotal(runId) {
  await db.query(
    `UPDATE payroll_runs SET total_amount = (SELECT coalesce(sum(total), 0) FROM payroll_items WHERE payroll_run_id = $1) WHERE id = $1`,
    [runId],
  );
}

export async function loadRun(orgId, id, { lock = false } = {}) {
  const run = await db.one(`SELECT * FROM payroll_runs WHERE id = $1 AND organization_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, orgId]);
  if (!run) throw notFound('Payroll run');
  return run;
}

export function assertDraftRun(run) {
  if (run.status !== 'draft') throw conflict('PAYROLL_NOT_DRAFT', 'Only draft payroll runs can be changed');
}

export async function loadItems(runId) {
  return db.many(
    `SELECT pi.*, m.employee_code, m.department_id, d.name AS department_name, u.email, trim(u.first_name || ' ' || u.last_name) AS name
     FROM payroll_items pi JOIN organization_members m ON m.id = pi.member_id JOIN users u ON u.id = m.user_id
     LEFT JOIN departments d ON d.id = m.department_id
     WHERE pi.payroll_run_id = $1 ORDER BY u.first_name, u.last_name`,
    [runId],
  );
}

const num = (v) => Number(v ?? 0);
export const hours = (s) => round2(num(s) / 3600);

export const itemDto = (i) => ({
  id: i.id,
  memberId: i.member_id,
  memberName: i.name,
  email: i.email,
  employeeCode: i.employee_code,
  departmentId: i.department_id,
  departmentName: i.department_name,
  payType: i.pay_type,
  regularSeconds: i.regular_seconds,
  overtimeSeconds: i.overtime_seconds,
  paidBreakSeconds: i.paid_break_seconds,
  regularHours: hours(i.regular_seconds),
  overtimeHours: hours(i.overtime_seconds),
  paidBreakHours: hours(i.paid_break_seconds),
  rate: num(i.rate),
  overtimeRate: num(i.overtime_rate),
  regularAmount: num(i.regular_amount),
  overtimeAmount: num(i.overtime_amount),
  adjustments: num(i.adjustments),
  adjustmentNote: i.adjustment_note,
  total: num(i.total),
  currency: i.currency,
});

export const runDto = (r, items) => ({
  id: r.id,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  status: r.status,
  currency: r.currency,
  totalAmount: num(r.total_amount),
  finalizedBy: r.finalized_by,
  finalizedAt: r.finalized_at,
  paidAt: r.paid_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  ...(r.item_count !== undefined ? { itemCount: Number(r.item_count) } : {}),
  ...(items ? { items: items.map(itemDto) } : {}),
});
