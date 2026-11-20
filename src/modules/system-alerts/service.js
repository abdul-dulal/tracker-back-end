import { db } from '../../lib/db.js';
import { getOrgPlan, countActiveSeats } from '../subscription/features.js';

/**
 * System alerts (ADM-18): one open alert per (org, type); auto-resolved when the condition clears.
 */
export const MANAGED_TYPES = ['seats.near_limit', 'storage.near_limit', 'trial.ending', 'webhooks.failing'];

async function upsert(orgId, type, severity, message, data) {
  await db.query(
    `INSERT INTO system_alerts (organization_id, type, severity, message, data) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organization_id, type) WHERE resolved_at IS NULL DO UPDATE SET severity = EXCLUDED.severity, message = EXCLUDED.message, data = EXCLUDED.data`,
    [orgId, type, severity, message, db.json(data)],
  );
}

async function resolve(orgId, type) {
  await db.query('UPDATE system_alerts SET resolved_at = now() WHERE organization_id = $1 AND type = $2 AND resolved_at IS NULL', [orgId, type]);
}

export async function checkOrg(orgId) {
  const plan = await getOrgPlan(orgId);
  const found = {};
  const maxSeats = plan.limits?.maxSeats;
  if (maxSeats) {
    const used = await countActiveSeats(orgId);
    if (used >= maxSeats * 0.9)
      found['seats.near_limit'] = [used >= maxSeats ? 'critical' : 'warning', `${used} of ${maxSeats} seats in use`, { used, max: maxSeats }];
  }
  const gb = plan.limits?.storageGb;
  if (gb) {
    const usedBytes = Number((await db.one(`SELECT value FROM usage_counters WHERE organization_id = $1 AND metric = 'storage_bytes'`, [orgId]))?.value ?? 0);
    const limit = gb * 1024 ** 3;
    if (usedBytes >= limit * 0.9)
      found['storage.near_limit'] = [usedBytes >= limit ? 'critical' : 'warning', `Storage ${Math.round((usedBytes / limit) * 100)}% used`, { usedBytes, limitGb: gb }];
  }
  if (plan.status === 'trialing' && plan.trial_ends_at) {
    const ms = new Date(plan.trial_ends_at) - Date.now();
    if (ms > 0 && ms <= 3 * 86_400_000) {
      const days = Math.ceil(ms / 86_400_000);
      found['trial.ending'] = ['warning', `Your trial ends in ${days} day(s)`, { trialEndsAt: plan.trial_ends_at, days }];
    }
  }
  const hooks = await db.many('SELECT id, url, failure_count FROM webhooks WHERE organization_id = $1 AND failure_count >= 5', [orgId]);
  if (hooks.length)
    found['webhooks.failing'] = ['warning', `${hooks.length} webhook(s) failing repeatedly`, { webhooks: hooks.map((h) => ({ id: h.id, url: h.url, failureCount: h.failure_count })) }];
  for (const type of MANAGED_TYPES) {
    if (found[type]) await upsert(orgId, type, ...found[type]);
    else await resolve(orgId, type);
  }
  return Object.keys(found);
}

export async function checkAll() {
  const orgs = await db.many(`SELECT id FROM organizations WHERE status = 'active' AND deleted_at IS NULL`);
  const out = {};
  for (const o of orgs) out[o.id] = await checkOrg(o.id);
  return out;
}
