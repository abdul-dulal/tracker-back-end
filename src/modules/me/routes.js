import { z } from 'zod';
import QRCode from 'qrcode';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import { createRouter, zTimezone } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, noContent, created, paginationQuery, pageMeta, camelAll } from '../../lib/http.js';
import { hashPassword, verifyPassword, passwordSchema } from '../../lib/password.js';
import { encrypt, decrypt, randomToken, sha256 } from '../../lib/crypto.js';
import { badRequest, notFound, unauthenticated } from '../../lib/errors.js';
import { createUpload, assertUploaded, signedGetUrl, deleteObject } from '../../lib/storage.js';
import { audit } from '../../lib/audit.js';
import { userDto, listUserOrganizations } from '../auth/service.js';
import { getEffectiveSettings, consentStatus } from '../settings/effective.js';
import { getOrgPlan } from '../subscription/features.js';

const r = createRouter('/me', 'Me');

async function loadUser(id) {
  return db.one('SELECT * FROM users WHERE id = $1', [id]);
}

// ─── Current user (AUTH-18) ──────────────────────────────────────────────────
r.get('/', { auth: 'user', summary: 'Current user, active membership, permissions and plan features', ids: 'AUTH-18, RBAC-01' }, async (req, res) => {
  const u = await loadUser(req.ctx.userId);
  const data = { user: { ...userDto(u), avatarUrl: signedGetUrl(u.avatar_key, { ttl: 3600 }) }, organization: null, member: null, permissions: {}, features: {}, subscription: null };
  if (req.ctx.orgId && req.ctx.memberId) {
    const org = await db.one('SELECT * FROM organizations WHERE id = $1', [req.ctx.orgId]);
    const m = await db.one(
      `SELECT m.*, d.name AS department_name FROM organization_members m LEFT JOIN departments d ON d.id = m.department_id WHERE m.id = $1`,
      [req.ctx.memberId],
    );
    const plan = await getOrgPlan(req.ctx.orgId);
    data.organization = {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logoUrl: signedGetUrl(org.logo_key, { ttl: 3600 }),
      brandColor: org.brand_color,
      timezone: org.timezone,
      currency: org.default_currency,
      dateFormat: org.date_format,
      timeFormat: org.time_format,
      weekStart: org.week_start,
    };
    data.member = {
      id: m.id,
      status: m.status,
      employeeCode: m.employee_code,
      designation: m.designation,
      department: m.department_name,
      clientId: m.client_id,
      timezone: req.ctx.timezone,
      role: req.ctx.role,
    };
    data.permissions = Object.fromEntries(req.ctx.perms ?? []);
    data.features = plan.features ?? {};
    data.subscription = {
      plan: plan.code,
      effectivePlan: plan.effectiveCode ?? plan.code,
      status: plan.status,
      trialEndsAt: plan.trial_ends_at ?? null,
      expired: !!plan.expired,
    };
    data.mfaSetupRequired = !!req.ctx.enforce2fa && !u.mfa_enabled;
  }
  ok(res, data);
});

r.patch(
  '/',
  {
    auth: 'user',
    summary: 'Update profile',
    ids: 'AUTH-18, TIME-33, TIME-34',
    body: z.object({
      firstName: z.string().trim().min(1).max(100).optional(),
      lastName: z.string().trim().max(100).optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      timezone: zTimezone.optional(),
      timeFormat: z.enum(['12h', '24h']).optional(),
      dateFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY', 'DD-MM-YYYY']).optional(),
      locale: z.string().max(10).optional(),
      avatarKey: z.string().max(300).nullable().optional(),
    }),
  },
  async (req, res) => {
    const b = req.body;
    const before = await loadUser(req.ctx.userId);
    if (b.avatarKey) await assertUploaded(b.avatarKey, { purpose: 'avatar' });
    const map = { firstName: 'first_name', lastName: 'last_name', phone: 'phone', timezone: 'timezone', timeFormat: 'time_format', dateFormat: 'date_format', locale: 'locale', avatarKey: 'avatar_key' };
    const sets = [];
    const params = [req.ctx.userId];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      params.push(b[k]);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) return ok(res, userDto(before));
    const u = await db.one(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
    if (b.avatarKey !== undefined && before.avatar_key && before.avatar_key !== b.avatarKey) await deleteObject(before.avatar_key);
    ok(res, { ...userDto(u), avatarUrl: signedGetUrl(u.avatar_key, { ttl: 3600 }) });
  },
);

