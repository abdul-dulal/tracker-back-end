import { db } from '../../lib/db.js';
import { registerCron } from '../../lib/jobs.js';
import { logger } from '../../lib/logger.js';
import { countActiveSeats } from './features.js';
import { noticeOwners, intervalSql, stripe, stripeKey } from './service.js';

const HOUR = 60 * 60_000;

/** SUB-15: trial ending in ≤3 days (once), trial ended → expired, local cancellations reaching period end. */
export async function subscriptionExpiry() {
  const ending = await db.many(
    `UPDATE subscriptions SET expiry_notice_sent_at = now()
     WHERE status = 'trialing' AND expiry_notice_sent_at IS NULL AND trial_ends_at > now() AND trial_ends_at <= now() + interval '3 days'
     RETURNING organization_id, trial_ends_at`,
  );
  for (const s of ending) {
    const days = Math.max(1, Math.ceil((new Date(s.trial_ends_at) - Date.now()) / 86_400_000));
    await noticeOwners(s.organization_id, 'Your trial is ending soon', `Your free trial ends in ${days} day${days === 1 ? '' : 's'}. Choose a plan to keep all features.`, {
      trialEndsAt: s.trial_ends_at,
    });
  }
  const expired = await db.many(
    `UPDATE subscriptions SET status = 'expired', updated_at = now()
     WHERE status = 'trialing' AND trial_ends_at <= now() AND stripe_subscription_id IS NULL RETURNING organization_id`,
  );
  for (const s of expired)
    await noticeOwners(s.organization_id, 'Your trial has ended', 'Your free trial has ended and the organization now has Free plan limits. Upgrade any time to restore all features.');
  // Locally managed (non-Stripe) cancellations reaching the end of the period.
  const canceled = await db.many(
    `UPDATE subscriptions SET status = 'canceled', canceled_at = coalesce(canceled_at, now()), cancel_at_period_end = false, updated_at = now()
     WHERE cancel_at_period_end AND current_period_end <= now() AND stripe_subscription_id IS NULL AND status IN ('active','past_due','trialing')
     RETURNING organization_id`,
  );
  for (const s of canceled) await noticeOwners(s.organization_id, 'Subscription ended', 'Your subscription has ended. The organization now has Free plan limits.');
  return { ending: ending.length, expired: expired.length, canceled: canceled.length };
}

/** SUB-10: apply scheduled downgrades at the end of the billing period. */
export async function applyPending() {
  const due = await db.many(
    `SELECT s.*, p.code AS pending_code, p.name AS pending_name, p.stripe_price_month_id, p.stripe_price_year_id FROM subscriptions s
     JOIN plans p ON p.id = s.pending_plan_id
     WHERE s.pending_plan_id IS NOT NULL AND s.current_period_end <= now()`,
  );
  for (const s of due) {
    const interval = s.pending_interval ?? s.billing_interval;
    const free = s.pending_code === 'free';
    await db.query(
      `UPDATE subscriptions SET plan_id = pending_plan_id, billing_interval = $2, pending_plan_id = NULL, pending_interval = NULL,
         status = CASE WHEN $3 THEN 'active' WHEN status = 'trialing' THEN 'expired' ELSE status END,
         trial_ends_at = CASE WHEN $3 THEN NULL ELSE trial_ends_at END,
         cancel_at_period_end = false,
         current_period_start = CASE WHEN $3 THEN NULL ELSE current_period_end END,
         current_period_end = CASE WHEN $3 THEN NULL ELSE current_period_end + ${intervalSql(interval)} END,
         updated_at = now()
       WHERE id = $1`,
      [s.id, interval, free],
    );
    if (s.stripe_subscription_id && stripeKey() && !free) {
      const pid = interval === 'year' ? s.stripe_price_year_id : s.stripe_price_month_id;
      try {
        if (pid) {
          const remote = await stripe('GET', `/subscriptions/${s.stripe_subscription_id}`);
          await stripe('POST', `/subscriptions/${s.stripe_subscription_id}`, {
            items: [{ id: remote?.items?.data?.[0]?.id, price: pid }],
            proration_behavior: 'none',
          });
        }
      } catch (err) {
        logger.error({ err, orgId: s.organization_id }, 'failed to apply downgrade in Stripe');
      }
    }
    await noticeOwners(s.organization_id, 'Plan changed', `Your organization is now on the ${s.pending_name} plan.`);
  }
  return due.length;
}

/** SUB-07: keep billed seat quantity in sync with active seats. */
export async function syncSeats() {
  const subs = await db.many(`SELECT id, organization_id, seats, stripe_subscription_id FROM subscriptions WHERE status IN ('active','trialing','past_due')`);
  for (const s of subs) {
    const used = Math.max(1, await countActiveSeats(s.organization_id));
    if (used === s.seats) continue;
    if (s.stripe_subscription_id && stripeKey()) {
      try {
        const remote = await stripe('GET', `/subscriptions/${s.stripe_subscription_id}`);
        await stripe('POST', `/subscriptions/${s.stripe_subscription_id}`, {
          items: [{ id: remote?.items?.data?.[0]?.id, quantity: used }],
          proration_behavior: 'create_prorations',
        });
      } catch (err) {
        logger.error({ err, orgId: s.organization_id }, 'failed to sync seats to Stripe');
        continue;
      }
    }
    await db.query('UPDATE subscriptions SET seats = $2, updated_at = now() WHERE id = $1', [s.id, used]);
  }
}

registerCron('subscription.expiry', HOUR, subscriptionExpiry);
registerCron('subscription.apply_pending', HOUR, applyPending);
registerCron('subscription.sync_seats', 6 * HOUR, syncSeats);
