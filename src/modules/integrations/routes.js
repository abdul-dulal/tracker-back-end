import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, noContent } from '../../lib/http.js';
import { validationError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { PROVIDERS, PROVIDER_KEYS, getProvider, integ, loadIntegration, integrationDto, saveConnection, withStatus } from './service.js';

/** Third-party integrations (INT-08…INT-19). */
const r = createRouter('/integrations', 'Integrations');
const PERM = 'integrations.manage';
const FEATURE = 'integrations';
const providerParam = z.object({ provider: z.enum(PROVIDER_KEYS) });
const settingsBody = z.object({ settings: z.record(z.string(), z.any()).default({}) });

/** Validate settings against the provider's own schema (keeps the 400 VALIDATION_ERROR shape). */
function parseSettings(p, raw) {
  const parsed = p.settingsSchema.safeParse(raw ?? {});
  if (!parsed.success)
    throw validationError(parsed.error.issues.map((i) => ({ path: ['body', 'settings', ...i.path].join('.'), message: i.message, code: i.code })));
  return parsed.data;
}

r.get('/', { summary: 'Integration catalog with connection status', ids: 'INT-08…INT-19', permission: PERM }, async (req, res) => {
  const rows = await db.many('SELECT * FROM integrations WHERE organization_id = $1', [req.ctx.orgId]);
  ok(res, PROVIDERS.map((p) => integrationDto(p, rows.find((x) => x.provider === p.key))));
});

r.post(
  '/:provider/connect',
  { summary: 'Connect a provider (credentials validated, tokens encrypted)', ids: 'INT-09…INT-19', permission: PERM, feature: FEATURE, params: providerParam, body: settingsBody },
  async (req, res) => {
    const p = getProvider(req.v.params.provider);
    const settings = parseSettings(p, req.body.settings);
    const result = await p.connect(settings, {});
    const row = await saveConnection(req.ctx, p.key, result);
    await audit(req.ctx, 'integration.connect', { entityType: 'integration', entityId: row.id, after: { provider: p.key, settings: row.settings } });
    ok(res, integrationDto(p, row));
  },
);

r.patch(
  '/:provider',
  { summary: 'Update provider settings', ids: 'INT-09…INT-19', permission: PERM, feature: FEATURE, params: providerParam, body: settingsBody },
  async (req, res) => {
    const p = getProvider(req.v.params.provider);
    const row = await loadIntegration(req.ctx.orgId, p.key);
    const settings = parseSettings(p, req.body.settings);
    const cur = integ(row);
    const result = await p.connect(settings, { existingToken: cur.token, existingSettings: cur.settings });
    const saved = await saveConnection(req.ctx, p.key, result);
    await audit(req.ctx, 'integration.update', { entityType: 'integration', entityId: row.id, before: row.settings, after: saved.settings });
    ok(res, integrationDto(p, saved));
  },
);

r.delete('/:provider', { summary: 'Disconnect a provider', ids: 'INT-09…INT-19', permission: PERM, params: providerParam }, async (req, res) => {
  const p = getProvider(req.v.params.provider);
  const row = await loadIntegration(req.ctx.orgId, p.key);
  try {
    await p.disconnect(integ(row));
  } catch {
    /* best effort: remote revoke failures never block disconnecting */
  }
  // Links are kept (imported projects/tasks stay); credentials are wiped.
  await db.query(
    `UPDATE integrations SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL, last_error = NULL, updated_at = now() WHERE id = $1`,
    [row.id],
  );
  await audit(req.ctx, 'integration.disconnect', { entityType: 'integration', entityId: row.id, before: { provider: p.key } });
  noContent(res);
});

r.post('/:provider/test', { summary: 'Test the connection', ids: 'INT-09…INT-19', permission: PERM, feature: FEATURE, params: providerParam }, async (req, res) => {
  const p = getProvider(req.v.params.provider);
  const row = await loadIntegration(req.ctx.orgId, p.key);
  ok(res, await withStatus(row, () => p.test(integ(row))));
});

r.post('/:provider/sync', { summary: 'Run a manual import / sync now', ids: 'INT-11…INT-19', permission: PERM, feature: FEATURE, params: providerParam }, async (req, res) => {
  const p = getProvider(req.v.params.provider);
  const row = await loadIntegration(req.ctx.orgId, p.key);
  const result = await withStatus(row, () => p.sync(req.ctx, integ(row)));
  await db.query('UPDATE integrations SET last_sync_at = now() WHERE id = $1', [row.id]);
  await audit(req.ctx, 'integration.sync', { entityType: 'integration', entityId: row.id, after: result });
  ok(res, result);
});

export default r;
