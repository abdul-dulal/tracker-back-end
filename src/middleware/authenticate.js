import { db } from '../lib/db.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { sha256 } from '../lib/crypto.js';
import { unauthenticated, forbidden, AppError } from '../lib/errors.js';
import { loadMemberContext, withHelpers } from '../rbac/context.js';
import { ALL_PERMISSIONS } from '../rbac/catalog.js';

export const ACCESS_COOKIE = 'tr_at';
export const REFRESH_COOKIE = 'tr_rt';

function baseCtx(req) {
  return withHelpers({
    ip: req.ip,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.id,
  });
}

async function fromJwt(req, token) {
  const payload = await verifyAccessToken(token);
  const session = await db.one(
    `SELECT s.id, s.revoked_at, s.expires_at, s.organization_id, u.id AS user_id, u.email, u.first_name, u.last_name,
            u.status AS user_status, u.is_super_admin, u.mfa_enabled, u.timezone, u.email_verified_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [payload.sid],
  );
  if (!session || session.user_id !== payload.sub) throw unauthenticated('Session not found', 'SESSION_INVALID');
  if (session.revoked_at) throw unauthenticated('Session has been revoked', 'SESSION_REVOKED');
  if (new Date(session.expires_at) < new Date()) throw unauthenticated('Session expired', 'SESSION_EXPIRED');
  if (session.user_status !== 'active') throw forbidden('Account disabled', 'ACCOUNT_DISABLED');
  const ctx = baseCtx(req);
  Object.assign(ctx, {
    authType: 'user',
    userId: session.user_id,
    sessionId: session.id,
    user: {
      id: session.user_id,
      email: session.email,
      firstName: session.first_name,
      lastName: session.last_name,
      isSuperAdmin: session.is_super_admin,
      mfaEnabled: session.mfa_enabled,
      timezone: session.timezone,
      emailVerified: !!session.email_verified_at,
    },
    isSuperAdmin: session.is_super_admin,
  });
  const orgId = payload.org ?? session.organization_id;
  if (orgId) {
    const m = await loadMemberContext(session.user_id, orgId);
    if (m && m.memberStatus === 'active' && m.orgStatus === 'active') Object.assign(ctx, m);
  }
  return ctx;
}

async function fromApiKey(req, key) {
  const row = await db.one(
    `SELECT k.id, k.organization_id, k.scopes, k.expires_at, k.revoked_at, k.created_by
     FROM api_keys k WHERE k.key_hash = $1`,
    [sha256(key)],
  );
  if (!row || row.revoked_at) throw unauthenticated('Invalid API key', 'INVALID_API_KEY');
  if (row.expires_at && new Date(row.expires_at) < new Date()) throw unauthenticated('API key expired', 'INVALID_API_KEY');
  await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]);
  const ctx = baseCtx(req);
  // API keys act with org scope for the permissions listed in `scopes` ('*' = all).
  const keys = row.scopes.includes('*') ? ALL_PERMISSIONS.map((p) => p.key) : row.scopes;
  const creator = row.created_by
    ? await db.one('SELECT user_id, status, deleted_at FROM organization_members WHERE id = $1', [row.created_by])
    : null;
  // A key stops working when the member who created it is no longer active.
  if (!creator || creator.status !== 'active' || creator.deleted_at) throw unauthenticated('API key owner is no longer active', 'INVALID_API_KEY');
  Object.assign(ctx, {
    authType: 'api_key',
    apiKeyId: row.id,
    orgId: row.organization_id,
    memberId: row.created_by,
    userId: creator?.user_id ?? null,
    role: { slug: 'api_key', baseRole: 'admin', level: 90 },
    perms: new Map(keys.map((k) => [k, 'org'])),
    timezone: 'UTC',
  });
  const org = await db.one('SELECT timezone, status FROM organizations WHERE id = $1', [row.organization_id]);
  if (org?.status !== 'active') throw forbidden('Organization suspended', 'ORG_SUSPENDED');
  ctx.timezone = org.timezone;
  return ctx;
}

async function fromDeviceToken(req, token) {
  const row = await db.one(
    `SELECT dt.id, dt.device_id, dt.user_id, dt.expires_at, dt.revoked_at, d.member_id, d.organization_id, d.status AS device_status,
            u.status AS user_status, u.email, u.first_name, u.last_name
     FROM device_tokens dt JOIN devices d ON d.id = dt.device_id JOIN users u ON u.id = dt.user_id
     WHERE dt.token_hash = $1`,
    [sha256(token)],
  );
  if (!row || row.revoked_at || row.device_status !== 'active') throw unauthenticated('Invalid device token', 'INVALID_DEVICE_TOKEN');
  if (new Date(row.expires_at) < new Date()) throw unauthenticated('Device token expired', 'TOKEN_EXPIRED');
  if (row.user_status !== 'active') throw forbidden('Account disabled', 'ACCOUNT_DISABLED');
  const ctx = baseCtx(req);
  Object.assign(ctx, {
    authType: 'agent',
    userId: row.user_id,
    deviceId: row.device_id,
    deviceTokenId: row.id,
    user: { id: row.user_id, email: row.email, firstName: row.first_name, lastName: row.last_name },
  });
  const m = await loadMemberContext(row.user_id, row.organization_id);
  if (!m || m.memberStatus !== 'active') throw forbidden('Membership inactive', 'MEMBER_INACTIVE');
  Object.assign(ctx, m);
  return ctx;
}

/**
 * Resolve credentials (cookie / Bearer JWT, Bearer device token "dt_…", X-API-Key) into req.ctx.
 * Does not enforce anything by itself — see requireAuth().
 */
export async function resolveAuth(req) {
  if (req.ctx) return req.ctx;
  const header = req.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const apiKey = req.get('x-api-key');
  let ctx = null;
  if (apiKey) ctx = await fromApiKey(req, apiKey);
  else if (bearer?.startsWith('dt_')) ctx = await fromDeviceToken(req, bearer);
  else if (bearer) ctx = await fromJwt(req, bearer);
  else if (req.cookies?.[ACCESS_COOKIE]) ctx = await fromJwt(req, req.cookies[ACCESS_COOKIE]);
  req.ctx = ctx ?? baseCtx(req);
  return req.ctx;
}

/**
 * @param {'public'|'user'|'org'|'agent'|'super'|'optional'} level
 */
export function requireAuth(level) {
  return async (req, _res, next) => {
    if (level === 'public') {
      req.ctx = baseCtx(req);
      return next();
    }
    let ctx;
    try {
      ctx = await resolveAuth(req);
    } catch (err) {
      if (level === 'optional') {
        req.ctx = baseCtx(req);
        return next();
      }
      throw err;
    }
    if (level === 'optional') return next();
    if (!ctx.userId && !ctx.apiKeyId) throw unauthenticated();
    if (level === 'agent' && ctx.authType !== 'agent') throw unauthenticated('Device token required', 'DEVICE_TOKEN_REQUIRED');
    if (level === 'super' && !ctx.isSuperAdmin) throw forbidden('Super admin only');
    if (level === 'org') {
      if (!ctx.orgId) throw new AppError(403, 'NO_ACTIVE_ORGANIZATION', 'Select an organization first');
      if (ctx.enforce2fa && ctx.authType === 'user' && !ctx.user?.mfaEnabled)
        throw new AppError(403, 'MFA_SETUP_REQUIRED', 'Your organization requires two-factor authentication');
    }
    next();
  };
}
