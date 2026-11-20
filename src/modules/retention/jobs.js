import { db } from '../../lib/db.js';
import { registerCron } from '../../lib/jobs.js';
import { logger } from '../../lib/logger.js';

/**
 * SEC-18 / PRIV-04 nightly retention (screenshots are handled by the screenshots module):
 *  - organization_settings.activity_retention_days → activity_samples, app_usage, web_usage
 *  - organization_settings.data_retention_days → login_history (of the org's members), notifications, webhook_deliveries
 *  - always: expired auth tokens, sessions revoked/expired > 30 days, finished jobs > 30 days, failed jobs > 90 days,
 *    processed webhook event ids > 90 days.
 */
export async function retentionCleanup() {
  const out = { activity: 0, appUsage: 0, webUsage: 0, loginHistory: 0, notifications: 0, webhookDeliveries: 0 };
  const orgs = await db.many(
    `SELECT organization_id, activity_retention_days, data_retention_days FROM organization_settings
     WHERE activity_retention_days IS NOT NULL OR data_retention_days IS NOT NULL`,
  );
  for (const o of orgs) {
    try {
      if (o.activity_retention_days) {
        const p = [o.organization_id, o.activity_retention_days];
        out.activity += (await db.query(`DELETE FROM activity_samples WHERE organization_id = $1 AND interval_start < now() - make_interval(days => $2::int)`, p)).rowCount;
        out.appUsage += (await db.query(`DELETE FROM app_usage WHERE organization_id = $1 AND started_at < now() - make_interval(days => $2::int)`, p)).rowCount;
        out.webUsage += (await db.query(`DELETE FROM web_usage WHERE organization_id = $1 AND started_at < now() - make_interval(days => $2::int)`, p)).rowCount;
      }
      if (o.data_retention_days) {
        const p = [o.organization_id, o.data_retention_days];
        out.loginHistory += (
          await db.query(
            `DELETE FROM login_history WHERE created_at < now() - make_interval(days => $2::int)
               AND user_id IN (SELECT user_id FROM organization_members WHERE organization_id = $1)`,
            p,
          )
        ).rowCount;
        out.notifications += (await db.query(`DELETE FROM notifications WHERE organization_id = $1 AND created_at < now() - make_interval(days => $2::int)`, p)).rowCount;
        out.webhookDeliveries += (
          await db.query(
            `DELETE FROM webhook_deliveries WHERE created_at < now() - make_interval(days => $2::int) AND status <> 'pending'
               AND webhook_id IN (SELECT id FROM webhooks WHERE organization_id = $1)`,
            p,
          )
        ).rowCount;
      }
    } catch (err) {
      logger.error({ err, orgId: o.organization_id }, 'retention cleanup failed for organization');
    }
  }
  out.authTokens = (await db.query(`DELETE FROM auth_tokens WHERE expires_at < now()`)).rowCount;
  out.sessions = (
    await db.query(`DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days') OR expires_at < now() - interval '30 days'`)
  ).rowCount;
  out.jobs = (
    await db.query(
      `DELETE FROM jobs WHERE (status = 'done' AND coalesce(finished_at, created_at) < now() - interval '30 days')
         OR (status = 'failed' AND coalesce(finished_at, created_at) < now() - interval '90 days')`,
    )
  ).rowCount;
  out.processedEvents = (await db.query(`DELETE FROM processed_webhook_events WHERE processed_at < now() - interval '90 days'`)).rowCount;
  return out;
}

registerCron('retention.cleanup', 24 * 60 * 60_000, retentionCleanup);