r.post(
  '/avatar/upload-url',
  { auth: 'user', summary: 'Get a signed upload URL for an avatar image', ids: 'AUTH-18', body: z.object({ contentType: z.string().max(100), size: z.number().int().positive() }) },
  async (req, res) => {
    ok(res, await createUpload({ purpose: 'avatar', contentType: req.body.contentType, size: req.body.size, userId: req.ctx.userId, allowedTypes: ['image/'] }));
  },
);

// ─── AUTH-19 Change password ─────────────────────────────────────────────────
r.post(
  '/change-password',
  { auth: 'user', summary: 'Change password (revokes other sessions)', ids: 'AUTH-19', body: z.object({ currentPassword: z.string().optional(), newPassword: passwordSchema }) },
  async (req, res) => {
    const u = await loadUser(req.ctx.userId);
    if (u.password_hash && !(await verifyPassword(u.password_hash, req.body.currentPassword ?? '')))
      throw badRequest('Current password is incorrect', [{ path: 'body.currentPassword', message: 'Incorrect password' }], 'INVALID_PASSWORD');
    await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, await hashPassword(req.body.newPassword)]);
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [u.id, req.ctx.sessionId]);
    await audit(req.ctx, 'user.password_changed', { entityType: 'user', entityId: u.id });
    noContent(res);
  },
);

// ─── AUTH-06 2FA management ──────────────────────────────────────────────────
const genRecoveryCodes = () => Array.from({ length: 10 }, () => randomToken(6).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase());

r.post('/2fa/setup', { auth: 'user', summary: 'Start TOTP setup (returns secret, otpauth URL and QR code)', ids: 'AUTH-06' }, async (req, res) => {
  const u = await loadUser(req.ctx.userId);
  if (u.mfa_enabled) throw badRequest('Two-factor authentication is already enabled', undefined, 'MFA_ALREADY_ENABLED');
  const secret = generateSecret();
  await db.query(
    `INSERT INTO user_mfa (user_id, totp_secret_enc) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET totp_secret_enc = EXCLUDED.totp_secret_enc, enabled_at = NULL, recovery_codes_hash = '{}'`,
    [u.id, encrypt(secret)],
  );
  const otpauthUrl = generateURI({ issuer: 'Tracker', label: u.email, secret });
  ok(res, { secret, otpauthUrl, qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl) });
});

r.post(
  '/2fa/enable',
  { auth: 'user', summary: 'Confirm TOTP code and enable 2FA (returns recovery codes once)', ids: 'AUTH-06', body: z.object({ code: z.string().regex(/^\d{6}$/) }) },
  async (req, res) => {
    const mfa = await db.one('SELECT * FROM user_mfa WHERE user_id = $1', [req.ctx.userId]);
    if (!mfa) throw badRequest('Start setup first', undefined, 'MFA_SETUP_NOT_STARTED');
    const { valid } = await verifyTotp({ secret: decrypt(mfa.totp_secret_enc), token: req.body.code, epochTolerance: 30 });
    if (!valid) throw badRequest('Invalid verification code', [{ path: 'body.code', message: 'Invalid code' }], 'INVALID_MFA_CODE');
    const codes = genRecoveryCodes();
    await db.query('UPDATE user_mfa SET enabled_at = now(), recovery_codes_hash = $2 WHERE user_id = $1', [req.ctx.userId, codes.map(sha256)]);
    await db.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [req.ctx.userId]);
    await audit(req.ctx, 'user.mfa_enabled', { entityType: 'user', entityId: req.ctx.userId });
    ok(res, { enabled: true, recoveryCodes: codes });
  },
);

async function assertPasswordOrCode(userId, { password, code }) {
  const u = await loadUser(userId);
  const mfa = await db.one('SELECT * FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL', [userId]);
  if (password && u.password_hash && (await verifyPassword(u.password_hash, password))) return;
  if (code && mfa && (await verifyTotp({ secret: decrypt(mfa.totp_secret_enc), token: code, epochTolerance: 30 })).valid) return;
  throw unauthenticated('Password or verification code is incorrect', 'REAUTH_FAILED');
}

