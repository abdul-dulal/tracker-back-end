import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, paginationQuery, pageMeta } from '../../lib/http.js';
import { badRequest, conflict, forbidden, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { getOrgPlan, countActiveSeats, maxScreenshotRetentionDays } from './features.js';
import { PLAN_CODES } from './catalog.js';
import {
  stripe,
  stripeKey,
  devMode,
  paymentsNotConfigured,
  loadPlanByCode,
  loadSubscription,
  assertFitsPlan,
  applyPlanNow,
  storageUsedBytes,
  subscriptionDto,
  noticeOwners,
} from './service.js';

/** Organization subscription management (SUB-05…SUB-21, F.16). */
const r = createRouter('/subscription', 'Subscription');
const MANAGE = 'subscription.manage';
/** Read access: subscription.manage or owner/admin. */
const canRead = (req, _res, next) => {
  if (!req.ctx.can(MANAGE) && !req.ctx.isAdminLike()) throw forbidden('Owner or admin only');
  next();
};
const planBody = z.object({ planCode: z.enum(PLAN_CODES), interval: z.enum(['month', 'year']).optional() });
const priceId = (plan, interval) => plan[interval === 'year' ? 'stripe_price_year_id' : 'stripe_price_month_id'];
const selfServe = (plan) => !(plan.code === 'enterprise' && Number(plan.price_month) === 0 && Number(plan.price_year) === 0);

r.get('/', { summary: 'Current subscription', ids: 'SUB-21, SUB-08, SUB-17', middleware: canRead }, async (req, res) => {
  ok(res, await subscriptionDto(req.ctx.orgId));
});

r.get('/usage', { summary: 'Usage vs plan limits', ids: 'SUB-16…SUB-19', middleware: canRead }, async (req, res) => {
  const plan = await getOrgPlan(req.ctx.orgId);
  const seats = await countActiveSeats(req.ctx.orgId);
  const bytes = await storageUsedBytes(req.ctx.orgId);
  const gb = plan.limits?.storageGb ?? null;
  const shots = Number((await db.one(`SELECT value FROM usage_counters WHERE organization_id = $1 AND metric = 'screenshots'`, [req.ctx.orgId]))?.value ?? 0);
  const setting = await db.one(`SELECT screenshot_retention_days FROM tracking_settings WHERE organization_id = $1 AND scope_type = 'org' LIMIT 1`, [req.ctx.orgId]).catch(() => null);
  const planMax = await maxScreenshotRetentionDays(req.ctx.orgId);
  const orgDays = setting?.screenshot_retention_days ?? null;
  ok(res, {
    plan: plan.effectiveCode ?? plan.code,
    seats: { used: seats, limit: plan.limits?.maxSeats ?? null },
    storage: {
      usedBytes: bytes,
      limitGb: gb,
      limitBytes: gb === null ? null : gb * 1024 ** 3,
      percent: gb ? Math.min(100, Math.round((bytes / (gb * 1024 ** 3)) * 1000) / 10) : null,
    },
    screenshots: {
      count: shots,
      planRetentionDays: planMax,
      orgRetentionDays: orgDays,
      effectiveRetentionDays: planMax === null ? orgDays : orgDays === null ? planMax : Math.min(planMax, orgDays),
    },
  });
});

r.get('/features', { auth: 'org', summary: 'Plan features & limits', ids: 'SUB-20' }, async (req, res) => {
  const plan = await getOrgPlan(req.ctx.orgId);
  ok(res, { plan: plan.effectiveCode ?? plan.code, expired: !!plan.expired, features: plan.features ?? {}, limits: plan.limits ?? {} });
});

r.post('/checkout', { summary: 'Start Stripe Checkout (dev mode applies the plan directly)', ids: 'SUB-05…SUB-07, SUB-14', permission: MANAGE, body: planBody }, async (req, res) => {
  const ctx = req.ctx;
  const plan = await loadPlanByCode(req.body.planCode);
  const interval = req.body.interval ?? 'month';
  if (plan.code === 'free') throw badRequest('Use POST /subscription/change to move to the free plan', undefined, 'INVALID_PLAN');
  if (!selfServe(plan)) throw unprocessable('CONTACT_SALES', 'The Enterprise plan is sold via our sales team');
  const sub = await loadSubscription(ctx.orgId);
  if (!stripeKey()) {
    if (!devMode()) throw paymentsNotConfigured();
    await assertFitsPlan(ctx.orgId, plan);
    await applyPlanNow(ctx.orgId, plan, interval);
    await audit(ctx, 'subscription.checkout_dev', { entityType: 'subscription', entityId: sub?.id, before: { plan: sub?.plan_code, status: sub?.status }, after: { plan: plan.code, interval } });
    return ok(res, { url: null, applied: true, devMode: true, subscription: await subscriptionDto(ctx.orgId) });
  }
  const quantity = Math.max(1, await countActiveSeats(ctx.orgId));
  const owner = await db.one('SELECT u.email FROM organizations o JOIN users u ON u.id = o.owner_user_id WHERE o.id = $1', [ctx.orgId]);
  const pid = priceId(plan, interval);
  const unit = Math.round(Number(interval === 'year' ? plan.price_year : plan.price_month) * 100);
  const lineItem = pid
    ? { price: pid, quantity }
    : { quantity, price_data: { currency: plan.currency.toLowerCase(), unit_amount: unit, recurring: { interval }, product_data: { name: `Tracker ${plan.name}` } } };
  const meta = { organizationId: ctx.orgId, planCode: plan.code, interval };
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription',
    line_items: [lineItem],
    success_url: `${env.FRONTEND_URL}/settings/subscription?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.FRONTEND_URL}/settings/subscription?checkout=cancelled`,
    client_reference_id: ctx.orgId,
    customer: sub?.stripe_customer_id ?? undefined,
    customer_email: sub?.stripe_customer_id ? undefined : owner?.email,
    metadata: meta,
    subscription_data: { metadata: meta },
    allow_promotion_codes: 'true',
  });
  await audit(ctx, 'subscription.checkout', { entityType: 'subscription', entityId: sub?.id, after: { plan: plan.code, interval, sessionId: session.id } });
  ok(res, { url: session.url, sessionId: session.id });
});

