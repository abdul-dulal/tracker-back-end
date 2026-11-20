import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { verify as verifyTotp } from 'otplib';
import { createRouter, zTimezone, zCurrency } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { env } from '../../config/env.js';
import { ok, created, noContent } from '../../lib/http.js';
import { hashPassword, verifyPassword, passwordSchema } from '../../lib/password.js';
import { sha256, decrypt } from '../../lib/crypto.js';
import { signToken, verifyToken } from '../../lib/jwt.js';
import { badRequest, unauthenticated, conflict, forbidden, AppError } from '../../lib/errors.js';
import { sendMail, layout } from '../../lib/mailer.js';
import { audit } from '../../lib/audit.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { REFRESH_COOKIE } from '../../middleware/authenticate.js';
import { provisionOrganization } from '../organizations/provision.js';
import { loadMemberContext } from '../../rbac/context.js';
import {
  recordLogin,
  registerFailedLogin,
  assertNotLocked,
  defaultOrgFor,
  createSession,
  rotateRefreshToken,
  switchSessionOrg,
  setAuthCookies,
  setAccessCookie,
  clearAuthCookies,
  createAuthToken,
  consumeAuthToken,
  sendVerificationEmail,
  userDto,
  listUserOrganizations,
} from './service.js';

const r = createRouter('/auth', 'Auth');

const email = z.email().max(254).transform((v) => v.trim().toLowerCase());

