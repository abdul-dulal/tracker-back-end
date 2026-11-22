import crypto from 'node:crypto';
import { db } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { isProd } from '../../config/env.js';
import { notify } from '../notifications/service.js';
import { countActiveSeats, getOrgPlan } from './features.js';

/** Stripe + plan-change helpers (SUB-05…SUB-15). Stripe is called with global fetch (form-encoded). */
export const STRIPE_API = 'https://api.stripe.com/v1';
export const stripeKey = () => process.env.STRIPE_SECRET_KEY || null;
export const stripeWebhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET || null;
export const devMode = () => !stripeKey() && !isProd;

export const paymentsNotConfigured = () =>
  new AppError(501, 'PAYMENTS_NOT_CONFIGURED', 'Online payments are not configured on this server');

/** Flatten nested objects into Stripe's bracket form encoding. */
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? formEncode(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(method, path, params) {
  const key = stripeKey();
  if (!key) throw paymentsNotConfigured();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20_000);
  let resp;
  try {
    const qs = method === 'GET' && params ? `?${formEncode(params)}` : '';
    resp = await fetch(`${STRIPE_API}${path}${qs}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
      body: method === 'GET' ? undefined : formEncode(params).toString(),
      signal: ac.signal,
    });
  } catch (err) {
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', `Stripe unreachable: ${err.message}`);
  } finally {
    clearTimeout(t);
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', body?.error?.message ?? `Stripe error ${resp.status}`, { status: resp.status });
  return body;
}

/** Verify a Stripe-Signature header (t=…,v1=…) over the raw body; 5-minute tolerance. */
export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !rawBody) return false;
  let t = null;
  const sigs = [];
  for (const kv of String(header).split(',')) {
    const [k, v] = kv.split('=');
    if (k === 't') t = Number(v);
    if (k === 'v1' && v) sigs.push(v.trim());
  }
  if (!t || !sigs.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  const eb = Buffer.from(expected, 'hex');
  return sigs.some((s) => {
    const sb = Buffer.from(s, 'hex');
    return sb.length === eb.length && crypto.timingSafeEqual(sb, eb);
  });
}

export async function loadPlanByCode(code) {
  const p = await db.one('SELECT * FROM plans WHERE code = $1', [code]);
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Plan not found');
  return p;
}

export async function loadSubscription(orgId) {
  return db.one(
    `SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.sort_order AS plan_rank, p.limits, p.features,
            pp.code AS pending_code, pp.name AS pending_name
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id LEFT JOIN plans pp ON pp.id = s.pending_plan_id
     WHERE s.organization_id = $1`,
    [orgId],
  );
}

export async function storageUsedBytes(orgId) {
  return Number((await db.one(`SELECT value FROM usage_counters WHERE organization_id = $1 AND metric = 'storage_bytes'`, [orgId]))?.value ?? 0);
}

/** SUB-10: current usage must fit the target plan. */
export async function assertFitsPlan(orgId, plan) {
  const seats = await countActiveSeats(orgId);
  const bytes = await storageUsedBytes(orgId);
  const problems = [];
  const max = plan.limits?.maxSeats;
  if (max !== null && max !== undefined && seats > max) problems.push({ limit: 'seats', used: seats, max });
  const gb = plan.limits?.storageGb;
  if (gb !== null && gb !== undefined && bytes > gb * 1024 ** 3) problems.push({ limit: 'storage', usedBytes: bytes, maxBytes: gb * 1024 ** 3 });
  if (problems.length)
    throw new AppError(422, 'PLAN_LIMIT_EXCEEDED', `Your current usage exceeds the ${plan.name} plan limits`, { problems });
}

export const intervalSql = (interval) => (interval === 'year' ? "interval '1 year'" : "interval '1 month'");

/** Apply a plan immediately as an active paid (or dev-mode) subscription period. */
export async function applyPlanNow(orgId, plan, interval, { keepTrial = false } = {}) {
  const seats = Math.max(1, await countActiveSeats(orgId));
  if (keepTrial) {
    return db.one(
      `UPDATE subscriptions SET plan_id = $2, billing_interval = $3, pending_plan_id = NULL, pending_interval = NULL, updated_at = now()
       WHERE organization_id = $1 RETURNING *`,
      [orgId, plan.id, interval],
    );
  }
  return db.one(
    `UPDATE subscriptions SET plan_id = $2, billing_interval = $3, status = 'active', seats = $4, trial_ends_at = NULL,
       current_period_start = now(), current_period_end = now() + ${intervalSql(interval)},
       cancel_at_period_end = false, canceled_at = NULL, pending_plan_id = NULL, pending_interval = NULL,
       expiry_notice_sent_at = NULL, updated_at = now()
     WHERE organization_id = $1 RETURNING *`,
    [orgId, plan.id, interval, seats],
  );
}

/** Owners of an organization (billing notices). */
export async function ownerUserIds(orgId) {
  const rows = await db.many(
    `SELECT m.user_id FROM organization_members m JOIN roles r ON r.id = m.role_id
     WHERE m.organization_id = $1 AND r.base_role = 'owner' AND m.status = 'active' AND m.deleted_at IS NULL`,
    [orgId],
  );
  return rows.map((r) => r.user_id);
}

export async function noticeOwners(orgId, title, body, data) {
  return notify({ orgId, userIds: await ownerUserIds(orgId), type: 'subscription.notice', title, body, link: '/settings/subscription', data });
}

export async function subscriptionDto(orgId) {
  const s = await loadSubscription(orgId);
  const plan = await getOrgPlan(orgId);
  const used = await countActiveSeats(orgId);
  if (!s) return { plan: { code: 'free', name: 'Free' }, effectivePlan: 'free', status: 'active', seats: { used, limit: plan.limits?.maxSeats ?? null } };
  return {
    plan: { code: s.plan_code, name: s.plan_name },
    effectivePlan: plan.effectiveCode ?? plan.code,
    status: s.status,
    interval: s.billing_interval,
    seats: { used, limit: plan.limits?.maxSeats ?? null, billed: s.seats },
    trialEndsAt: s.trial_ends_at,
    currentPeriodStart: s.current_period_start,
    currentPeriodEnd: s.current_period_end,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    canceledAt: s.canceled_at,
    pendingChange: s.pending_plan_id
      ? { plan: { code: s.pending_code, name: s.pending_name }, interval: s.pending_interval ?? s.billing_interval, effectiveAt: s.current_period_end }
      : null,
    billingManagedByStripe: !!s.stripe_subscription_id,
    paymentsConfigured: !!stripeKey(),
  };
}
