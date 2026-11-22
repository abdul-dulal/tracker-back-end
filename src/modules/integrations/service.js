import { PROVIDER_FIELDS, BRAND_COLORS, CATEGORY_LABELS } from './fields.js';
import { db } from '../../lib/db.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import { PROVIDERS, getProvider } from './providers/index.js';

export const PROVIDER_KEYS = PROVIDERS.map((p) => p.key);

/** Build the adapter context { row, token, settings } for an integration row. */
export function integ(row) {
  return { row, token: row.access_token_enc ? decrypt(row.access_token_enc) : null, settings: row.settings ?? {} };
}

export async function loadIntegration(orgId, provider, { required = true } = {}) {
  const row = await db.one(`SELECT * FROM integrations WHERE organization_id = $1 AND provider = $2 AND status <> 'disconnected'`, [orgId, provider]);
  if (!row && required) throw notFound('Integration');
  return row;
}

export function integrationDto(p, row) {
  return {
    provider: p.key,
    name: p.name,
    category: p.category,
    categoryLabel: CATEGORY_LABELS[p.category] ?? p.category,
    brandColor: BRAND_COLORS[p.key] ?? null,
    fields: PROVIDER_FIELDS[p.key] ?? [],
    authType: p.authType,
    description: p.description,
    connected: !!row && row.status !== 'disconnected',
    status: row?.status ?? 'not_connected',
    settings: row?.settings ?? null,
    hasCredentials: !!row?.access_token_enc,
    lastSyncAt: row?.last_sync_at ?? null,
    lastError: row?.last_error ?? null,
    connectedAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/** Upsert the connection after the provider validated settings/credentials. */
export async function saveConnection(ctx, provider, { token, settings }) {
  return db.one(
    `INSERT INTO integrations (organization_id, provider, status, access_token_enc, settings, connected_by, last_error)
     VALUES ($1,$2,'connected',$3,$4,$5,NULL)
     ON CONFLICT (organization_id, provider) DO UPDATE SET status = 'connected', access_token_enc = EXCLUDED.access_token_enc,
       settings = EXCLUDED.settings, connected_by = coalesce(EXCLUDED.connected_by, integrations.connected_by), last_error = NULL, updated_at = now()
     RETURNING *`,
    [ctx.orgId, provider, token ? encrypt(token) : null, db.json(settings ?? {}), ctx.memberId ?? null],
  );
}

/** Record a provider failure on the row and rethrow. */
export async function withStatus(row, fn) {
  try {
    const out = await fn();
    await db.query(`UPDATE integrations SET status = 'connected', last_error = NULL, updated_at = now() WHERE id = $1`, [row.id]);
    return out;
  } catch (err) {
    await db.query(`UPDATE integrations SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1`, [row.id, String(err?.message ?? err).slice(0, 1000)]);
    throw err;
  }
}

export { getProvider, PROVIDERS };
