import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { setupApp, registerOrg, addMember, request, db } from './helpers.js';
import { runCron } from '../src/lib/jobs.js';

let t;
beforeAll(async () => {
  t = await setupApp();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

const sub = (orgId) => db.one('SELECT s.*, p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE organization_id = $1', [orgId]);
const jsonResp = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stripeEvent(secret, event, { t: ts = Math.floor(Date.now() / 1000), badSig = false } = {}) {
  const payload = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return request(t.app)
    .post('/api/v1/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', `t=${ts},v1=${badSig ? sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a') : sig}`)
    .send(payload);
}

describe('Plans & subscription read (SUB-01…08, 16…21)', () => {
  it('lists public plans and the current trial subscription, usage and features', async () => {
    const plans = await request(t.app).get('/api/v1/plans').expect(200);
    expect(plans.body.data.map((p) => p.code)).toEqual(['free', 'starter', 'professional', 'enterprise']);
    const o = await registerOrg(t);
    const s = await o.api.get('/api/v1/subscription').expect(200);
    expect(s.body.data).toMatchObject({ plan: { code: 'professional' }, status: 'trialing', interval: 'month', seats: { used: 1, limit: 500 } });
    expect(s.body.data.trialEndsAt).toBeTruthy();
    const u = await o.api.get('/api/v1/subscription/usage').expect(200);
    expect(u.body.data.seats).toEqual({ used: 1, limit: 500 });
    expect(u.body.data.storage.limitGb).toBe(250);
    expect(u.body.data.screenshots.planRetentionDays).toBe(180);
    const f = await o.api.get('/api/v1/subscription/features').expect(200);
    expect(f.body.data.features.integrations).toBe(true);
    const emp = await addMember(t, o, { role: 'employee' });
    await emp.api.get('/api/v1/subscription').expect(403);
    await emp.api.post('/api/v1/subscription/cancel').send({}).expect(403);
  });
});

describe('Plan changes (SUB-09…11, SUB-21)', () => {
  it('dev-mode checkout applies the plan directly', async () => {
    const o = await registerOrg(t);
    const r = await o.api.post('/api/v1/subscription/checkout').send({ planCode: 'starter', interval: 'year' }).expect(200);
    expect(r.body.data).toMatchObject({ applied: true, devMode: true, url: null });
    const s = await sub(o.orgId);
    expect(s).toMatchObject({ code: 'starter', status: 'active', billing_interval: 'year', trial_ends_at: null });
    expect(new Date(s.current_period_end) - Date.now()).toBeGreaterThan(360 * 86_400_000);
    expect((await o.api.post('/api/v1/subscription/checkout').send({ planCode: 'enterprise' })).status).toBe(422);
    expect((await o.api.post('/api/v1/subscription/checkout').send({ planCode: 'gold' })).status).toBe(400);
    const audit = await db.one(`SELECT 1 AS ok FROM audit_logs WHERE organization_id = $1 AND action = 'subscription.checkout_dev'`, [o.orgId]);
    expect(audit).toBeTruthy();
  });

  it('Stripe checkout creates a session with per-seat quantity (mocked)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    const o = await registerOrg(t);
    await addMember(t, o, { role: 'employee' });
    const fetchMock = vi.fn(async () => jsonResp({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await o.api.post('/api/v1/subscription/checkout').send({ planCode: 'professional', interval: 'month' }).expect(200);
    expect(r.body.data.url).toBe('https://checkout.stripe.com/c/cs_1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.headers.Authorization).toBe('Bearer sk_test_123');
    const form = new URLSearchParams(init.body);
    expect(form.get('mode')).toBe('subscription');
    expect(form.get('line_items[0][quantity]')).toBe('2');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('900');
    expect(form.get('metadata[organizationId]')).toBe(o.orgId);
    // portal without a customer
    expect((await o.api.post('/api/v1/subscription/portal')).body.error.code).toBe('NO_BILLING_ACCOUNT');
  });

  it('portal returns 501 when payments are not configured', async () => {
    const o = await registerOrg(t);
    const r = await o.api.post('/api/v1/subscription/portal');
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('PAYMENTS_NOT_CONFIGURED');
  });

  it('downgrade validates usage, schedules at period end and the cron applies it', async () => {
    const o = await registerOrg(t);
    for (let i = 0; i < 3; i++) await addMember(t, o, { role: 'employee' });
    const tooMany = await o.api.post('/api/v1/subscription/change').send({ planCode: 'free' });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(tooMany.body.error.details.problems[0]).toMatchObject({ limit: 'seats', used: 4, max: 3 });
    // storage check
    await db.query(`INSERT INTO usage_counters (organization_id, metric, value) VALUES ($1,'storage_bytes',$2) ON CONFLICT (organization_id, metric) DO UPDATE SET value = EXCLUDED.value`, [o.orgId, 30 * 1024 ** 3]);
    const storage = await o.api.post('/api/v1/subscription/change').send({ planCode: 'starter' });
    expect(storage.status).toBe(422);
    expect(storage.body.error.details.problems.map((p) => p.limit)).toContain('storage');
    await db.query(`UPDATE usage_counters SET value = 0 WHERE organization_id = $1`, [o.orgId]);

    const ok = await o.api.post('/api/v1/subscription/change').send({ planCode: 'starter' }).expect(200);
    expect(ok.body.data.scheduled).toBe(true);
    expect(ok.body.data.subscription.pendingChange.plan.code).toBe('starter');
    expect((await sub(o.orgId)).code).toBe('professional');
    await runCron('subscription.apply_pending');
    expect((await sub(o.orgId)).code).toBe('professional'); // not yet due
    await db.query(`UPDATE subscriptions SET current_period_end = now() - interval '1 minute' WHERE organization_id = $1`, [o.orgId]);
    await runCron('subscription.apply_pending');
    const s = await sub(o.orgId);
    expect(s.code).toBe('starter');
    expect(s.pending_plan_id).toBeNull();
  });

  it('upgrade during trial is immediate; cancel/resume toggle cancel_at_period_end', async () => {
    const o = await registerOrg(t);
    await o.api.post('/api/v1/subscription/checkout').send({ planCode: 'starter' }).expect(200);
    const up = await o.api.post('/api/v1/subscription/change').send({ planCode: 'professional' }).expect(200);
    expect(up.body.data.scheduled).toBe(false);
    expect((await sub(o.orgId)).code).toBe('professional');
    expect((await o.api.post('/api/v1/subscription/change').send({ planCode: 'professional' })).body.error.code).toBe('NO_CHANGE');
    await o.api.post('/api/v1/subscription/resume').expect(409);
    const c = await o.api.post('/api/v1/subscription/cancel').send({ reason: 'too expensive' }).expect(200);
    expect(c.body.data.cancelAtPeriodEnd).toBe(true);
    const n = await db.one(`SELECT count(*)::int AS n FROM notifications WHERE organization_id = $1 AND type = 'subscription.notice'`, [o.orgId]);
    expect(n.n).toBeGreaterThan(0);
    const r = await o.api.post('/api/v1/subscription/resume').expect(200);
    expect(r.body.data.cancelAtPeriodEnd).toBe(false);
  });
});

describe('Stripe webhook (SUB-14)', () => {
  it('verifies signatures, is idempotent and updates subscription/invoices/payments', async () => {
    const secret = 'whsec_test_abc';
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    const o = await registerOrg(t);
    const evt = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', client_reference_id: o.orgId, customer: 'cus_1', subscription: 'sub_1', metadata: { organizationId: o.orgId, planCode: 'starter', interval: 'month' } } },
    };
    const bad = await stripeEvent(secret, evt, { badSig: true });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_SIGNATURE');
    const stale = await stripeEvent(secret, evt, { t: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.status).toBe(400);

    const first = await stripeEvent(secret, evt).expect(200);
    expect(first.body.data).toMatchObject({ received: true, handled: true });
    let s = await sub(o.orgId);
    expect(s).toMatchObject({ code: 'starter', status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' });
    const dup = await stripeEvent(secret, evt).expect(200);
    expect(dup.body.data.duplicate).toBe(true);

    const nBefore = (await db.one(`SELECT count(*)::int AS n FROM notifications WHERE organization_id = $1 AND type = 'subscription.notice'`, [o.orgId])).n;
    const failed = {
      id: 'evt_2',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_1', customer: 'cus_1', subscription: 'sub_1', amount_due: 1000, currency: 'usd', status: 'open', payment_intent: 'pi_1', number: 'A-1' } },
    };
    await stripeEvent(secret, failed).expect(200);
    await stripeEvent(secret, failed).expect(200); // replay ignored
    s = await sub(o.orgId);
    expect(s.status).toBe('past_due');
    const nAfter = (await db.one(`SELECT count(*)::int AS n FROM notifications WHERE organization_id = $1 AND type = 'subscription.notice'`, [o.orgId])).n;
    expect(nAfter).toBe(nBefore + 1);
    expect(await db.one(`SELECT 1 AS ok FROM system_alerts WHERE organization_id = $1 AND type = 'payment_failed' AND resolved_at IS NULL`, [o.orgId])).toBeTruthy();

    await stripeEvent(secret, {
      id: 'evt_3',
      type: 'invoice.paid',
      data: { object: { id: 'in_1', customer: 'cus_1', subscription: 'sub_1', amount_paid: 1000, currency: 'usd', status: 'paid', payment_intent: 'pi_1', number: 'A-1', hosted_invoice_url: 'https://pay.stripe.com/i/1' } },
    }).expect(200);
    s = await sub(o.orgId);
    expect(s.status).toBe('active');
    const inv = await o.api.get('/api/v1/subscription/invoices').expect(200);
    expect(inv.body.data).toHaveLength(1);
    expect(inv.body.data[0]).toMatchObject({ number: 'A-1', amount: 10, currency: 'USD', status: 'paid', hostedUrl: 'https://pay.stripe.com/i/1' });
    const pay = await o.api.get('/api/v1/subscription/payments').expect(200);
    expect(pay.body.data).toHaveLength(1);
    expect(pay.body.data[0]).toMatchObject({ status: 'succeeded', amount: 10 });

    await stripeEvent(secret, {
      id: 'evt_4',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: true, current_period_end: Math.floor(Date.now() / 1000) + 86400 * 20, items: { data: [{ quantity: 7, price: { id: 'price_x', recurring: { interval: 'year' } } }] }, metadata: {} } },
    }).expect(200);
    s = await sub(o.orgId);
    expect(s).toMatchObject({ cancel_at_period_end: true, seats: 7, billing_interval: 'year' });
    await stripeEvent(secret, { id: 'evt_5', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1' } } }).expect(200);
    expect((await sub(o.orgId)).status).toBe('canceled');
    const processed = await db.one(`SELECT count(*)::int AS n FROM processed_webhook_events WHERE provider = 'stripe'`);
    expect(processed.n).toBe(5);
  });

  it('returns 501 when the webhook secret is not configured', async () => {
    const r = await request(t.app).post('/api/v1/webhooks/stripe').send({ id: 'evt_x', type: 'x' });
    expect(r.status).toBe(501);
  });
});

describe('Subscription crons (SUB-15)', () => {
  it('sends the trial-ending notice once and expires ended trials', async () => {
    const o = await registerOrg(t);
    await db.query(`UPDATE subscriptions SET trial_ends_at = now() + interval '2 days' WHERE organization_id = $1`, [o.orgId]);
    await runCron('subscription.expiry');
    await runCron('subscription.expiry');
    const n = await db.many(`SELECT title FROM notifications WHERE organization_id = $1 AND type = 'subscription.notice'`, [o.orgId]);
    expect(n.map((x) => x.title)).toEqual(['Your trial is ending soon']);
    await db.query(`UPDATE subscriptions SET trial_ends_at = now() - interval '1 hour' WHERE organization_id = $1`, [o.orgId]);
    await runCron('subscription.expiry');
    expect((await sub(o.orgId)).status).toBe('expired');
    const f = await o.api.get('/api/v1/subscription/features').expect(200);
    expect(f.body.data).toMatchObject({ plan: 'free', expired: true });
    const n2 = await db.many(`SELECT title FROM notifications WHERE organization_id = $1 AND type = 'subscription.notice' ORDER BY created_at`, [o.orgId]);
    expect(n2.map((x) => x.title)).toContain('Your trial has ended');
  });
});
