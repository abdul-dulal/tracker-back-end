import { db } from './db.js';
import { logger } from './logger.js';

/**
 * Audit log (SEC-10 / PRIV-09): security-relevant changes (settings, roles, rates, deletions, approvals).
 * @param {object} ctx request context (or { orgId, userId, actorType })
 */
export async function audit(ctx, action, { entityType, entityId, before, after } = {}) {
  try {
    await db.query(
      `INSERT INTO audit_logs (organization_id, actor_user_id, actor_type, action, entity_type, entity_id, before, after, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ctx?.orgId ?? null,
        ctx?.userId ?? null,
        ctx?.actorType ?? (ctx?.isImpersonating ? 'super_admin' : ctx?.authType === 'api_key' ? 'api_key' : ctx?.userId ? 'user' : 'system'),
        action,
        entityType ?? null,
        entityId ?? null,
        db.json(before),
        db.json(after),
        ctx?.ip ?? null,
        ctx?.userAgent ?? null,
      ],
    );
  } catch (err) {
    logger.error({ err, action }, 'audit log write failed');
  }
}

/** Activity feed for projects/tasks/etc. (PROJ-19, TASK-21, ADM-17). */
export async function logActivity(ctx, entityType, entityId, action, changes) {
  await db.query(
    `INSERT INTO activity_log (organization_id, entity_type, entity_id, actor_member_id, action, changes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.orgId, entityType, entityId ?? null, ctx.memberId ?? null, action, db.json(changes)],
  );
}

export async function securityEvent({ orgId, userId, type, severity = 'info', data, ip }) {
  await db.query(
    `INSERT INTO security_events (organization_id, user_id, type, severity, data, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
    [orgId ?? null, userId ?? null, type, severity, db.json(data), ip ?? null],
  );
}

/** Return only keys that changed between two objects (for audit/activity diffs). */
export function diff(before, after) {
  const b = {};
  const a = {};
  for (const k of Object.keys(after ?? {})) {
    if (after[k] === undefined) continue;
    const bv = before?.[k];
    const av = after[k];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      b[k] = bv;
      a[k] = av;
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}
