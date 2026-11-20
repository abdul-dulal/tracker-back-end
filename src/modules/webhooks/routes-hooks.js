import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { WEBHOOK_EVENTS, zTargetUrl, newSecret, encryptSecret, samplePayload } from './service.js';

/**
 * REST hooks for Zapier / n8n (INT-20, INT-21). Authenticate with X-API-Key (scope webhooks.manage).
 * A subscription is stored as a webhook with source 'rest_hook' and gets the same signed deliveries.
 */
const r = createRouter('/hooks', 'Webhooks');
const zEvent = z.string().refine((e) => WEBHOOK_EVENTS.includes(e), 'Unknown event');

r.get('/me', { summary: 'Connection test for Zapier/n8n (returns the organization)', ids: 'INT-20, INT-21' }, async (req, res) => {
  const org = await db.one('SELECT id, name, slug FROM organizations WHERE id = $1', [req.ctx.orgId]);
  ok(res, { organization: org, authType: req.ctx.authType });
});

r.get('/events', { summary: 'Available trigger events', ids: 'INT-20, INT-21' }, async (_req, res) => {
  ok(res, WEBHOOK_EVENTS.map((e) => ({ key: e, label: e.replace(/[._]/g, ' ') })));
});

r.post(
  '/subscriptions',
  {
    summary: 'Subscribe a REST hook',
    ids: 'INT-20, INT-21',
    permission: 'webhooks.manage',
    body: z.object({
      targetUrl: zTargetUrl,
      event: zEvent,
      source: z.enum(['zapier', 'n8n', 'rest_hook']).default('rest_hook'),
    }),
  },
  async (req, res) => {
    const secret = newSecret();
    const row = await db.one(
      `INSERT INTO webhooks (organization_id, url, events, secret_enc, description, source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.ctx.orgId, req.body.targetUrl, [req.body.event], encryptSecret(secret), `REST hook (${req.body.source})`, req.body.source],
    );
    await audit(req.ctx, 'webhook.subscribe', { entityType: 'webhook', entityId: row.id, after: { url: row.url, event: req.body.event } });
    created(res, { id: row.id, event: req.body.event, targetUrl: row.url, secret });
  },
);

r.delete(
  '/subscriptions/:id',
  { summary: 'Unsubscribe a REST hook', ids: 'INT-20, INT-21', permission: 'webhooks.manage', params: z.object({ id: z.uuid() }) },
  async (req, res) => {
    const row = await db.one(
      `DELETE FROM webhooks WHERE id = $1 AND organization_id = $2 AND source IN ('rest_hook','zapier','n8n') RETURNING id`,
      [req.v.params.id, req.ctx.orgId],
    );
    if (!row) throw notFound('Subscription');
    await audit(req.ctx, 'webhook.unsubscribe', { entityType: 'webhook', entityId: row.id });
    noContent(res);
  },
);

r.get('/sample/:event', { summary: 'Sample payload for an event (polling fallback / field mapping)', ids: 'INT-20, INT-21', params: z.object({ event: zEvent }) }, async (req, res) => {
  const event = req.v.params.event;
  ok(res, [{ id: '00000000-0000-4000-8000-0000000000aa', event, createdAt: new Date().toISOString(), organizationId: req.ctx.orgId, data: samplePayload(event) }]);
});

export default r;
