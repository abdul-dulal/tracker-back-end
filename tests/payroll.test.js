import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';
import { weekKey, proratedSalary } from '../src/modules/payroll/service.js';

let t;
let o;
let emp;
let sal;
let dept;

async function day(memberId, date, trackedHours, paidBreakHours = 0) {
  await db.query(
    `INSERT INTO daily_summaries (organization_id, member_id, date, tracked_seconds, paid_break_seconds)
     SELECT organization_id, id, $2, $3, $4 FROM organization_members WHERE id = $1
     ON CONFLICT (member_id, date) DO UPDATE SET tracked_seconds = EXCLUDED.tracked_seconds, paid_break_seconds = EXCLUDED.paid_break_seconds`,
    [memberId, date, Math.round(trackedHours * 3600), Math.round(paidBreakHours * 3600)],
  );
}
async function rate(memberId, amount, payType = 'hourly', currency = 'USD') {
  await db.query(
    `INSERT INTO member_rates (organization_id, member_id, rate_type, amount, currency, pay_type, effective_from)
     SELECT organization_id, id, 'pay', $2, $4, $3, '2026-01-01' FROM organization_members WHERE id = $1`,
    [memberId, amount, payType, currency],
  );
}
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
  t = await setupApp();
  o = await registerOrg(t);
  emp = await addMember(t, o, { role: 'employee', firstName: 'Hank' });
  sal = await addMember(t, o, { role: 'employee', firstName: 'Sally' });
  dept = await db.one(`INSERT INTO departments (organization_id, name) VALUES ($1,'Engineering') RETURNING id`, [o.orgId]);
  await db.query(`UPDATE organization_members SET department_id = $2 WHERE id = $1`, [emp.memberId, dept.id]);
  await rate(emp.memberId, 20);
  await rate(sal.memberId, 3000, 'monthly_salary');
  // Week of Mon 2026-11-02: 5 × 9h = 45h (+0.5h paid break on Monday)
  for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']) {
    await day(emp.memberId, d, 9, d === '2026-11-02' ? 0.5 : 0);
    await day(sal.memberId, d, 8);
  }
  await day(sal.memberId, '2026-11-07', 4); // Saturday → 44h week for the salaried member
});

describe('payroll helpers', () => {
  it('computes week keys and prorated salaries', () => {
    expect(weekKey('2026-11-08', 1)).toBe('2026-11-02');
    expect(weekKey('2026-11-08', 0)).toBe('2026-11-08');
    expect(proratedSalary(3000, '2026-11-01', '2026-11-30')).toBeCloseTo(3000);
    expect(proratedSalary(3100, '2026-12-01', '2026-12-31')).toBeCloseTo(3100);
    expect(proratedSalary(3000, '2026-11-01', '2026-11-15')).toBeCloseTo(1500);
  });
});

