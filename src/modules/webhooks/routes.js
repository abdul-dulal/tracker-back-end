import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta } from '../../lib/http.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import {
  WEBHOOK_EVENTS,
  zTargetUrl,
  zEvents,
  newSecret,
  encryptSecret,
  webhookDto,
  deliveryDto,
  createDelivery,
  attemptDelivery,
  samplePayload,
} from './service.js';

/**
 * Outbound webhooks (INT-03). The Stripe inbound handler lives at POST /webhooks/stripe
 * (subscription module); every route here uses uuid ids so the paths never collide.
 */
const r = createRouter('/webhooks', 'Webhooks');
const idParam = z.object({ id: z.uuid() });
const PERM = 'webhooks.manage';

async function loadHook(ctx, id) {
  const w = await db.one('SELECT * FROM webhooks WHERE id = $1 AND organization_id = $2', [id, ctx.orgId]);
  if (!w) throw notFound('Webhook');
  return w;
}

r.get('/events', { summary: 'Event names available for webhooks', ids: 'INT-03', permission: PERM }, async (_req, res) => {
  ok(res, WEBHOOK_EVENTS);
});

r.get('/', { summary: 'List webhooks', ids: 'INT-03', permission: PERM }, async (req, res) => {
  const rows = await db.many('SELECT * FROM webhooks WHERE organization_id = $1 ORDER BY created_at DESC', [req.ctx.orgId]);
  ok(res, rows.map(webhookDto));
});

r.post(
  '/',
  {
    summary: 'Create a webhook (signing secret shown once)',
    ids: 'INT-03',
    permission: PERM,
    body: z.object({ url: zTargetUrl, events: zEvents, description: z.string().trim().max(500).optional() }),
  },
  async (req, res) => {
    const secret = newSecret();
    const row = await db.one(
      `INSERT INTO webhooks (organization_id, url, events, secret_enc, description, source) VALUES ($1,$2,$3,$4,$5,'manual') RETURNING *`,
      [req.ctx.orgId, req.body.url, req.body.events, encryptSecret(secret), req.body.description ?? null],
    );
    await audit(req.ctx, 'webhook.create', { entityType: 'webhook', entityId: row.id, after: webhookDto(row) });
    created(res, { ...webhookDto(row), secret });
  },
);

r.get('/:id', { summary: 'Get webhook', ids: 'INT-03', permission: PERM, params: idParam }, async (req, res) => {
  ok(res, webhookDto(await loadHook(req.ctx, req.v.params.id)));
});

r.patch(
  '/:id',
  {
    summary: 'Update webhook (re-enabling resets the failure counter)',
    ids: 'INT-03',
    permission: PERM,
    params: idParam,
    body: z.object({
      url: zTargetUrl.optional(),
      events: zEvents.optional(),
      description: z.string().trim().max(500).nullable().optional(),
      active: z.boolean().optional(),
    }),
  },
  async (req, res) => {
    const before = await loadHook(req.ctx, req.v.params.id);
    const b = req.body;
    const row = await db.one(
      `UPDATE webhooks SET url = coalesce($3, url), events = coalesce($4, events),
         description = CASE WHEN $5 THEN $6 ELSE description END,
         active = coalesce($7, active),
         failure_count = CASE WHEN $7 IS TRUE AND NOT active THEN 0 ELSE failure_count END
       WHERE id = $1 AND organization_id = $2 RETURNING *`,
      [before.id, req.ctx.orgId, b.url ?? null, b.events ?? null, b.description !== undefined, b.description ?? null, b.active ?? null],
    );
    await audit(req.ctx, 'webhook.update', { entityType: 'webhook', entityId: row.id, before: webhookDto(before), after: webhookDto(row) });
    ok(res, webhookDto(row));
  },
);

r.post('/:id/rotate-secret', { summary: 'Rotate signing secret (new secret shown once)', ids: 'INT-03', permission: PERM, params: idParam }, async (req, res) => {
  const w = await loadHook(req.ctx, req.v.params.id);
  const secret = newSecret();
  await db.query('UPDATE webhooks SET secret_enc = $2 WHERE id = $1', [w.id, encryptSecret(secret)]);
  await audit(req.ctx, 'webhook.rotate_secret', { entityType: 'webhook', entityId: w.id });
  ok(res, { ...webhookDto(w), secret });
});

r.delete('/:id', { summary: 'Delete webhook', ids: 'INT-03', permission: PERM, params: idParam }, async (req, res) => {
  const w = await loadHook(req.ctx, req.v.params.id);
  await db.query('DELETE FROM webhooks WHERE id = $1', [w.id]);
  await audit(req.ctx, 'webhook.delete', { entityType: 'webhook', entityId: w.id, before: webhookDto(w) });
  noContent(res);
});

r.get(
  '/:id/deliveries',
  {
    summary: 'Delivery log',
    ids: 'INT-03',
    permission: PERM,
    params: idParam,
    query: paginationQuery.extend({ status: z.enum(['pending', 'success', 'failed']).optional() }),
  },
  async (req, res) => {
    const w = await loadHook(req.ctx, req.v.params.id);
    const q = req.v.query;
    const params = [w.id, q.status ?? null];
    const cond = `webhook_id = $1 AND ($2::text IS NULL OR status = $2)`;
    const total = (await db.one(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE ${cond}`, params)).n;
    const rows = await db.many(
      `SELECT * FROM webhook_deliveries WHERE ${cond} ORDER BY created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      params,
    );
    ok(res, rows.map(deliveryDto), pageMeta(q, total));
  },
);

r.post(
  '/:id/test',
  {
    summary: 'Send a signed test delivery now',
    ids: 'INT-03',
    permission: PERM,
    params: idParam,
    body: z.object({ event: z.string().refine((e) => WEBHOOK_EVENTS.includes(e), 'Unknown event').optional() }).optional(),
  },
  async (req, res) => {
    const w = await loadHook(req.ctx, req.v.params.id);
    if (!w.active) throw badRequest('Webhook is disabled', undefined, 'WEBHOOK_DISABLED');
    const event = req.body?.event ?? w.events.find((e) => e !== '*') ?? 'timer.started';
    const d = await createDelivery(w, event, { test: true, ...samplePayload(event) });
    const result = await attemptDelivery(d.id, { retry: false });
    ok(res, deliveryDto(result));
  },
);

r.post(
  '/deliveries/:id/retry',
  { summary: 'Retry a delivery now', ids: 'INT-03', permission: PERM, params: idParam },
  async (req, res) => {
    const d = await db.one(
      `SELECT d.id, d.status, w.active FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.id = $1 AND w.organization_id = $2`,
      [req.v.params.id, req.ctx.orgId],
    );
    if (!d) throw notFound('Delivery');
    if (d.status === 'success') throw badRequest('Delivery already succeeded', undefined, 'ALREADY_DELIVERED');
    if (!d.active) throw badRequest('Webhook is disabled', undefined, 'WEBHOOK_DISABLED');
    await db.query(`UPDATE webhook_deliveries SET status = 'pending' WHERE id = $1`, [d.id]);
    ok(res, deliveryDto(await attemptDelivery(d.id, { retry: false })));
  },
);

export default r;