r.post(
  '/2fa/disable',
  { auth: 'user', summary: 'Disable 2FA (requires password or current code)', ids: 'AUTH-06', body: z.object({ password: z.string().optional(), code: z.string().optional() }) },
  async (req, res) => {
    await assertPasswordOrCode(req.ctx.userId, req.body);
    await db.query('DELETE FROM user_mfa WHERE user_id = $1', [req.ctx.userId]);
    await db.query('UPDATE users SET mfa_enabled = false WHERE id = $1', [req.ctx.userId]);
    await audit(req.ctx, 'user.mfa_disabled', { entityType: 'user', entityId: req.ctx.userId });
    noContent(res);
  },
);

r.post(
  '/2fa/recovery-codes',
  { auth: 'user', summary: 'Regenerate recovery codes', ids: 'AUTH-06', body: z.object({ password: z.string().optional(), code: z.string().optional() }) },
  async (req, res) => {
    await assertPasswordOrCode(req.ctx.userId, req.body);
    const codes = genRecoveryCodes();
    const r2 = await db.query('UPDATE user_mfa SET recovery_codes_hash = $2 WHERE user_id = $1 AND enabled_at IS NOT NULL', [req.ctx.userId, codes.map(sha256)]);
    if (!r2.rowCount) throw badRequest('Two-factor authentication is not enabled', undefined, 'MFA_NOT_ENABLED');
    ok(res, { recoveryCodes: codes });
  },
);

// ─── AUTH-07 Passkeys list/delete ────────────────────────────────────────────
r.get('/passkeys', { auth: 'user', summary: 'List passkeys', ids: 'AUTH-07' }, async (req, res) => {
  ok(res, camelAll(await db.many('SELECT id, name, transports, last_used_at, created_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at', [req.ctx.userId])));
});

r.delete('/passkeys/:id', { auth: 'user', summary: 'Delete passkey', ids: 'AUTH-07', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const d = await db.query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [req.v.params.id, req.ctx.userId]);
  if (!d.rowCount) throw notFound('Passkey');
  await audit(req.ctx, 'user.passkey_removed', { entityType: 'user', entityId: req.ctx.userId });
  noContent(res);
});

// ─── AUTH-08 / AUTH-21 Sessions & devices ────────────────────────────────────
r.get('/sessions', { auth: 'user', summary: 'Active sessions', ids: 'AUTH-08, AUTH-21' }, async (req, res) => {
  const rows = await db.many(
    `SELECT DISTINCT ON (family_id) id, family_id, ip::text AS ip, user_agent, remember_me, created_at, last_used_at, expires_at, organization_id
     FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY family_id, created_at DESC`,
    [req.ctx.userId],
  );
  const current = await db.one('SELECT family_id FROM sessions WHERE id = $1', [req.ctx.sessionId]);
  ok(
    res,
    rows
      .sort((a, b) => new Date(b.last_used_at) - new Date(a.last_used_at))
      .map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.user_agent,
        rememberMe: s.remember_me,
        createdAt: s.created_at,
        lastUsedAt: s.last_used_at,
        expiresAt: s.expires_at,
        current: s.family_id === current?.family_id,
      })),
  );
});

r.delete('/sessions/:id', { auth: 'user', summary: 'Revoke a session', ids: 'AUTH-08, SEC-12', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const s = await db.one('SELECT family_id FROM sessions WHERE id = $1 AND user_id = $2', [req.v.params.id, req.ctx.userId]);
  if (!s) throw notFound('Session');
  await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'user_revoked' WHERE family_id = $1 AND revoked_at IS NULL`, [s.family_id]);
  noContent(res);
});

r.post('/sessions/revoke-others', { auth: 'user', summary: 'Revoke all other sessions', ids: 'AUTH-08' }, async (req, res) => {
  const cur = await db.one('SELECT family_id FROM sessions WHERE id = $1', [req.ctx.sessionId]);
  const r2 = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = 'user_revoked_others' WHERE user_id = $1 AND family_id <> $2 AND revoked_at IS NULL`,
    [req.ctx.userId, cur.family_id],
  );
  ok(res, { revoked: r2.rowCount });
});