/** Finish a successful authentication: session, cookies, history, response body. */
async function completeLogin(req, res, user, { method, rememberMe = false, preferredOrgId } = {}) {
  const { orgId, orgs } = await defaultOrgFor(user.id, preferredOrgId);
  const tokens = await createSession({
    userId: user.id,
    orgId,
    rememberMe,
    ip: req.ctx.ip,
    userAgent: req.ctx.userAgent,
  });
  await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
  await recordLogin({ userId: user.id, email: user.email, method, success: true, ip: req.ctx.ip, userAgent: req.ctx.userAgent });
  setAuthCookies(res, { ...tokens, rememberMe });
  return {
    user: userDto(user),
    organizations: orgs,
    activeOrganizationId: orgId,
    requiresOrganizationSelection: !orgId && orgs.length > 1,
    accessToken: tokens.accessToken,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}

/** If the user has MFA, return an MFA challenge instead of a session. */
async function mfaChallenge(user, { rememberMe, method }) {
  const mfaToken = await createAuthToken(user.id, 'mfa_login', 5 * 60, { rememberMe, method });
  return { mfaRequired: true, mfaToken, methods: ['totp', 'recovery_code'] };
}

// ─── AUTH-11 Organization registration ───────────────────────────────────────
r.post(
  '/register',
  {
    auth: 'public',
    summary: 'Register a user and a new organization',
    ids: 'AUTH-11, AUTH-05',
    middleware: authLimiter,
    body: z.object({
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().max(100).default(''),
      email,
      password: passwordSchema,
      organizationName: z.string().trim().min(2).max(150),
      timezone: zTimezone.default('UTC'),
      currency: zCurrency.default('USD'),
      industry: z.string().max(80).optional(),
      size: z.string().max(20).optional(),
      country: z.string().length(2).optional(),
    }),
  },
  async (req, res) => {
    const b = req.body;
    if (await db.one('SELECT 1 FROM users WHERE email = $1', [b.email]))
      throw conflict('EMAIL_TAKEN', 'An account with this email already exists. Please log in instead.');
    const user = await db.tx(async () => {
      const u = await db.one(
        `INSERT INTO users (email, password_hash, first_name, last_name, timezone) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [b.email, await hashPassword(b.password), b.firstName, b.lastName, b.timezone],
      );
      await provisionOrganization({
        name: b.organizationName,
        ownerUserId: u.id,
        timezone: b.timezone,
        currency: b.currency,
        industry: b.industry,
        size: b.size,
        country: b.country,
      });
      return u;
    });
    await sendVerificationEmail(user);
    const result = await completeLogin(req, res, user, { method: 'password' });
    res.status(201).json({ data: result });
  },
);

// ─── AUTH-01 / AUTH-09 Login ─────────────────────────────────────────────────
r.post(
  '/login',
  {
    auth: 'public',
    summary: 'Email & password login',
    ids: 'AUTH-01, AUTH-09, SEC-15',
    middleware: authLimiter,
    body: z.object({ email, password: z.string().min(1).max(200), rememberMe: z.boolean().default(false), organizationId: z.uuid().optional() }),
  },
  async (req, res) => {
    const { email: em, password, rememberMe, organizationId } = req.body;
    const user = await db.one('SELECT * FROM users WHERE email = $1', [em]);
    if (!user) {
      await recordLogin({ email: em, method: 'password', success: false, reason: 'unknown_email', ip: req.ctx.ip, userAgent: req.ctx.userAgent });
      throw unauthenticated('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    assertNotLocked(user);
    if (!(await verifyPassword(user.password_hash, password))) {
      await registerFailedLogin(user, req.ctx);
      await recordLogin({ userId: user.id, email: em, method: 'password', success: false, reason: 'bad_password', ip: req.ctx.ip, userAgent: req.ctx.userAgent });
      throw unauthenticated('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (user.status !== 'active') throw forbidden('This account has been disabled', 'ACCOUNT_DISABLED');
    if (user.mfa_enabled) return ok(res, await mfaChallenge(user, { rememberMe, method: 'password' }));
    ok(res, await completeLogin(req, res, user, { method: 'password', rememberMe, preferredOrgId: organizationId }));
  },
);

// ─── AUTH-06 2FA login step ─────────────────────────────────────────────────
r.post(
  '/2fa/verify',
  {
    auth: 'public',
    summary: 'Complete login with a TOTP code or recovery code',
    ids: 'AUTH-06',
    middleware: authLimiter,
    body: z
      .object({ mfaToken: z.string().min(10), code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(6).max(40).optional() })
      .refine((v) => v.code || v.recoveryCode, 'Provide code or recoveryCode'),
  },
  async (req, res) => {
    const { mfaToken, code, recoveryCode } = req.body;
    const tok = await db.one(
      `SELECT * FROM auth_tokens WHERE token_hash = $1 AND type = 'mfa_login' AND used_at IS NULL AND expires_at > now()`,
      [sha256(mfaToken)],
    );
    if (!tok) throw unauthenticated('MFA session expired. Please log in again.', 'MFA_TOKEN_INVALID');
    const user = await db.one('SELECT * FROM users WHERE id = $1', [tok.user_id]);
    assertNotLocked(user);
    const mfa = await db.one('SELECT * FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL', [user.id]);
    if (!mfa) throw badRequest('Two-factor authentication is not enabled');
    let valid = false;
    if (code) {
      valid = (await verifyTotp({ secret: decrypt(mfa.totp_secret_enc), token: code, epochTolerance: 30 })).valid;
    } else {
      const h = sha256(recoveryCode.replace(/[\s-]/g, '').toLowerCase());
      if (mfa.recovery_codes_hash.includes(h)) {
        valid = true;
        await db.query('UPDATE user_mfa SET recovery_codes_hash = array_remove(recovery_codes_hash, $2) WHERE user_id = $1', [user.id, h]);
      }
    }
    if (!valid) {
      await registerFailedLogin(user, req.ctx);
      await recordLogin({ userId: user.id, email: user.email, method: 'mfa', success: false, reason: 'bad_code', ip: req.ctx.ip, userAgent: req.ctx.userAgent });
      throw unauthenticated('Invalid verification code', 'INVALID_MFA_CODE');
    }
    await db.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [tok.id]);
    ok(res, await completeLogin(req, res, user, { method: tok.payload?.method ?? 'password', rememberMe: !!tok.payload?.rememberMe }));
  },
);

// ─── AUTH-08 Refresh / logout ────────────────────────────────────────────────
r.post(
  '/refresh',
  {
    auth: 'public',
    summary: 'Rotate refresh token (cookie or body) and issue new access token',
    ids: 'AUTH-08, SEC-01',
    body: z.object({ refreshToken: z.string().optional() }),
  },
  async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] ?? req.body.refreshToken;
    try {
      const next = await rotateRefreshToken(token, req.ctx);
      setAuthCookies(res, { ...next, rememberMe: next.session.remember_me });
      ok(res, {
        accessToken: next.accessToken,
        refreshToken: req.body.refreshToken ? next.refreshToken : undefined,
        expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
        activeOrganizationId: next.session.organization_id,
      });
    } catch (err) {
      clearAuthCookies(res);
      throw err;
    }
  },
);

r.post('/logout', { auth: 'optional', summary: 'Revoke current session', ids: 'AUTH-08' }, async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (req.ctx.sessionId)
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`, [req.ctx.sessionId]);
  else if (token)
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE refresh_token_hash = $1 AND revoked_at IS NULL`, [
      sha256(token),
    ]);
  clearAuthCookies(res);
  noContent(res);
});

// ─── AUTH-10 Switch organization ─────────────────────────────────────────────
r.post(
  '/switch-organization',
  { auth: 'user', summary: 'Set the active organization for this session', ids: 'AUTH-10', body: z.object({ organizationId: z.uuid() }) },
  async (req, res) => {
    const m = await loadMemberContext(req.ctx.userId, req.body.organizationId);
    if (!m) throw forbidden('You are not a member of this organization', 'NOT_A_MEMBER');
    if (m.memberStatus !== 'active') throw forbidden('Your membership in this organization is not active', 'MEMBER_INACTIVE');
    if (m.orgStatus !== 'active') throw forbidden('This organization is suspended', 'ORG_SUSPENDED');
    const accessToken = await switchSessionOrg(req.ctx.sessionId, req.ctx.userId, req.body.organizationId);
    setAccessCookie(res, accessToken);
    ok(res, { accessToken, activeOrganizationId: req.body.organizationId, role: m.role, permissions: Object.fromEntries(m.perms) });
  },
);

// ─── AUTH-03 / AUTH-04 Password reset ────────────────────────────────────────
r.post(
  '/forgot-password',
  { auth: 'public', summary: 'Send password reset email (always 200)', ids: 'AUTH-03', middleware: authLimiter, body: z.object({ email }) },
  async (req, res) => {
    const user = await db.one(`SELECT * FROM users WHERE email = $1 AND status = 'active'`, [req.body.email]);
    if (user) {
      await db.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND type = 'password_reset' AND used_at IS NULL`, [user.id]);
      const token = await createAuthToken(user.id, 'password_reset', 30 * 60);
      const url = `${env.FRONTEND_URL}/reset-password?token=${token}`;
      await sendMail({
        to: user.email,
        subject: 'Reset your Tracker password',
        html: layout({ title: 'Reset your password', body: '<p>Use the button below to choose a new password. The link expires in 30 minutes.</p><p>If you did not request this, you can ignore this email.</p>', actionUrl: url, actionLabel: 'Reset password' }),
        text: `Reset your password: ${url}`,
      });
    }
    ok(res, { message: 'If an account exists for this email, a reset link has been sent.' });
  },
);

r.post(
  '/reset-password',
  { auth: 'public', summary: 'Reset password with token; revokes all sessions', ids: 'AUTH-04', middleware: authLimiter, body: z.object({ token: z.string().min(10), password: passwordSchema }) },
  async (req, res) => {
    const tok = await consumeAuthToken(req.body.token, 'password_reset');
    await db.query(
      `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL,
         email_verified_at = coalesce(email_verified_at, now()), updated_at = now() WHERE id = $1`,
      [tok.user_id, await hashPassword(req.body.password)],
    );
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL`, [tok.user_id]);
    await audit({ userId: tok.user_id, ip: req.ctx.ip }, 'user.password_reset', { entityType: 'user', entityId: tok.user_id });
    noContent(res);
  },
);

// ─── AUTH-05 Email verification ──────────────────────────────────────────────
r.post(
  '/verify-email',
  { auth: 'public', summary: 'Verify email with token', ids: 'AUTH-05', body: z.object({ token: z.string().min(10) }) },
  async (req, res) => {
    const tok = await consumeAuthToken(req.body.token, 'email_verify');
    await db.query('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [tok.user_id]);
    ok(res, { verified: true });
  },
);

r.post('/resend-verification', { auth: 'user', summary: 'Resend verification email', ids: 'AUTH-05', middleware: authLimiter }, async (req, res) => {
  const user = await db.one('SELECT * FROM users WHERE id = $1', [req.ctx.userId]);
  if (user.email_verified_at) throw badRequest('Email already verified', undefined, 'ALREADY_VERIFIED');
  await sendVerificationEmail(user);
  noContent(res);
});

// ─── AUTH-02 Google OAuth ────────────────────────────────────────────────────
const googleClient = () => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    throw new AppError(501, 'GOOGLE_NOT_CONFIGURED', 'Google login is not configured on this server');
  return new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, `${env.APP_URL}/api/v1/auth/google/callback`);
};

/** Find or create a user from a verified Google identity; link the oauth account. */
async function upsertGoogleUser(payload) {
  if (!payload?.email || !payload.email_verified) throw badRequest('Google account email is not verified', undefined, 'GOOGLE_EMAIL_UNVERIFIED');
  return db.tx(async () => {
    const linked = await db.one(
      `SELECT u.* FROM oauth_accounts o JOIN users u ON u.id = o.user_id WHERE o.provider = 'google' AND o.provider_user_id = $1`,
      [payload.sub],
    );
    if (linked) return { user: linked, isNew: false };
    let user = await db.one('SELECT * FROM users WHERE email = $1', [payload.email.toLowerCase()]);
    let isNew = false;
    if (!user) {
      user = await db.one(
        `INSERT INTO users (email, first_name, last_name, email_verified_at) VALUES ($1,$2,$3, now()) RETURNING *`,
        [payload.email.toLowerCase(), payload.given_name ?? payload.name ?? 'User', payload.family_name ?? ''],
      );
      isNew = true;
    } else if (!user.email_verified_at) {
      await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [user.id]);
    }
    await db.query(
      `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email) VALUES ($1,'google',$2,$3) ON CONFLICT DO NOTHING`,
      [user.id, payload.sub, payload.email],
    );
    return { user, isNew };
  });
}

r.get(
  '/google',
  { auth: 'public', summary: 'Start Google OAuth (302 redirect)', ids: 'AUTH-02', query: z.object({ redirect: z.string().startsWith('/').max(300).default('/dashboard'), rememberMe: z.enum(['true', 'false']).default('true') }) },
  async (req, res) => {
    const client = googleClient();
    const state = await signToken({ redirect: req.v.query.redirect, rememberMe: req.v.query.rememberMe === 'true' }, 600, 'oauth-state');
    res.redirect(client.generateAuthUrl({ scope: ['openid', 'email', 'profile'], state, prompt: 'select_account' }));
  },
);

r.get(
  '/google/callback',
  { auth: 'public', summary: 'Google OAuth callback', ids: 'AUTH-02', query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }) },
  async (req, res) => {
    const fail = (code) => res.redirect(`${env.FRONTEND_URL}/login?error=${code}`);
    if (req.v.query.error || !req.v.query.code || !req.v.query.state) return fail('google_cancelled');
    let state;
    try {
      state = await verifyToken(req.v.query.state, 'oauth-state');
    } catch {
      return fail('google_state_invalid');
    }
    const client = googleClient();
    const { tokens } = await client.getToken(req.v.query.code);
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
    const { user } = await upsertGoogleUser(ticket.getPayload());
    if (user.status !== 'active') return fail('account_disabled');
    if (user.mfa_enabled) {
      const ch = await mfaChallenge(user, { rememberMe: state.rememberMe, method: 'google' });
      return res.redirect(`${env.FRONTEND_URL}/login/2fa?mfaToken=${encodeURIComponent(ch.mfaToken)}`);
    }
    const result = await completeLogin(req, res, user, { method: 'google', rememberMe: state.rememberMe });
    const dest = result.requiresOrganizationSelection ? '/select-organization' : result.organizations.length ? state.redirect : '/onboarding';
    res.redirect(`${env.FRONTEND_URL}${dest}`);
  },
);

r.post(
  '/google/token',
  { auth: 'public', summary: 'Login with a Google ID token (Google Identity Services)', ids: 'AUTH-02', middleware: authLimiter, body: z.object({ idToken: z.string().min(20), rememberMe: z.boolean().default(true) }) },
  async (req, res) => {
    if (!env.GOOGLE_CLIENT_ID) throw new AppError(501, 'GOOGLE_NOT_CONFIGURED', 'Google login is not configured on this server');
    const client = new OAuth2Client(env.GOOGLE_CLIENT_ID);
    let payload;
    try {
      payload = (await client.verifyIdToken({ idToken: req.body.idToken, audience: env.GOOGLE_CLIENT_ID })).getPayload();
    } catch {
      throw unauthenticated('Invalid Google token', 'GOOGLE_TOKEN_INVALID');
    }
    const { user, isNew } = await upsertGoogleUser(payload);
    if (user.status !== 'active') throw forbidden('This account has been disabled', 'ACCOUNT_DISABLED');
    if (user.mfa_enabled) return ok(res, await mfaChallenge(user, { rememberMe: req.body.rememberMe, method: 'google' }));
    ok(res, { ...(await completeLogin(req, res, user, { method: 'google', rememberMe: req.body.rememberMe })), isNewUser: isNew });
  },
);

/** Create an organization for a logged-in user (e.g. after Google sign-up with no org). */
r.post(
  '/organizations',
  {
    auth: 'user',
    summary: 'Create an additional organization for the current user',
    ids: 'AUTH-10, AUTH-11',
    body: z.object({ name: z.string().trim().min(2).max(150), timezone: zTimezone.default('UTC'), currency: zCurrency.default('USD'), industry: z.string().max(80).optional(), size: z.string().max(20).optional() }),
  },
  async (req, res) => {
    const { org } = await provisionOrganization({ ...req.body, ownerUserId: req.ctx.userId });
    const accessToken = await switchSessionOrg(req.ctx.sessionId, req.ctx.userId, org.id);
    setAccessCookie(res, accessToken);
    created(res, { organization: { id: org.id, name: org.name, slug: org.slug }, accessToken });
  },
);

// ─── AUTH-07 Passkeys (WebAuthn) ─────────────────────────────────────────────
const rp = () => ({ rpName: env.WEBAUTHN_RP_NAME, rpID: env.WEBAUTHN_RP_ID, origin: env.WEBAUTHN_ORIGIN });

r.post('/passkeys/register/options', { auth: 'user', summary: 'Passkey registration options', ids: 'AUTH-07' }, async (req, res) => {
  const creds = await db.many('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1', [req.ctx.userId]);
  const options = await generateRegistrationOptions({
    rpName: rp().rpName,
    rpID: rp().rpID,
    userName: req.ctx.user.email,
    userDisplayName: `${req.ctx.user.firstName} ${req.ctx.user.lastName}`.trim(),
    userID: new TextEncoder().encode(req.ctx.userId),
    attestationType: 'none',
    excludeCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const challengeId = await createAuthToken(req.ctx.userId, 'webauthn_challenge', 300, { challenge: options.challenge, purpose: 'register' });
  ok(res, { options, challengeId });
});

r.post(
  '/passkeys/register/verify',
  { auth: 'user', summary: 'Verify passkey registration', ids: 'AUTH-07', body: z.object({ challengeId: z.string(), response: z.any(), name: z.string().trim().max(100).default('Passkey') }) },
  async (req, res) => {
    const tok = await consumeAuthToken(req.body.challengeId, 'webauthn_challenge');
    if (tok.user_id !== req.ctx.userId || tok.payload?.purpose !== 'register') throw badRequest('Challenge mismatch');
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: req.body.response,
        expectedChallenge: tok.payload.challenge,
        expectedOrigin: rp().origin,
        expectedRPID: rp().rpID,
      });
    } catch (err) {
      throw badRequest(`Passkey verification failed: ${err.message}`, undefined, 'PASSKEY_INVALID');
    }
    if (!verification.verified) throw badRequest('Passkey verification failed', undefined, 'PASSKEY_INVALID');
    const { credential } = verification.registrationInfo;
    const row = await db.one(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, name)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, created_at`,
      [req.ctx.userId, credential.id, Buffer.from(credential.publicKey).toString('base64url'), credential.counter, credential.transports ?? [], req.body.name],
    );
    await audit(req.ctx, 'user.passkey_added', { entityType: 'user', entityId: req.ctx.userId });
    created(res, { id: row.id, name: row.name, createdAt: row.created_at });
  },
);