r.post('/change', { summary: 'Change plan (upgrade now, downgrade at period end)', ids: 'SUB-09, SUB-10', permission: MANAGE, body: planBody }, async (req, res) => {
  const ctx = req.ctx;
  const sub = await loadSubscription(ctx.orgId);
  if (!sub) throw badRequest('No subscription', undefined, 'NO_SUBSCRIPTION');
  const target = await loadPlanByCode(req.body.planCode);
  const interval = req.body.interval ?? sub.billing_interval;
  if (target.id === sub.plan_id && interval === sub.billing_interval && !sub.pending_plan_id) throw badRequest('You are already on this plan', undefined, 'NO_CHANGE');
  if (!selfServe(target)) throw unprocessable('CONTACT_SALES', 'The Enterprise plan is sold via our sales team');
  const upgrade = target.sort_order > sub.plan_rank || (target.id === sub.plan_id && interval === 'year' && sub.billing_interval === 'month');
  const before = { plan: sub.plan_code, interval: sub.billing_interval, status: sub.status };

  if (!upgrade) {
    await assertFitsPlan(ctx.orgId, target);
    const ended = ['expired', 'canceled'].includes(sub.status) || !sub.current_period_end || new Date(sub.current_period_end) <= new Date();
    if (ended) {
      await applyPlanNow(ctx.orgId, target, interval);
    } else {
      await db.query(
        `UPDATE subscriptions SET pending_plan_id = $2, pending_interval = $3, updated_at = now() WHERE organization_id = $1`,
        [ctx.orgId, target.id === sub.plan_id && interval === sub.billing_interval ? null : target.id, interval],
      );
      if (sub.stripe_subscription_id && target.code === 'free')
        await stripe('POST', `/subscriptions/${sub.stripe_subscription_id}`, { cancel_at_period_end: 'true' });
    }
    await audit(ctx, 'subscription.downgrade', { entityType: 'subscription', entityId: sub.id, before, after: { plan: target.code, interval, scheduled: !ended } });
    return ok(res, { scheduled: !ended, subscription: await subscriptionDto(ctx.orgId) });
  }

  // Upgrade → immediate.
  await assertFitsPlan(ctx.orgId, target);
  if (sub.stripe_subscription_id) {
    const pid = priceId(target, interval);
    if (!pid) throw unprocessable('PLAN_NOT_PURCHASABLE', 'This plan has no Stripe price configured');
    const remote = await stripe('GET', `/subscriptions/${sub.stripe_subscription_id}`);
    const item = remote?.items?.data?.[0];
    await stripe('POST', `/subscriptions/${sub.stripe_subscription_id}`, {
      items: [{ id: item?.id, price: pid, quantity: Math.max(1, await countActiveSeats(ctx.orgId)) }],
      proration_behavior: 'create_prorations',
      cancel_at_period_end: 'false',
      metadata: { organizationId: ctx.orgId, planCode: target.code, interval },
    });
    await db.query(
      `UPDATE subscriptions SET plan_id = $2, billing_interval = $3, pending_plan_id = NULL, pending_interval = NULL, cancel_at_period_end = false, updated_at = now()
       WHERE organization_id = $1`,
      [ctx.orgId, target.id, interval],
    );
  } else if (sub.status === 'trialing' && sub.trial_ends_at && new Date(sub.trial_ends_at) > new Date()) {
    await applyPlanNow(ctx.orgId, target, interval, { keepTrial: true });
  } else if (devMode()) {
    await applyPlanNow(ctx.orgId, target, interval);
  } else if (stripeKey()) {
    throw conflict('CHECKOUT_REQUIRED', 'Start a checkout session to purchase this plan');
  } else {
    throw paymentsNotConfigured();
  }
  await audit(ctx, 'subscription.upgrade', { entityType: 'subscription', entityId: sub.id, before, after: { plan: target.code, interval } });
  ok(res, { scheduled: false, subscription: await subscriptionDto(ctx.orgId) });
});

