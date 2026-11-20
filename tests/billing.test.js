import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';
import { billingRate, costRate } from '../src/modules/billing/rates.js';
import { convert } from '../src/modules/currencies/service.js';
import { runCron } from '../src/lib/jobs.js';

let t;
let o;
let emp;
let client;
let project;
let other;

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const cursor = new Map();
/** Insert a finished entry of `hours` on a given date (sequential, non-overlapping per member/day). */
async function entry(memberId, projectId, { date = '2026-10-05', hours = 1, status = 'completed', billable = true, deleted = false } = {}) {
  const key = `${memberId}|${date}`;
  const offset = cursor.get(key) ?? 0;
  const secs = Math.round(hours * 3600);
  cursor.set(key, offset + secs + 60);
  const start = new Date(new Date(`${date}T00:00:00Z`).getTime() + offset * 1000);
  const end = new Date(start.getTime() + secs * 1000);
  const row = await db.one(
    `INSERT INTO time_entries (organization_id, member_id, project_id, started_at, ended_at, duration_seconds, active_seconds, is_billable, status, source, deleted_at)
     SELECT organization_id, id, $2, $3, $4, $5, $5, $6, $7, 'manual', $8 FROM organization_members WHERE id = $1 RETURNING id`,
    [memberId, projectId, start, end, secs, billable, status, deleted ? new Date() : null],
  );
  return row.id;
}

beforeAll(async () => {
  t = await setupApp();
  o = await registerOrg(t);
  emp = await addMember(t, o, { role: 'employee', firstName: 'Eve' });
  client = await db.one(`INSERT INTO clients (organization_id, name, email, hourly_rate) VALUES ($1,'Acme','billing@acme.test',20) RETURNING *`, [o.orgId]);
  project = await db.one(`INSERT INTO projects (organization_id, name, client_id) VALUES ($1,'Acme Site',$2) RETURNING *`, [o.orgId, client.id]);
  other = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1,'Internal') RETURNING *`, [o.orgId]);
  await db.query(`INSERT INTO project_members (project_id, member_id) VALUES ($1,$2),($1,$3)`, [project.id, emp.memberId, o.memberId]);
});

describe('rates (BILL-01…03, BILL-16)', () => {
  it('resolves billing rate project_member → project → client → org default', async () => {
    const org = await db.one('SELECT id FROM organizations WHERE id = $1', [o.orgId]);
    await db.query(`UPDATE organization_settings SET default_billable_rate = 10 WHERE organization_id = $1`, [org.id]);
    const p2 = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1,'Rate test') RETURNING *`, [o.orgId]);
    expect((await billingRate({ orgId: o.orgId, projectId: p2.id, memberId: emp.memberId })).rate).toBe(10);
    await db.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [p2.id, client.id]);
    let r = await billingRate({ orgId: o.orgId, projectId: p2.id, memberId: emp.memberId });
    expect(r).toMatchObject({ rate: 20, source: 'client' });
    await db.query(`UPDATE projects SET hourly_rate = 30, currency = 'EUR' WHERE id = $1`, [p2.id]);
    r = await billingRate({ orgId: o.orgId, projectId: p2.id, memberId: emp.memberId });
    expect(r).toMatchObject({ rate: 30, source: 'project', currency: 'EUR' });
    await db.query(`INSERT INTO project_members (project_id, member_id, billable_rate) VALUES ($1,$2,40)`, [p2.id, emp.memberId]);
    r = await billingRate({ orgId: o.orgId, projectId: p2.id, memberId: emp.memberId });
    expect(r).toMatchObject({ rate: 40, source: 'project_member' });
    await db.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [p2.id]);
  });

  it('cost rate prefers cost over pay and converts monthly salary to hourly', async () => {
    await db.query(
      `INSERT INTO member_rates (organization_id, member_id, rate_type, amount, currency, pay_type, effective_from) VALUES ($1,$2,'pay',5200,'USD','monthly_salary','2026-01-01')`,
      [o.orgId, emp.memberId],
    );
    expect((await costRate(emp.memberId, '2026-10-05')).rate).toBe(30); // 5200 / (40*52/12)
    await db.query(
      `INSERT INTO member_rates (organization_id, member_id, rate_type, amount, currency, pay_type, effective_from) VALUES ($1,$2,'cost',12,'USD','hourly','2026-01-01')`,
      [o.orgId, emp.memberId],
    );
    expect(await costRate(emp.memberId, '2026-10-05')).toMatchObject({ rate: 12, source: 'cost' });
    expect((await costRate(emp.memberId, '2025-01-01')).rate).toBe(0);
  });
});

