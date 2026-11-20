import { db } from '../../lib/db.js';
import { env } from '../../config/env.js';
import { randomToken, sha256, uuid } from '../../lib/crypto.js';
import { signAccessToken } from '../../lib/jwt.js';
import { unauthenticated, AppError, badRequest } from '../../lib/errors.js';
import { securityEvent } from '../../lib/audit.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../middleware/authenticate.js';
import { sendMail, layout, escapeHtml } from '../../lib/mailer.js';

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;

export async function recordLogin({ userId, email, method, success, reason, ip, userAgent }) {
  await db.query(
    `INSERT INTO login_history (user_id, email_attempted, method, success, failure_reason, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId ?? null, email ?? null, method, success, reason ?? null, ip ?? null, userAgent ?? null],
  );
}

/** Brute-force protection (SEC-15): lock account after repeated failures. */
export async function registerFailedLogin(user, ctx) {
  const r = await db.one(
    `UPDATE users SET failed_login_count = failed_login_count + 1,
       locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
     WHERE id = $1 RETURNING failed_login_count, locked_until`,
    [user.id, LOCK_THRESHOLD, String(LOCK_MINUTES)],
  );
  if (r.failed_login_count === LOCK_THRESHOLD)
    await securityEvent({ userId: user.id, type: 'account_locked', severity: 'warning', ip: ctx.ip });
}

export function assertNotLocked(user) {
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const retryAfter = Math.ceil((new Date(user.locked_until) - Date.now()) / 1000);
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', { retryAfterSeconds: retryAfter });
  }
}

/** Choose the organization to activate after login. */
export async function defaultOrgFor(userId, preferredOrgId) {
  const orgs = await listUserOrganizations(userId);
  const active = orgs.filter((o) => o.memberStatus === 'active' && o.status === 'active');
  if (preferredOrgId && active.some((o) => o.id === preferredOrgId)) return { orgId: preferredOrgId, orgs };
  if (active.length === 1) return { orgId: active[0].id, orgs };
  const last = await db.one(
    `SELECT s.organization_id FROM sessions s WHERE s.user_id = $1 AND s.organization_id IS NOT NULL ORDER BY s.created_at DESC LIMIT 1`,
    [userId],
  );
  if (last && active.some((o) => o.id === last.organization_id)) return { orgId: last.organization_id, orgs };
  return { orgId: null, orgs };
}

export async function listUserOrganizations(userId) {
  return db.many(
    `SELECT o.id, o.name, o.slug, o.logo_key AS "logoKey", o.status, m.id AS "memberId", m.status AS "memberStatus",
            r.name AS "roleName", r.base_role AS "baseRole"
     FROM organization_members m JOIN organizations o ON o.id = m.organization_id JOIN roles r ON r.id = m.role_id
     WHERE m.user_id = $1 AND m.deleted_at IS NULL AND o.deleted_at IS NULL ORDER BY o.name`,
    [userId],
  );
}

/** Create a session + tokens (AUTH-08/09). */
export async function createSession({ userId, orgId, rememberMe = false, ip, userAgent, familyId }) {
  const refreshToken = `rt_${randomToken(32)}`;
  const ttl = rememberMe ? env.REFRESH_TTL_REMEMBER_SECONDS : env.REFRESH_TTL_DEFAULT_SECONDS;
  const session = await db.one(
    `INSERT INTO sessions (user_id, organization_id, refresh_token_hash, family_id, ip, user_agent, remember_me, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' seconds')::interval) RETURNING *`,
    [userId, orgId ?? null, sha256(refreshToken), familyId ?? uuid(), ip ?? null, userAgent ?? null, rememberMe, String(ttl)],
  );
  const accessToken = await signAccessToken({ userId, sessionId: session.id, orgId });
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  return { session, accessToken, refreshToken, ttl };
}

/** Rotate a refresh token; detect reuse and revoke the whole family (SEC-01). */
export async function rotateRefreshToken(refreshToken, ctx) {
  if (!refreshToken) throw unauthenticated('Refresh token missing', 'REFRESH_TOKEN_MISSING');
  const s = await db.one('SELECT * FROM sessions WHERE refresh_token_hash = $1', [sha256(refreshToken)]);
  if (!s) throw unauthenticated('Invalid refresh token', 'REFRESH_TOKEN_INVALID');
  if (s.revoked_at) {
    if (s.revoked_reason === 'rotated') {
      await db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'reuse_detected' WHERE family_id = $1 AND revoked_at IS NULL`,
        [s.family_id],
      );
      await securityEvent({ userId: s.user_id, type: 'refresh_token_reuse', severity: 'critical', ip: ctx.ip });
    }
    throw unauthenticated('Session revoked', 'SESSION_REVOKED');
  }
  if (new Date(s.expires_at) < new Date()) throw unauthenticated('Session expired', 'SESSION_EXPIRED');
  const user = await db.one('SELECT status FROM users WHERE id = $1', [s.user_id]);
  if (user?.status !== 'active') throw unauthenticated('Account disabled', 'ACCOUNT_DISABLED');
  // Org idle-timeout (SEC-13)
  if (s.organization_id) {
    const st = await db.one('SELECT session_idle_timeout_minutes AS t FROM organization_settings WHERE organization_id = $1', [
      s.organization_id,
    ]);
    if (st?.t && Date.now() - new Date(s.last_used_at).getTime() > st.t * 60_000) {
      await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'idle_timeout' WHERE id = $1`, [s.id]);
      throw unauthenticated('Session timed out due to inactivity', 'SESSION_EXPIRED');
    }
  }
  return db.tx(async () => {
    const next = await createSession({
      userId: s.user_id,
      orgId: s.organization_id,
      rememberMe: s.remember_me,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      familyId: s.family_id,
    });
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'rotated', replaced_by = $2 WHERE id = $1`, [
      s.id,
      next.session.id,
    ]);
    return next;
  });
}

