import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../../lib/db.js';
import { enqueue } from '../../lib/jobs.js';
import { encrypt, decrypt, randomToken } from '../../lib/crypto.js';
import { isProd } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/** Domain events available to outbound webhooks (keep in sync with src/lib/events.js). */
export const WEBHOOK_EVENTS = [
  'timer.started', 'timer.paused', 'timer.resumed', 'timer.stopped',
  'time_entry.created', 'time_entry.updated', 'time_entry.deleted', 'time_entry.approved', 'time_entry.rejected',
  'member.created', 'member.updated', 'member.deactivated',
  'project.created', 'project.updated', 'project.archived', 'project.deleted',
  'task.created', 'task.updated', 'task.completed', 'task.deleted',
  'timesheet.submitted', 'timesheet.approved', 'timesheet.rejected',
  'attendance.checked_in', 'attendance.checked_out',
  'screenshot.captured', 'break.started', 'break.ended', 'idle.detected',
  'invoice.created', 'invoice.sent', 'invoice.paid', 'client.created',
];

export const MAX_ATTEMPTS = 8;
export const AUTO_DISABLE_AFTER = 20;
export const TIMEOUT_MS = 10_000;

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

/** https required; http://localhost allowed outside production; private hosts rejected in production (SSRF). */
export function isAllowedTargetUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  const host = u.hostname;
  if (u.protocol === 'https:') return !(isProd && PRIVATE_HOST.test(host));
  if (u.protocol === 'http:' && !isProd) return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  return false;
}

export const zTargetUrl = z
  .string()
  .trim()
  .max(2000)
  .refine(isAllowedTargetUrl, 'URL must use https (http://localhost allowed outside production)');
export const zEvents = z
  .array(z.string().refine((e) => e === '*' || WEBHOOK_EVENTS.includes(e), 'Unknown event'))
  .min(1)
  .max(WEBHOOK_EVENTS.length + 1)
  .transform((a) => [...new Set(a)]);

export const newSecret = () => `whsec_${randomToken(24)}`;
export const encryptSecret = (s) => encrypt(s);

export function webhookDto(w) {
  return {
    id: w.id,
    url: w.url,
    events: w.events,
    description: w.description,
    active: w.active,
    source: w.source,
    failureCount: w.failure_count,
    createdAt: w.created_at,
  };
}

export function deliveryDto(d) {
  return {
    id: d.id,
    webhookId: d.webhook_id,
    event: d.event,
    payload: d.payload,
    status: d.status,
    attempts: d.attempts,
    responseCode: d.response_code,
    responseBody: d.response_body,
    nextAttemptAt: d.next_attempt_at,
    createdAt: d.created_at,
  };
}

/** Signature header value: t=<unix>,v1=<hex hmac-sha256(secret, `${t}.${body}`)>. */
export function signPayload(secret, body, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { t, header: `t=${t},v1=${v1}` };
}

/** Backoff before attempt n+1 (n = attempts done): 30s, 1m, 2m, 4m … capped at 6h. */
export const backoffSeconds = (attempts) => Math.min(6 * 3600, 30 * 2 ** Math.max(0, attempts - 1));

/** Create a pending delivery row for a webhook. */
export async function createDelivery(webhook, event, data, { createdAt = new Date().toISOString() } = {}) {
  const row = await db.one(
    `INSERT INTO webhook_deliveries (webhook_id, event, payload, status, next_attempt_at)
     VALUES ($1,$2,'{}'::jsonb,'pending', now()) RETURNING *`,
    [webhook.id, event],
  );
  const payload = { id: row.id, event, createdAt, organizationId: webhook.organization_id, data: data ?? {} };
  await db.query('UPDATE webhook_deliveries SET payload = $2 WHERE id = $1', [row.id, db.json(payload)]);
  return { ...row, payload };
}

/** Fan out a domain event to every active webhook of the org subscribed to it. */
export async function dispatchEvent(evt) {
  const { event, orgId, ...data } = evt;
  if (!orgId || !event || event.startsWith('webhook.')) return 0;
  const hooks = await db.many(
    `SELECT * FROM webhooks WHERE organization_id = $1 AND active AND ($2 = ANY(events) OR '*' = ANY(events))`,
    [orgId, event],
  );
  for (const h of hooks) {
    const d = await createDelivery(h, event, JSON.parse(JSON.stringify(data)));
    await enqueue('webhooks.deliver', { deliveryId: d.id }, { maxAttempts: 1, dedupeKey: `whd:${d.id}:0` });
  }
  return hooks.length;
}

/**
 * Perform one delivery attempt.
 * @param {{retry?: boolean}} opts retry=true schedules the next attempt with exponential backoff on failure.
 */