describe('currencies (BILL-16, BILL-17)', () => {
  it('lists currencies, stores manual rates and converts with nearest/inverse rates', async () => {
    const c = await o.api.get('/api/v1/currencies').expect(200);
    expect(c.body.data.defaultCurrency).toBe('USD');
    expect(c.body.data.currencies.some((x) => x.code === 'EUR')).toBe(true);
    await o.api.put('/api/v1/exchange-rates').send({ base: 'EUR', quote: 'USD', rate: 1.1, date: '2026-10-01' }).expect(200);
    await o.api.put('/api/v1/exchange-rates').send({ base: 'EUR', quote: 'USD', rate: 1.2, date: '2026-10-10' }).expect(200);
    await o.api.put('/api/v1/exchange-rates').send({ base: 'EUR', quote: 'EUR', rate: 1, date: '2026-10-10' }).expect(400);
    await emp.api.put('/api/v1/exchange-rates').send({ base: 'EUR', quote: 'USD', rate: 1.3, date: '2026-10-10' }).expect(403);
    const g = await o.api.get('/api/v1/exchange-rates?base=EUR&date=2026-10-05').expect(200);
    expect(g.body.data.rates).toEqual([{ quote: 'USD', rate: 1.1, date: '2026-10-01' }]);
    expect(await convert(100, 'EUR', 'USD', '2026-10-05')).toBeCloseTo(110);
    expect(await convert(120, 'USD', 'EUR', '2026-10-15')).toBeCloseTo(100);
    expect(await convert(1, 'GBP', 'USD', '2026-10-15')).toBeNull();
  });

  it('exchange-rate cron ignores network failures', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    try {
      await expect(runCron('billing.exchange_rates')).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('billing summary (BILL-04…06, BILL-10)', () => {
  it('splits billable/non-billable hours and computes revenue, cost & margin', async () => {
    await entry(emp.memberId, other.id, { date: '2026-09-10', hours: 2, billable: false });
    await entry(emp.memberId, project.id, { date: '2026-09-10', hours: 3 });
    await entry(emp.memberId, project.id, { date: '2026-09-11', hours: 1, status: 'pending' }); // excluded
    const res = await o.api.get('/api/v1/billing/summary?from=2026-09-01&to=2026-09-30').expect(200);
    const d = res.body.data;
    expect(d.totals.billableHours).toBe(3);
    expect(d.totals.nonBillableHours).toBe(2);
    expect(d.totals.revenue).toBe(60); // 3h × client rate 20
    expect(d.totals.cost).toBe(60); // 5h × cost 12
    expect(d.totals.margin).toBe(0);
    const acme = d.byProject.find((p) => p.projectId === project.id);
    expect(acme).toMatchObject({ billableHours: 3, revenue: 60, cost: 36, margin: 24 });
    expect(d.byClient.find((c) => c.clientId === client.id).revenue).toBe(60);
    const filtered = await o.api.get(`/api/v1/billing/summary?from=2026-09-01&to=2026-09-30&clientId=${client.id}`).expect(200);
    expect(filtered.body.data.totals.totalHours).toBe(3);

    const pr = await o.api.get(`/api/v1/billing/projects/${project.id}?from=2026-09-01&to=2026-09-30`).expect(200);
    expect(pr.body.data.billingRate).toBe(20);
    expect(pr.body.data.billingRateSource).toBe('client');
    expect(pr.body.data.totals.revenue).toBe(60);
    expect(pr.body.data.byMember.find((m) => m.memberId === emp.memberId)).toMatchObject({ costRate: 12, billableHours: 3 });

    await emp.api.get('/api/v1/billing/summary').expect(403);
    await o.api.get('/api/v1/billing/summary?from=2026-10-01&to=2026-09-01').expect(400);
  });
});

describe('invoices (BILL-11…14)', () => {
  let inv1;
  it('generates a draft from un-invoiced billable completed/approved entries only', async () => {
    const good1 = await entry(emp.memberId, project.id, { date: '2026-10-05', hours: 2 });
    const good2 = await entry(o.memberId, project.id, { date: '2026-10-06', hours: 1, status: 'approved' });
    const nonBill = await entry(emp.memberId, project.id, { date: '2026-10-06', hours: 1, billable: false });
    const pending = await entry(emp.memberId, project.id, { date: '2026-10-07', hours: 1, status: 'pending' });
    const rejected = await entry(emp.memberId, project.id, { date: '2026-10-07', hours: 1, status: 'rejected' });
    const deleted = await entry(emp.memberId, project.id, { date: '2026-10-08', hours: 1, deleted: true });
    const outside = await entry(emp.memberId, project.id, { date: '2026-11-05', hours: 1 });
    await db.query(`UPDATE project_members SET billable_rate = 50 WHERE project_id = $1 AND member_id = $2`, [project.id, o.memberId]);

    const res = await o.api
      .post('/api/v1/invoices/generate')
      .send({ clientId: client.id, from: '2026-10-01', to: '2026-10-31', groupBy: 'member', taxPercent: 10, dueInDays: 15 })
      .expect(201);
    inv1 = res.body.data;
    expect(inv1.status).toBe('draft');
    expect(inv1.number).toBe('INV-0001');
    expect(inv1.items).toHaveLength(2);
    expect(inv1.items.reduce((s, i) => s + i.hours, 0)).toBe(3);
    expect(inv1.subtotal).toBe(90); // 2h × 20 + 1h × 50
    expect(inv1.taxAmount).toBe(9);
    expect(inv1.total).toBe(99);
    expect(inv1.entryCount).toBe(2);
    const linked = await db.many(`SELECT id FROM time_entries WHERE invoice_id = $1`, [inv1.id]);
    expect(linked.map((x) => x.id).sort()).toEqual([good1, good2].sort());
    for (const id of [nonBill, pending, rejected, deleted, outside]) {
      expect((await db.one('SELECT invoice_id FROM time_entries WHERE id = $1', [id])).invoice_id).toBeNull();
    }
    // No double billing
    const again = await o.api.post('/api/v1/invoices/generate').send({ clientId: client.id, from: '2026-10-01', to: '2026-10-31' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('NOTHING_TO_INVOICE');
    // Validation & ownership
    await o.api.post('/api/v1/invoices/generate').send({ clientId: client.id, from: '2026-10-31', to: '2026-10-01' }).expect(400);
    await o.api.post('/api/v1/invoices/generate').send({ clientId: client.id, from: '2026-10-01', to: '2026-10-31', projectIds: [other.id] }).expect(400);
    await emp.api.post('/api/v1/invoices/generate').send({ clientId: client.id, from: '2026-10-01', to: '2026-10-31' }).expect(403);
  });

  it('numbers invoices sequentially, edits drafts and recomputes totals', async () => {
    const res = await o.api
      .post('/api/v1/invoices')
      .send({ clientId: client.id, items: [{ description: 'Setup fee', amount: 100 }, { description: 'Consulting', hours: 2, rate: 75 }], discountAmount: 50 })
      .expect(201);
    expect(res.body.data.number).toBe('INV-0002');
    expect(res.body.data.subtotal).toBe(250);
    expect(res.body.data.total).toBe(200);
    const p = await o.api.patch(`/api/v1/invoices/${res.body.data.id}`).send({ items: [{ description: 'Only', hours: 1, rate: 10 }], taxPercent: 20, discountAmount: 0 }).expect(200);
    expect(p.body.data.items).toHaveLength(1);
    expect(p.body.data.total).toBe(12);
    await o.api.delete(`/api/v1/invoices/${res.body.data.id}`).expect(204);
    await o.api.get(`/api/v1/invoices/${res.body.data.id}`).expect(404);
    const list = await o.api.get(`/api/v1/invoices?clientId=${client.id}`).expect(200);
    expect(list.body.meta.total).toBe(1);
  });

  it('sends with PDF attachment, records payments → partially_paid → paid', async () => {
    await o.api.post(`/api/v1/invoices/${inv1.id}/payments`).send({ amount: 10 }).expect(409); // draft
    const sent = await o.api.post(`/api/v1/invoices/${inv1.id}/send`).send({}).expect(200);
    expect(sent.body.data.status).toBe('sent');
    const mail = t.outbox.find((m) => m.to === 'billing@acme.test');
    expect(mail.attachments[0].content.subarray(0, 4).toString()).toBe('%PDF');
    await o.api.patch(`/api/v1/invoices/${inv1.id}`).send({ notes: 'x' }).expect(409);
    await o.api.delete(`/api/v1/invoices/${inv1.id}`).expect(409);

    const p1 = await o.api.post(`/api/v1/invoices/${inv1.id}/payments`).send({ amount: 40, method: 'bank', reference: 'TX1', paidAt: '2026-11-01' }).expect(201);
    expect(p1.body.data.status).toBe('partially_paid');
    expect(p1.body.data.balance).toBe(59);
    const over = await o.api.post(`/api/v1/invoices/${inv1.id}/payments`).send({ amount: 60 });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('PAYMENT_EXCEEDS_BALANCE');
    const p2 = await o.api.post(`/api/v1/invoices/${inv1.id}/payments`).send({ amount: 59 }).expect(201);
    expect(p2.body.data.status).toBe('paid');
    expect(p2.body.data.payments).toHaveLength(2);
    await o.api.post(`/api/v1/invoices/${inv1.id}/void`).expect(409);

    const pdf = await o.api.get(`/api/v1/invoices/${inv1.id}/pdf`).buffer(true).parse(binary).expect(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('void releases entries so they can be invoiced again; overdue cron flags late invoices', async () => {
    const e = await entry(emp.memberId, project.id, { date: '2026-08-03', hours: 4 });
    const g = await o.api.post('/api/v1/invoices/generate').send({ clientId: client.id, from: '2026-08-01', to: '2026-08-31', groupBy: 'task' }).expect(201);
    expect(g.body.data.items[0].description).toMatch(/General work/);
    expect((await db.one('SELECT invoice_id FROM time_entries WHERE id = $1', [e])).invoice_id).toBe(g.body.data.id);
    const v = await o.api.post(`/api/v1/invoices/${g.body.data.id}/void`).expect(200);
    expect(v.body.data.status).toBe('void');
    expect((await db.one('SELECT invoice_id FROM time_entries WHERE id = $1', [e])).invoice_id).toBeNull();
    const g2 = await o.api.post('/api/v1/invoices/generate').send({ clientId: client.id, from: '2026-08-01', to: '2026-08-31' }).expect(201);
    expect(g2.body.data.total).toBe(80);

    await o.api.post(`/api/v1/invoices/${g2.body.data.id}/send`).expect(200);
    await db.query(`UPDATE invoices SET due_date = current_date - 3 WHERE id = $1`, [g2.body.data.id]);
    await runCron('invoices.overdue');
    const got = await o.api.get(`/api/v1/invoices/${g2.body.data.id}`).expect(200);
    expect(got.body.data.status).toBe('overdue');
    const od = await o.api.get('/api/v1/invoices?overdue=true').expect(200);
    expect(od.body.data.map((i) => i.id)).toContain(g2.body.data.id);
  });

  it('enforces org isolation and the invoices plan feature', async () => {
    const o2 = await registerOrg(t);
    await o2.api.get(`/api/v1/invoices/${inv1.id}`).expect(404);
    await o2.api.post('/api/v1/invoices/generate').send({ clientId: client.id, from: '2026-10-01', to: '2026-10-31' }).expect(404);
    await db.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'free') WHERE organization_id = $1`, [o2.orgId]);
    const r = await o2.api.get('/api/v1/invoices');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
  });
});
