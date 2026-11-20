import { db } from '../../lib/db.js';
import { registerJob, enqueue } from '../../lib/jobs.js';
import { subscribeAll } from '../../lib/events.js';
import { logger } from '../../lib/logger.js';
import { getProvider, integ } from './service.js';

/** Route domain events to connected integrations that want them (Slack/Teams messages, Jira worklogs). */
subscribeAll(async (evt) => {
  if (!evt.orgId || !evt.event) return;
  const rows = await db.many(`SELECT * FROM integrations WHERE organization_id = $1 AND status IN ('connected','error')`, [evt.orgId]);
  for (const row of rows) {
    const p = getProvider(row.provider);
    if (!p?.handleEvent || !p.wantsEvent?.(integ(row), evt.event)) continue;
    await enqueue('integrations.event', { integrationId: row.id, evt: JSON.parse(JSON.stringify(evt)) }, { maxAttempts: 3 });
  }
});

registerJob('integrations.event', async ({ integrationId, evt }) => {
  const row = await db.one(
    `SELECT i.*, o.name AS org_name FROM integrations i JOIN organizations o ON o.id = i.organization_id WHERE i.id = $1 AND i.status <> 'disconnected'`,
    [integrationId],
  );
  if (!row) return;
  const p = getProvider(row.provider);
  try {
    await p.handleEvent(integ(row), evt, { orgName: row.org_name });
  } catch (err) {
    await db.query(`UPDATE integrations SET last_error = $2, updated_at = now() WHERE id = $1`, [row.id, String(err?.message ?? err).slice(0, 1000)]);
    logger.warn({ err, provider: row.provider }, 'integration event delivery failed');
    throw err;
  }
});