/** Change the active organization of a session and issue a new access token. */
export async function switchSessionOrg(sessionId, userId, orgId) {
  await db.query('UPDATE sessions SET organization_id = $2, last_used_at = now() WHERE id = $1', [sessionId, orgId]);
  return signAccessToken({ userId, sessionId, orgId });
}

const cookieBase = () => ({ httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax' });

export function setAuthCookies(res, { accessToken, refreshToken, ttl, rememberMe }) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...cookieBase(), path: '/', maxAge: env.ACCESS_TOKEN_TTL_SECONDS * 1000 });
  if (refreshToken)
    res.cookie(REFRESH_COOKIE, refreshToken, {
      ...cookieBase(),
      path: '/api/v1/auth',
      ...(rememberMe ? { maxAge: ttl * 1000 } : {}),
    });
}

export function setAccessCookie(res, accessToken) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...cookieBase(), path: '/', maxAge: env.ACCESS_TOKEN_TTL_SECONDS * 1000 });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase(), path: '/api/v1/auth' });
}

/** Single-use token stored hashed (email verify, password reset, MFA step, WebAuthn challenge). */
export async function createAuthToken(userId, type, ttlSeconds, payload) {
  const token = randomToken(32);
  await db.query(
    `INSERT INTO auth_tokens (user_id, type, token_hash, payload, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)`,
    [userId, type, sha256(token), db.json(payload), String(ttlSeconds)],
  );
  return token;
}

/** Consume a single-use token. Throws if invalid/expired/used. */
export async function consumeAuthToken(token, type) {
  const row = await db.one(
    `UPDATE auth_tokens SET used_at = now()
     WHERE token_hash = $1 AND type = $2 AND used_at IS NULL AND expires_at > now() RETURNING *`,
    [sha256(token ?? ''), type],
  );
  if (!row) throw badRequest('This link or code is invalid or has expired', undefined, 'TOKEN_INVALID');
  return row;
}

export async function sendVerificationEmail(user) {
  await db.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND type = 'email_verify' AND used_at IS NULL`, [user.id]);
  const token = await createAuthToken(user.id, 'email_verify', 48 * 3600);
  const url = `${env.FRONTEND_URL}/verify-email?token=${token}`;
  await sendMail({
    to: user.email,
    subject: 'Verify your email address',
    html: layout({
      title: 'Verify your email',
      body: `<p>Hi ${escapeHtml(user.first_name)}, please confirm your email address to finish setting up Tracker.</p>`,
      actionUrl: url,
      actionLabel: 'Verify email',
    }),
    text: `Verify your email: ${url}`,
  });
  return token;
}

/** Public user DTO. */
export function userDto(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    firstName: u.first_name,
    lastName: u.last_name,
    avatarKey: u.avatar_key,
    phone: u.phone,
    timezone: u.timezone,
    timeFormat: u.time_format,
    dateFormat: u.date_format,
    locale: u.locale,
    emailVerified: !!u.email_verified_at,
    mfaEnabled: u.mfa_enabled,
    isSuperAdmin: u.is_super_admin,
    hasPassword: !!u.password_hash,
    createdAt: u.created_at,
  };
}
