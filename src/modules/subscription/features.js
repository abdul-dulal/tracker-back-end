import { db } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';

/**
 * Plan limits & feature gates (SUB-16…SUB-20). Kept dependency-free so every module can import it.
 */
export async function getOrgPlan(orgId) {
  const row = await db.one(
    `SELECT s.id AS subscription_id, s.status, s.seats, s.trial_ends_at, s.current_period_end, s.billing_interval,
            s.cancel_at_period_end, p.code, p.name, p.limits, p.features
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.organization_id = $1`,
    [orgId],
  );
  if (!row) {
    const free = await db.one(`SELECT code, name, limits, features FROM plans WHERE code = 'free'`);
    return { status: 'active', code: 'free', limits: free?.limits ?? {}, features: free?.features ?? {} };
  }
  // Trial expired / subscription expired → fall back to free limits.
  const expired =
    row.status === 'expired' ||
    row.status === 'canceled' ||
    (row.status === 'trialing' && row.trial_ends_at && new Date(row.trial_ends_at) < new Date());
  if (expired) {
    const free = await db.one(`SELECT limits, features FROM plans WHERE code = 'free'`);
    return { ...row, effectiveCode: 'free', expired: true, limits: free.limits, features: free.features };
  }
  return { ...row, effectiveCode: row.code, expired: false };
}

async function planFor(ctx) {
  if (!ctx.cache) ctx.cache = new Map();
  if (!ctx.cache.has('plan')) ctx.cache.set('plan', await getOrgPlan(ctx.orgId));
  return ctx.cache.get('plan');
}

export async function hasFeature(ctx, feature) {
  const plan = await planFor(ctx);
  return !!plan.features?.[feature];
}

export function requireFeature(feature) {
  return async (req, _res, next) => {
    if (!req.ctx?.orgId) return next();
    if (!(await hasFeature(req.ctx, feature)))
      throw new AppError(403, 'FEATURE_NOT_IN_PLAN', `Your plan does not include ${feature}. Upgrade to use this feature.`, {
        feature,
      });
    next();
  };
}

export async function countActiveSeats(orgId) {
  const r = await db.one(
    `SELECT count(*)::int AS n FROM organization_members m JOIN roles r ON r.id = m.role_id
     WHERE m.organization_id = $1 AND m.deleted_at IS NULL AND m.status IN ('active','invited') AND r.base_role <> 'client'`,
    [orgId],
  );
  const pending = await db.one(
    `SELECT count(*)::int AS n FROM invitations i JOIN roles r ON r.id = i.role_id
     WHERE i.organization_id = $1 AND i.status = 'pending' AND i.member_id IS NULL AND r.base_role <> 'client'`,
    [orgId],
  );
  return r.n + pending.n;
}

/** Throw SEAT_LIMIT_REACHED if adding `extra` seats exceeds the plan (SUB-17). */
export async function assertSeatsAvailable(orgId, extra = 1) {
  const plan = await getOrgPlan(orgId);
  const max = plan.limits?.maxSeats;
  if (max === null || max === undefined) return;
  const used = await countActiveSeats(orgId);
  if (used + extra > max)
    throw new AppError(403, 'SEAT_LIMIT_REACHED', `Your plan allows ${max} seats (${used} in use). Upgrade to add more members.`, {
      max,
      used,
    });
}

/** Throw STORAGE_LIMIT_REACHED if uploading `bytes` exceeds the plan (SUB-18). */
export async function assertStorageAvailable(orgId, bytes) {
  const plan = await getOrgPlan(orgId);
  const gb = plan.limits?.storageGb;
  if (gb === null || gb === undefined) return;
  const used = Number((await db.one(`SELECT value FROM usage_counters WHERE organization_id = $1 AND metric = 'storage_bytes'`, [orgId]))?.value ?? 0);
  if (used + bytes > gb * 1024 ** 3)
    throw new AppError(403, 'STORAGE_LIMIT_REACHED', 'Storage limit reached for your plan', { usedBytes: used, limitGb: gb });
}

/** Effective screenshot retention = min(setting, plan max) (SUB-19). */
export async function maxScreenshotRetentionDays(orgId) {
  const plan = await getOrgPlan(orgId);
  return plan.limits?.screenshotRetentionDays ?? null;
}