export async function attemptDelivery(deliveryId, { retry = true } = {}) {
  const d = await db.one(
    `SELECT d.*, w.url, w.secret_enc, w.active, w.organization_id FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = $1`,
    [deliveryId],
  );
  if (!d || d.status === 'success') return d;
  if (!d.active) {
    return db.one(
      `UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = NULL, response_body = coalesce(response_body, 'Webhook disabled')
       WHERE id = $1 RETURNING *`,
      [d.id],
    );
  }
  const body = JSON.stringify(d.payload);
  const secret = decrypt(d.secret_enc);
  const { header } = signPayload(secret, body);
  let code = null;
  let text = '';
  let okResp = false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(d.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Tracker-Webhooks/1.0',
        'X-Tracker-Event': d.event,
        'X-Tracker-Delivery': d.id,
        'X-Tracker-Signature': header,
      },
      body,
      signal: ac.signal,
      redirect: 'manual',
    });
    code = resp.status;
    okResp = resp.status >= 200 && resp.status < 300;
    try {
      text = (await resp.text()).slice(0, 2000);
    } catch {
      text = '';
    }
  } catch (err) {
    text = ac.signal.aborted ? 'Timed out after 10s' : String(err?.message ?? err).slice(0, 2000);
  } finally {
    clearTimeout(timer);
  }
  const attempts = d.attempts + 1;
  if (okResp) {
    await db.query('UPDATE webhooks SET failure_count = 0 WHERE id = $1', [d.webhook_id]);
    return db.one(
      `UPDATE webhook_deliveries SET status = 'success', attempts = $2, response_code = $3, response_body = $4, next_attempt_at = NULL
       WHERE id = $1 RETURNING *`,
      [d.id, attempts, code, text],
    );
  }
  const hook = await db.one(
    `UPDATE webhooks SET failure_count = failure_count + 1,
       active = CASE WHEN failure_count + 1 >= $2 THEN false ELSE active END
     WHERE id = $1 RETURNING failure_count, active`,
    [d.webhook_id, AUTO_DISABLE_AFTER],
  );
  if (!hook.active) logger.warn({ webhookId: d.webhook_id }, 'webhook auto-disabled after consecutive failures');
  const willRetry = retry && hook.active && attempts < MAX_ATTEMPTS;
  const delay = backoffSeconds(attempts);
  const row = await db.one(
    `UPDATE webhook_deliveries SET status = $2, attempts = $3, response_code = $4, response_body = $5,
       next_attempt_at = CASE WHEN $6 THEN now() + make_interval(secs => $7) ELSE NULL END
     WHERE id = $1 RETURNING *`,
    [d.id, willRetry ? 'pending' : 'failed', attempts, code, text, willRetry, delay],
  );
  if (willRetry)
    await enqueue('webhooks.deliver', { deliveryId: d.id }, { runAt: row.next_attempt_at, maxAttempts: 1, dedupeKey: `whd:${d.id}:${attempts}` });
  return row;
}

/** Sample payload data per event (REST hooks / test deliveries). */
export function samplePayload(event) {
  const id = '00000000-0000-4000-8000-000000000001';
  const memberId = '00000000-0000-4000-8000-000000000002';
  const now = new Date().toISOString();
  const [entity] = event.split('.');
  const samples = {
    timer: { memberId, entry: { id, memberId, project: { id, name: 'Website redesign' }, task: { id, title: 'Landing page' }, startedAt: now, endedAt: null, durationSeconds: 0, status: 'running' } },
    time_entry: { memberId, entry: { id, memberId, startedAt: now, endedAt: now, durationSeconds: 3600, status: 'approved', isBillable: true, note: 'Sample' } },
    member: { memberId, member: { id: memberId, status: 'active' } },
    project: { project: { id, name: 'Website redesign', status: 'active' } },
    task: { task: { id, title: 'Landing page', projectId: id, status: 'in_progress' } },
    timesheet: { memberId, timesheet: { id, memberId, periodStart: now.slice(0, 10), periodEnd: now.slice(0, 10), status: 'submitted', totalSeconds: 144000 } },
    attendance: { memberId, record: { id, memberId, date: now.slice(0, 10), status: 'present', checkInAt: now } },
    screenshot: { memberId, screenshot: { id, memberId, capturedAt: now, activityPercent: 72 } },
    break: { memberId, break: { id, memberId, startedAt: now, endedAt: null } },
    idle: { memberId, idle: { id, memberId, startedAt: now, durationSeconds: 600 } },
    invoice: { invoice: { id, number: 'INV-0001', status: 'sent', total: 1200, currency: 'USD' } },
    client: { client: { id, name: 'Acme Inc.' } },
  };
  return samples[entity] ?? { message: 'Sample event' };
}

export { newSecret as generateSecret, randomToken };