r.post('/passkeys/login/options', { auth: 'public', summary: 'Passkey login options', ids: 'AUTH-07', middleware: authLimiter }, async (req, res) => {
  const options = await generateAuthenticationOptions({ rpID: rp().rpID, userVerification: 'preferred' });
  const challengeId = await createAuthToken(null, 'webauthn_challenge', 300, { challenge: options.challenge, purpose: 'login' });
  ok(res, { options, challengeId });
});

r.post(
  '/passkeys/login/verify',
  { auth: 'public', summary: 'Login with a passkey', ids: 'AUTH-07', middleware: authLimiter, body: z.object({ challengeId: z.string(), response: z.any(), rememberMe: z.boolean().default(false) }) },
  async (req, res) => {
    const tok = await consumeAuthToken(req.body.challengeId, 'webauthn_challenge');
    if (tok.payload?.purpose !== 'login') throw badRequest('Challenge mismatch');
    const cred = await db.one('SELECT * FROM webauthn_credentials WHERE credential_id = $1', [req.body.response?.id ?? '']);
    if (!cred) throw unauthenticated('Unknown passkey', 'PASSKEY_UNKNOWN');
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: req.body.response,
        expectedChallenge: tok.payload.challenge,
        expectedOrigin: rp().origin,
        expectedRPID: rp().rpID,
        credential: { id: cred.credential_id, publicKey: Buffer.from(cred.public_key, 'base64url'), counter: Number(cred.counter), transports: cred.transports },
      });
    } catch (err) {
      throw unauthenticated(`Passkey verification failed: ${err.message}`, 'PASSKEY_INVALID');
    }
    if (!verification.verified) throw unauthenticated('Passkey verification failed', 'PASSKEY_INVALID');
    await db.query('UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1', [cred.id, verification.authenticationInfo.newCounter]);
    const user = await db.one('SELECT * FROM users WHERE id = $1', [cred.user_id]);
    if (user.status !== 'active') throw forbidden('This account has been disabled', 'ACCOUNT_DISABLED');
    // A passkey with user verification satisfies MFA.
    ok(res, await completeLogin(req, res, user, { method: 'passkey', rememberMe: req.body.rememberMe }));
  },
);

r.get('/organizations', { auth: 'user', summary: 'Organizations of current user', ids: 'AUTH-10' }, async (req, res) => {
  ok(res, await listUserOrganizations(req.ctx.userId));
});

export default r;
