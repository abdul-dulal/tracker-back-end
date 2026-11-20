import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { stripeWebhookSecret, verifyStripeSignature, noticeOwners, intervalSql } from './service.js';

/**
 * Stripe webhook (SUB-14). app.js keeps the raw body for /api/v1/webhooks/* (req.rawBody), so the
 * Stripe-Signature header (t=…,v1=… HMAC-SHA256 of `${t}.${rawBody}`) is verified with
 * STRIPE_WEBHOOK_SECRET (5-minute tolerance, timing-safe). Idempotent via processed_webhook_events.
 * The subscription module sorts before webhooks, so this '/stripe' route is matched before the
 * outbound webhooks router (whose ids are uuids anyway).
 */
const r = createRouter('/webhooks', 'Subscription');

const STATUS = { trialing: 'trialing', active: 'active', past_due: 'past_due', unpaid: 'past_due', incomplete: 'past_due', canceled: 'canceled', incomplete_expired: 'expired', paused: 'past_due' };
const ts = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);
const amount = (cents) => Math.round(Number(cents ?? 0)) / 100;

async function orgForStripe({ metadata, customer, subscription }) {
  if (metadata?.organizationId) {
    const o = await db.one('SELECT organization_id FROM subscriptions WHERE organization_id = $1', [metadata.organizationId]);
    if (o) return o.organization_id;
  }
  const row = await db.one(
    `SELECT organization_id FROM subscriptions WHERE ($1::text IS NOT NULL AND stripe_subscription_id = $1) OR ($2::text IS NOT NULL AND stripe_customer_id = $2) LIMIT 1`,
    [typeof subscription === 'string' ? subscription : (subscription?.id ?? null), typeof customer === 'string' ? customer : (customer?.id ?? null)],
  );
  return row?.organization_id ?? null;
}

async function planIdFor(sub) {
  const price = sub.items?.data?.[0]?.price?.id;
  if (price) {
    const p = await db.one('SELECT id FROM plans WHERE stripe_price_month_id = $1 OR stripe_price_year_id = $1', [price]);
    if (p) return p.id;
  }
  if (sub.metadata?.planCode) return (await db.one('SELECT id FROM plans WHERE code = $1', [sub.metadata.planCode]))?.id ?? null;
  return null;
}

const handlers = {
  async 'checkout.session.completed'(obj) {
    const orgId = obj.metadata?.organizationId ?? obj.client_reference_id;
    if (!orgId || obj.mode !== 'subscription') return;
    const plan = obj.metadata?.planCode ? await db.one('SELECT * FROM plans WHERE code = $1', [obj.metadata.planCode]) : null;
    const interval = obj.metadata?.interval === 'year' ? 'year' : 'month';
    await db.query(
      `UPDATE subscriptions SET plan_id = coalesce($2, plan_id), billing_interval = $3, status = 'active', trial_ends_at = NULL,
         stripe_customer_id = coalesce($4, stripe_customer_id), stripe_subscription_id = coalesce($5, stripe_subscription_id),
         current_period_start = now(), current_period_end = now() + ${intervalSql(interval)}, cancel_at_period_end = false, canceled_at = NULL,
         pending_plan_id = NULL, pending_interval = NULL, updated_at = now()
       WHERE organization_id = $1`,
      [orgId, plan?.id ?? null, interval, obj.customer ?? null, typeof obj.subscription === 'string' ? obj.subscription : (obj.subscription?.id ?? null)],
    );
    await noticeOwners(orgId, 'Subscription activated', `Your ${plan?.name ?? ''} subscription is now active. Thank you!`.replace('  ', ' '));
    return orgId;
  },
  async 'customer.subscription.updated'(obj) {
    const orgId = await orgForStripe({ metadata: obj.metadata, customer: obj.customer, subscription: obj.id });
    if (!orgId) return;
    const item = obj.items?.data?.[0];
    const planId = await planIdFor(obj);
    const interval = item?.price?.recurring?.interval === 'year' ? 'year' : item?.price?.recurring?.interval === 'month' ? 'month' : null;
    await db.query(
      `UPDATE subscriptions SET status = $2, plan_id = coalesce($3, plan_id), billing_interval = coalesce($4, billing_interval),
         seats = coalesce($5, seats), current_period_start = coalesce($6, current_period_start), current_period_end = coalesce($7, current_period_end),
         cancel_at_period_end = $8, trial_ends_at = $9, stripe_subscription_id = $10, stripe_customer_id = coalesce($11, stripe_customer_id), updated_at = now()
       WHERE organization_id = $1`,
      [
        orgId,
        STATUS[obj.status] ?? 'active',
        planId,
        interval,
        item?.quantity ?? obj.quantity ?? null,
        ts(obj.current_period_start ?? item?.current_period_start),
        ts(obj.current_period_end ?? item?.current_period_end),
        !!obj.cancel_at_period_end,
        ts(obj.trial_end),
        obj.id,
        typeof obj.customer === 'string' ? obj.customer : null,
      ],
    );
    return orgId;
  },
  async 'customer.subscription.deleted'(obj) {
    const orgId = await orgForStripe({ metadata: obj.metadata, customer: obj.customer, subscription: obj.id });
    if (!orgId) return;
    await db.query(
      `UPDATE subscriptions SET status = 'canceled', canceled_at = coalesce(canceled_at, now()), cancel_at_period_end = false, pending_plan_id = NULL, pending_interval = NULL, updated_at = now()
       WHERE organization_id = $1`,
      [orgId],
    );
    await noticeOwners(orgId, 'Subscription ended', 'Your subscription has ended. Your organization now has Free plan limits.');
    return orgId;
  },
  async 'invoice.paid'(obj) {
    const orgId = await orgForStripe({ metadata: obj.subscription_details?.metadata ?? obj.metadata, customer: obj.customer, subscription: obj.subscription });
    if (!orgId) return;
    await upsertInvoice(orgId, obj, 'paid');
    await db.query(
      `INSERT INTO subscription_payments (organization_id, stripe_payment_intent_id, amount, currency, status, paid_at)
       VALUES ($1,$2,$3,$4,'succeeded', coalesce($5::timestamptz, now()))
       ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = 'succeeded', paid_at = EXCLUDED.paid_at, failure_reason = NULL`,
      [orgId, paymentRef(obj), amount(obj.amount_paid ?? obj.total), String(obj.currency ?? 'usd').toUpperCase(), ts(obj.status_transitions?.paid_at)],
    );
    await db.query(`UPDATE subscriptions SET status = 'active', updated_at = now() WHERE organization_id = $1 AND status = 'past_due'`, [orgId]);
    await db.query(`UPDATE system_alerts SET resolved_at = now() WHERE organization_id = $1 AND type = 'payment_failed' AND resolved_at IS NULL`, [orgId]);
    return orgId;
  },
  async 'invoice.payment_failed'(obj) {
    const orgId = await orgForStripe({ metadata: obj.subscription_details?.metadata ?? obj.metadata, customer: obj.customer, subscription: obj.subscription });
    if (!orgId) return;
    await upsertInvoice(orgId, obj, obj.status ?? 'open');
    const reason = obj.last_finalization_error?.message ?? obj.last_payment_error?.message ?? 'Payment failed';
    await db.query(
      `INSERT INTO subscription_payments (organization_id, stripe_payment_intent_id, amount, currency, status, failure_reason)
       VALUES ($1,$2,$3,$4,'failed',$5)
       ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = 'failed', failure_reason = EXCLUDED.failure_reason`,
      [orgId, paymentRef(obj), amount(obj.amount_due ?? obj.total), String(obj.currency ?? 'usd').toUpperCase(), reason],
    );
    await db.query(`UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE organization_id = $1 AND status IN ('active','trialing')`, [orgId]);
    await db.query(
      `INSERT INTO system_alerts (organization_id, type, severity, message, data) VALUES ($1,'payment_failed','critical',$2,$3) ON CONFLICT DO NOTHING`,
      [orgId, 'Subscription payment failed', db.json({ invoice: obj.id })],
    );
    await noticeOwners(orgId, 'Payment failed', `We could not charge your payment method (${reason}). Please update your billing details.`, { invoiceId: obj.id });
    return orgId;
  },
};