r.get('/login-history', { auth: 'user', summary: 'Login history', ids: 'AUTH-20, SEC-11', query: paginationQuery }, async (req, res) => {
  const q = req.v.query;
  const total = (await db.one('SELECT count(*)::int AS n FROM login_history WHERE user_id = $1', [req.ctx.userId])).n;
  const rows = await db.many(
    `SELECT id, method, success, failure_reason, ip::text AS ip, user_agent, created_at FROM login_history
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [req.ctx.userId, q.limit, (q.page - 1) * q.limit],
  );
  ok(res, camelAll(rows), pageMeta(q, total));
});

r.get('/devices', { auth: 'user', summary: 'Desktop devices of the current user', ids: 'AUTH-21, DESK-24' }, async (req, res) => {
  const rows = await db.many(
    `SELECT d.id, d.kind, d.os, d.os_version, d.app_version, d.hostname, d.last_seen_at, d.last_sync_at, d.pending_count, d.online, d.status, d.created_at,
            o.name AS organization_name
     FROM devices d JOIN organization_members m ON m.id = d.member_id JOIN organizations o ON o.id = d.organization_id
     WHERE m.user_id = $1 ORDER BY d.last_seen_at DESC NULLS LAST`,
    [req.ctx.userId],
  );
  ok(res, camelAll(rows));
});

r.delete('/devices/:id', { auth: 'user', summary: 'Revoke a desktop device', ids: 'SEC-12, DESK-25', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const d = await db.one(
    `UPDATE devices d SET status = 'revoked', online = false FROM organization_members m
     WHERE d.id = $1 AND m.id = d.member_id AND m.user_id = $2 RETURNING d.id`,
    [req.v.params.id, req.ctx.userId],
  );
  if (!d) throw notFound('Device');
  await db.query('UPDATE device_tokens SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL', [d.id]);
  noContent(res);
});

r.get('/organizations', { auth: 'user', summary: 'Organizations for the switcher', ids: 'AUTH-10' }, async (req, res) => {
  const orgs = await listUserOrganizations(req.ctx.userId);
  ok(res, orgs.map((o) => ({ ...o, logoUrl: signedGetUrl(o.logoKey, { ttl: 3600 }), active: o.id === req.ctx.orgId })));
});

// ─── SS-P1 / PRIV-01 Monitoring transparency & consent ──────────────────────
r.get('/monitoring-status', { auth: 'org', summary: 'What is tracked for me (transparency)', ids: 'SS-P1, SS-P2, PRIV-01, PRIV-02' }, async (req, res) => {
  const { settings } = await getEffectiveSettings(req.ctx.orgId, { memberId: req.ctx.memberId });
  const consent = await consentStatus(req.ctx.orgId, req.ctx.memberId);
  const running = await db.one(`SELECT id, started_at FROM time_entries WHERE member_id = $1 AND ended_at IS NULL AND deleted_at IS NULL`, [req.ctx.memberId]);
  ok(res, {
    trackingActive: !!running,
    tracked: {
      screenshots: settings.screenshotsEnabled,
      screenshotIntervalMinutes: settings.screenshotIntervalMinutes,
      screenshotBlur: settings.screenshotBlur,
      activityLevels: settings.activityTrackingEnabled,
      applications: settings.appTrackingEnabled,
      websites: settings.websiteTrackingEnabled,
      fullUrls: settings.trackFullUrl,
      windowTitles: settings.captureWindowTitles,
      keystrokeContent: false,
    },
    visibleIndicator: true,
    stealthMode: false,
    canViewOwnScreenshots: true,
    consent,
  });
});

r.post(
  '/consent',
  { auth: 'org', summary: 'Accept the current tracking policy', ids: 'PRIV-01', body: z.object({ policyVersion: z.number().int().positive() }) },
  async (req, res) => {
    const st = await consentStatus(req.ctx.orgId, req.ctx.memberId);
    if (req.body.policyVersion !== st.policyVersion)
      throw badRequest('Policy version is outdated, please review the latest policy', { currentVersion: st.policyVersion }, 'POLICY_VERSION_MISMATCH');
    const row = await db.one(
      `INSERT INTO consents (organization_id, member_id, policy_version, ip) VALUES ($1,$2,$3,$4)
       ON CONFLICT (member_id, policy_version) DO UPDATE SET accepted_at = consents.accepted_at RETURNING accepted_at`,
      [req.ctx.orgId, req.ctx.memberId, st.policyVersion, req.ctx.ip],
    );
    await audit(req.ctx, 'privacy.consent_accepted', { entityType: 'member', entityId: req.ctx.memberId, after: { policyVersion: st.policyVersion } });
    created(res, { accepted: true, policyVersion: st.policyVersion, acceptedAt: row.accepted_at });
  },
);

export default r;