r.post('/cancel', { summary: 'Cancel at period end', ids: 'SUB-11', permission: MANAGE, body: z.object({ reason: z.string().max(500).optional() }).optional() }, async (req, res) => {
  const sub = await loadSubscription(req.ctx.orgId);
  if (!sub || ['canceled', 'expired'].includes(sub.status)) throw conflict('NOT_ACTIVE', 'There is no active subscription to cancel');
  if (sub.stripe_subscription_id) await stripe('POST', `/subscriptions/${sub.stripe_subscription_id}`, { cancel_at_period_end: 'true' });
  await db.query(`UPDATE subscriptions SET cancel_at_period_end = true, canceled_at = now(), updated_at = now() WHERE id = $1`, [sub.id]);
  await audit(req.ctx, 'subscription.cancel', { entityType: 'subscription', entityId: sub.id, after: { reason: req.body?.reason ?? null } });
  await noticeOwners(req.ctx.orgId, 'Subscription canceled', `Your subscription will end on ${sub.current_period_end ? new Date(sub.current_period_end).toDateString() : 'the end of the period'}.`);
  ok(res, await subscriptionDto(req.ctx.orgId));
});

r.post('/resume', { summary: 'Undo a pending cancellation', ids: 'SUB-11', permission: MANAGE }, async (req, res) => {
  const sub = await loadSubscription(req.ctx.orgId);
  if (!sub || ['canceled', 'expired'].includes(sub.status)) throw conflict('CHECKOUT_REQUIRED', 'The subscription has ended; start a new checkout');
  if (!sub.cancel_at_period_end) throw conflict('NOT_CANCELED', 'The subscription is not scheduled for cancellation');
  if (sub.stripe_subscription_id) await stripe('POST', `/subscriptions/${sub.stripe_subscription_id}`, { cancel_at_period_end: 'false' });
  await db.query(`UPDATE subscriptions SET cancel_at_period_end = false, canceled_at = NULL, updated_at = now() WHERE id = $1`, [sub.id]);
  await audit(req.ctx, 'subscription.resume', { entityType: 'subscription', entityId: sub.id });
  ok(res, await subscriptionDto(req.ctx.orgId));
});

r.post('/portal', { summary: 'Stripe customer portal session', ids: 'SUB-14', permission: MANAGE }, async (req, res) => {
  if (!stripeKey()) throw paymentsNotConfigured();
  const sub = await loadSubscription(req.ctx.orgId);
  if (!sub?.stripe_customer_id) throw conflict('NO_BILLING_ACCOUNT', 'No billing account yet — complete a checkout first');
  const session = await stripe('POST', '/billing_portal/sessions', { customer: sub.stripe_customer_id, return_url: `${env.FRONTEND_URL}/settings/subscription` });
  ok(res, { url: session.url });
});

const listQuery = paginationQuery.pick({ page: true, limit: true });

r.get('/invoices', { summary: 'Invoice history', ids: 'SUB-13', middleware: canRead, query: listQuery }, async (req, res) => {
  const q = req.v.query;
  const total = (await db.one('SELECT count(*)::int AS n FROM subscription_invoices WHERE organization_id = $1', [req.ctx.orgId])).n;
  const rows = await db.many(
    `SELECT * FROM subscription_invoices WHERE organization_id = $1 ORDER BY created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    [req.ctx.orgId],
  );
  ok(
    res,
    rows.map((i) => ({
      id: i.id,
      number: i.number,
      amount: Number(i.amount),
      currency: i.currency,
      status: i.status,
      hostedUrl: i.hosted_url,
      pdfUrl: i.pdf_url,
      periodStart: i.period_start,
      periodEnd: i.period_end,
      createdAt: i.created_at,
    })),
    pageMeta(q, total),
  );
});

r.get('/payments', { summary: 'Payment history', ids: 'SUB-12', middleware: canRead, query: listQuery }, async (req, res) => {
  const q = req.v.query;
  const total = (await db.one('SELECT count(*)::int AS n FROM subscription_payments WHERE organization_id = $1', [req.ctx.orgId])).n;
  const rows = await db.many(
    `SELECT * FROM subscription_payments WHERE organization_id = $1 ORDER BY created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    [req.ctx.orgId],
  );
  ok(
    res,
    rows.map((p) => ({ id: p.id, amount: Number(p.amount), currency: p.currency, status: p.status, paidAt: p.paid_at, failureReason: p.failure_reason, createdAt: p.created_at })),
    pageMeta(q, total),
  );
});

export default r;
