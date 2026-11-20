import { z } from 'zod';
import { db } from '../../lib/db.js';
import { unprocessable } from '../../lib/errors.js';
import { NOTIFICATION_EVENTS } from '../../rbac/catalog.js';

/**
 * Notification preference matrix helpers (NOTIF-24).
 * Resolution order (same as notify()): user row → org default row (user_id NULL) → event default.
 */
export const eventDefault = (type) => {
  const e = NOTIFICATION_EVENTS[type] ?? {};
  return { inApp: true, email: e.defaultEmail ?? true, desktop: true };
};

export const prefItemSchema = z.object({
  type: z.string().refine((t) => t in NOTIFICATION_EVENTS, 'Unknown notification event type'),
  inApp: z.boolean().optional(),
  email: z.boolean().optional(),
  desktop: z.boolean().optional(),
});
export const prefsBody = z.object({ preferences: z.array(prefItemSchema).min(1).max(200) });

const rowToPref = (r) => (r ? { inApp: r.in_app, email: r.email, desktop: r.desktop } : null);

/** Build the full matrix over NOTIFICATION_EVENTS. */
export async function buildMatrix({ userId, orgId }) {
  const orgRows = orgId
    ? await db.many(`SELECT * FROM notification_preferences WHERE user_id IS NULL AND organization_id = $1`, [orgId])
    : [];
  const userRows = userId
    ? await db.many(
        `SELECT * FROM notification_preferences WHERE user_id = $1 AND (organization_id IS NOT DISTINCT FROM $2 OR organization_id IS NULL)`,
        [userId, orgId ?? null],
      )
    : [];
  return Object.entries(NOTIFICATION_EVENTS).map(([type, e]) => {
    const own =
      userRows.find((r) => r.event_type === type && r.organization_id === (orgId ?? null)) ??
      userRows.find((r) => r.event_type === type && !r.organization_id);
    const org = orgRows.find((r) => r.event_type === type);
    const base = eventDefault(type);
    const resolved = rowToPref(own) ?? rowToPref(org) ?? base;
    const source = own ? 'user' : org ? 'organization' : 'default';
    const out = { type, label: e.label, mandatory: !!e.mandatory, ...resolved, source };
    if (e.mandatory) out.inApp = true;
    return out;
  });
}

/** Upsert preference rows for (userId|null, orgId|null). Mandatory events cannot disable in-app. */
export async function savePrefs({ userId, orgId, items, current }) {
  for (const it of items) {
    if (NOTIFICATION_EVENTS[it.type]?.mandatory && it.inApp === false)
      throw unprocessable('MANDATORY_NOTIFICATION', `In-app notifications for "${it.type}" cannot be disabled`, { type: it.type });
  }
  await db.tx(async () => {
    for (const it of items) {
      const cur = current.find((c) => c.type === it.type) ?? eventDefault(it.type);
      const v = {
        inApp: NOTIFICATION_EVENTS[it.type]?.mandatory ? true : (it.inApp ?? cur.inApp),
        email: it.email ?? cur.email,
        desktop: it.desktop ?? cur.desktop,
      };
      const upd = await db.query(
        `UPDATE notification_preferences SET in_app = $4, email = $5, desktop = $6
         WHERE user_id IS NOT DISTINCT FROM $1 AND organization_id IS NOT DISTINCT FROM $2 AND event_type = $3`,
        [userId ?? null, orgId ?? null, it.type, v.inApp, v.email, v.desktop],
      );
      if (!upd.rowCount)
        await db.query(
          `INSERT INTO notification_preferences (user_id, organization_id, event_type, in_app, email, desktop) VALUES ($1,$2,$3,$4,$5,$6)`,
          [userId ?? null, orgId ?? null, it.type, v.inApp, v.email, v.desktop],
        );
    }
  });
}