const paymentRef = (obj) => (typeof obj.payment_intent === 'string' ? obj.payment_intent : (obj.payment_intent?.id ?? `inv_${obj.id}`));

async function upsertInvoice(orgId, obj, status) {
  const line = obj.lines?.data?.[0]?.period;
  await db.query(
    `INSERT INTO subscription_invoices (organization_id, stripe_invoice_id, number, amount, currency, status, hosted_url, pdf_url, period_start, period_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (stripe_invoice_id) DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount, number = coalesce(EXCLUDED.number, subscription_invoices.number),
       hosted_url = coalesce(EXCLUDED.hosted_url, subscription_invoices.hosted_url), pdf_url = coalesce(EXCLUDED.pdf_url, subscription_invoices.pdf_url)`,
    [
      orgId,
      obj.id,
      obj.number ?? null,
      amount(status === 'paid' ? (obj.amount_paid ?? obj.total) : (obj.amount_due ?? obj.total)),
      String(obj.currency ?? 'usd').toUpperCase(),
      status,
      obj.hosted_invoice_url ?? null,
      obj.invoice_pdf ?? null,
      ts(obj.period_start ?? line?.start),
      ts(obj.period_end ?? line?.end),
    ],
  );
}

r.post('/stripe', { auth: 'public', summary: 'Stripe webhook (signature verified, idempotent)', ids: 'SUB-14' }, async (req, res) => {
  const secret = stripeWebhookSecret();
  if (!secret) throw new AppError(501, 'PAYMENTS_NOT_CONFIGURED', 'Stripe webhooks are not configured');
  if (!verifyStripeSignature(req.rawBody, req.get('stripe-signature'), secret))
    throw badRequest('Invalid Stripe signature', undefined, 'INVALID_SIGNATURE');
  const event = req.body;
  if (!event?.id || !event?.type) throw badRequest('Malformed event', undefined, 'INVALID_EVENT');
  const result = await db.tx(async () => {
    const fresh = await db.one(
      `INSERT INTO processed_webhook_events (provider, event_id) VALUES ('stripe', $1) ON CONFLICT DO NOTHING RETURNING event_id`,
      [event.id],
    );
    if (!fresh) return { duplicate: true };
    const h = handlers[event.type];
    const orgId = h ? await h(event.data?.object ?? {}) : null;
    if (orgId) await audit({ orgId, actorType: 'system' }, `stripe.${event.type}`, { entityType: 'subscription', after: { eventId: event.id } });
    return { handled: !!h };
  });
  ok(res, { received: true, ...result });
});

export default r;