describe('payroll runs (BILL-07…09)', () => {
  let run;
  it('computes weekly overtime and hourly pay', async () => {
    const res = await o.api
      .post('/api/v1/payroll/runs')
      .send({ periodStart: '2026-11-02', periodEnd: '2026-11-08', memberIds: [emp.memberId, sal.memberId] })
      .expect(201);
    run = res.body.data;
    expect(run.status).toBe('draft');
    const h = run.items.find((i) => i.memberId === emp.memberId);
    expect(h.regularHours).toBe(40);
    expect(h.overtimeHours).toBe(5);
    expect(h.paidBreakHours).toBe(0.5);
    expect(h.rate).toBe(20);
    expect(h.overtimeRate).toBe(30);
    expect(h.regularAmount).toBe(810); // (40 + 0.5) × 20
    expect(h.overtimeAmount).toBe(150);
    expect(h.total).toBe(960);
    expect(h.departmentName).toBe('Engineering');

    const s = run.items.find((i) => i.memberId === sal.memberId);
    expect(s.payType).toBe('monthly_salary');
    expect(s.overtimeHours).toBe(4);
    expect(s.regularAmount).toBe(700); // 3000 × 7/30
    // hourly equivalent 3000 / (40×52/12) = 17.3077 → ×1.5 = 25.96
    expect(s.overtimeRate).toBe(25.96);
    expect(s.overtimeAmount).toBe(103.84);
    expect(run.totalAmount).toBeCloseTo(1763.84, 2);

    const dup = await o.api.post('/api/v1/payroll/runs').send({ periodStart: '2026-11-02', periodEnd: '2026-11-08' });
    expect(dup.status).toBe(409);
  });

  it('supports daily and none overtime modes', async () => {
    await db.query(`UPDATE organization_settings SET overtime_mode = 'daily', overtime_multiplier = 2 WHERE organization_id = $1`, [o.orgId]);
    const d = await o.api.post('/api/v1/payroll/runs').send({ periodStart: '2026-11-03', periodEnd: '2026-11-07', memberIds: [emp.memberId, sal.memberId] }).expect(201);
    const h = d.body.data.items.find((i) => i.memberId === emp.memberId);
    expect(h.overtimeHours).toBe(4); // 1h/day over 8h expected
    expect(h.overtimeRate).toBe(40);
    const s = d.body.data.items.find((i) => i.memberId === sal.memberId);
    expect(s.overtimeHours).toBe(4); // Saturday is a non-working day → all 4h overtime
    await db.query(`UPDATE organization_settings SET overtime_mode = 'none', overtime_multiplier = 1.5 WHERE organization_id = $1`, [o.orgId]);
    const n = await o.api.post('/api/v1/payroll/runs').send({ periodStart: '2026-11-04', periodEnd: '2026-11-06', memberIds: [emp.memberId] }).expect(201);
    expect(n.body.data.items[0]).toMatchObject({ overtimeHours: 0, regularHours: 27, total: 540 });
    await o.api.delete(`/api/v1/payroll/runs/${n.body.data.id}`).expect(204);
    await o.api.delete(`/api/v1/payroll/runs/${d.body.data.id}`).expect(204);
    await db.query(`UPDATE organization_settings SET overtime_mode = 'weekly' WHERE organization_id = $1`, [o.orgId]);
  });

  it('adjusts draft items, recalculates keeping adjustments, finalize blocks edits', async () => {
    const item = run.items.find((i) => i.memberId === emp.memberId);
    const a = await o.api.patch(`/api/v1/payroll/runs/${run.id}/items/${item.id}`).send({ adjustments: -60, adjustmentNote: 'Advance' }).expect(200);
    const adj = a.body.data.items.find((i) => i.memberId === emp.memberId);
    expect(adj.total).toBe(900);
    expect(a.body.data.totalAmount).toBeCloseTo(1703.84, 2);
    await day(emp.memberId, '2026-11-08', 2); // Sunday, same week → +2h overtime
    const rc = await o.api.post(`/api/v1/payroll/runs/${run.id}/recalculate`).expect(200);
    const after = rc.body.data.items.find((i) => i.memberId === emp.memberId);
    expect(after.overtimeHours).toBe(7);
    expect(after.adjustments).toBe(-60);
    expect(after.adjustmentNote).toBe('Advance');
    expect(after.total).toBe(810 + 210 - 60);

    await emp.api.post(`/api/v1/payroll/runs/${run.id}/finalize`).expect(403);
    await o.api.post(`/api/v1/payroll/runs/${run.id}/mark-paid`).expect(409);
    const f = await o.api.post(`/api/v1/payroll/runs/${run.id}/finalize`).expect(200);
    expect(f.body.data.status).toBe('finalized');
    const blocked = await o.api.patch(`/api/v1/payroll/runs/${run.id}/items/${after.id}`).send({ adjustments: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PAYROLL_NOT_DRAFT');
    await o.api.post(`/api/v1/payroll/runs/${run.id}/recalculate`).expect(409);
    await o.api.delete(`/api/v1/payroll/runs/${run.id}`).expect(409);
    await o.api.post(`/api/v1/payroll/runs/${run.id}/finalize`).expect(409);
  });

  it('exports CSV/XLSX, marks paid and summarises by department', async () => {
    const csv = await o.api.get(`/api/v1/payroll/runs/${run.id}/export?format=csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toContain('Employee code,Name,Email');
    expect(csv.text).toContain(emp.email);
    const xlsx = await o.api.get(`/api/v1/payroll/runs/${run.id}/export?format=xlsx`).buffer(true).parse(binary).expect(200);
    expect(xlsx.body.subarray(0, 2).toString()).toBe('PK');
    expect((await o.api.get(`/api/v1/payroll/runs/${run.id}`).expect(200)).body.data.status).toBe('exported');
    const paid = await o.api.post(`/api/v1/payroll/runs/${run.id}/mark-paid`).expect(200);
    expect(paid.body.data.status).toBe('paid');

    const list = await o.api.get('/api/v1/payroll/runs').expect(200);
    expect(list.body.data[0]).toMatchObject({ id: run.id, itemCount: 2 });
    const sum = await o.api.get('/api/v1/payroll/summary?month=2026-11').expect(200);
    const eng = sum.body.data.byDepartment.find((d) => d.departmentName === 'Engineering');
    expect(eng).toMatchObject({ members: 1, regularHours: 40, overtimeHours: 7, total: 960 });
    expect(sum.body.data.byDepartment.find((d) => d.departmentName === 'No department').members).toBe(1);
    await o.api.get('/api/v1/payroll/summary?month=2026-13').expect(400);
  });

  it('validates input, permissions, org isolation and the payroll plan feature', async () => {
    await o.api.post('/api/v1/payroll/runs').send({ periodStart: '2026-11-10', periodEnd: '2026-11-01' }).expect(400);
    await emp.api.get('/api/v1/payroll/runs').expect(403);
    const o2 = await registerOrg(t);
    await o2.api.get(`/api/v1/payroll/runs/${run.id}`).expect(404);
    await o2.api.post('/api/v1/payroll/runs').send({ periodStart: '2026-11-01', periodEnd: '2026-11-30', memberIds: [emp.memberId] }).expect(400);
    await db.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'starter') WHERE organization_id = $1`, [o2.orgId]);
    const r = await o2.api.get('/api/v1/payroll/runs');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
  });
});
