import { describe, it, expect, beforeAll } from 'vitest';
import { generateSync } from 'otplib';
import { setupApp, registerOrg, addMember, request, client, db } from './helpers.js';

let t;
beforeAll(async () => {
  t = await setupApp();
});

describe('Phase 1 — authentication', () => {
  it('registers an org, provisions roles/settings/trial and logs the owner in (AUTH-11)', async () => {
    const o = await registerOrg(t);
    const me = await o.api.get('/api/v1/me').expect(200);
    expect(me.body.data.user.email).toBe(o.email);
    expect(me.body.data.member.role.baseRole).toBe('owner');
    expect(me.body.data.permissions['members.create']).toBe('org');
    expect(me.body.data.subscription.status).toBe('trialing');
    const roles = await o.api.get('/api/v1/roles').expect(200);
    expect(roles.body.data.map((r) => r.slug)).toEqual(expect.arrayContaining(['owner', 'admin', 'manager', 'team_leader', 'employee', 'client']));
    expect(t.outbox.some((m) => m.to === o.email && /Verify/.test(m.subject))).toBe(true);
  });

  it('rejects duplicate registration and validates input', async () => {
    const o = await registerOrg(t);
    const dup = await request(t.app).post('/api/v1/auth/register').send({ firstName: 'A', email: o.email, password: 'Passw0rd!', organizationName: 'X Co' });
    expect(dup.status).toBe(409);
    const bad = await request(t.app).post('/api/v1/auth/register').send({ firstName: '', email: 'nope', password: 'short', organizationName: 'X' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error.details.length).toBeGreaterThan(2);
  });

  it('logs in, rejects bad passwords and locks after 5 failures (AUTH-01, SEC-15)', async () => {
    const o = await registerOrg(t);
    const good = await request(t.app).post('/api/v1/auth/login').send({ email: o.email, password: o.password }).expect(200);
    expect(good.body.data.accessToken).toBeTruthy();
    expect(good.headers['set-cookie'].join(';')).toMatch(/tr_at=.*HttpOnly/);
    for (let i = 0; i < 5; i++) await request(t.app).post('/api/v1/auth/login').send({ email: o.email, password: 'wrong-pass1' }).expect(401);
    const locked = await request(t.app).post('/api/v1/auth/login').send({ email: o.email, password: o.password });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    const hist = await o.api.get('/api/v1/me/login-history').expect(200);
    expect(hist.body.data.some((h) => h.success === false)).toBe(true);
  });

  it('rotates refresh tokens and detects reuse (AUTH-08, SEC-01)', async () => {
    const o = await registerOrg(t);
    const login = await request(t.app).post('/api/v1/auth/login').send({ email: o.email, password: o.password, rememberMe: true }).expect(200);
    const rt = login.headers['set-cookie'].find((c) => c.startsWith('tr_rt=')).split(';')[0].split('=')[1];
    const r1 = await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken: rt }).expect(200);
    expect(r1.body.data.refreshToken).toBeTruthy();
    const reuse = await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken: rt });
    expect(reuse.status).toBe(401);
    // whole family revoked → the rotated token is dead too
    const after = await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken: r1.body.data.refreshToken });
    expect(after.status).toBe(401);
    const ev = await db.one(`SELECT count(*)::int n FROM security_events WHERE type = 'refresh_token_reuse'`);
    expect(ev.n).toBeGreaterThan(0);
  });

  it('sets a session marker cookie on login and clears it on logout', async () => {
    const o = await registerOrg(t);
    const login = await request(t.app).post('/api/v1/auth/login').send({ email: o.email, password: o.password, rememberMe: true }).expect(200);
    const cookies = login.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/tr_session=1; Max-Age=\d+; Path=\//);
    const logout = await request(t.app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${login.body.data.accessToken}`).expect(204);
    expect(logout.headers['set-cookie'].join(';')).toMatch(/tr_session=;/);
  });

  it('logout revokes the session', async () => {
    const o = await registerOrg(t);
    await o.api.post('/api/v1/auth/logout').expect(204);
    const me = await o.api.get('/api/v1/me');
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
  });

  it('forgot/reset password and email verification (AUTH-03/04/05)', async () => {
    const o = await registerOrg(t);
    await request(t.app).post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.com' }).expect(200);
    await request(t.app).post('/api/v1/auth/forgot-password').send({ email: o.email }).expect(200);
    const mail = [...t.outbox].reverse().find((m) => m.to === o.email && /Reset/.test(m.subject));
    const token = mail.text.match(/token=([\w-]+)/)[1];
    await request(t.app).post('/api/v1/auth/reset-password').send({ token, password: 'NewPassw0rd' }).expect(204);
    await request(t.app).post('/api/v1/auth/reset-password').send({ token, password: 'NewPassw0rd2' }).expect(400);
    expect((await o.api.get('/api/v1/me')).status).toBe(401); // sessions revoked
    await request(t.app).post('/api/v1/auth/login').send({ email: o.email, password: 'NewPassw0rd' }).expect(200);

    const v = [...t.outbox].find((m) => m.to === o.email && /Verify/.test(m.subject));
    const vt = v.text.match(/token=([\w-]+)/)[1];
    await request(t.app).post('/api/v1/auth/verify-email').send({ token: vt }).expect(200);
    const u = await db.one('SELECT email_verified_at FROM users WHERE email = $1', [o.email]);
    expect(u.email_verified_at).toBeTruthy();
  });

  it('2FA setup, login challenge, recovery code (AUTH-06)', async () => {
    const o = await registerOrg(t);
    const setup = await o.api.post('/api/v1/me/2fa/setup').expect(200);
    expect(setup.body.data.qrCodeDataUrl).toMatch(/^data:image\/png/);
    const secret = setup.body.data.secret;
    await o.api.post('/api/v1/me/2fa/enable').send({ code: '000000' }).expect(400);
    const en = await o.api.post('/api/v1/me/2fa/enable').send({ code: generateSync({ secret }) }).expect(200);
    expect(en.body.data.recoveryCodes).toHaveLength(10);

    const login = await request(t.app).post('/api/v1/auth/login').send({ email: o.email, password: o.password }).expect(200);
    expect(login.body.data.mfaRequired).toBe(true);
    await request(t.app).post('/api/v1/auth/2fa/verify').send({ mfaToken: login.body.data.mfaToken, code: '123456' }).expect(401);
    const ok = await request(t.app).post('/api/v1/auth/2fa/verify').send({ mfaToken: login.body.data.mfaToken, code: generateSync({ secret }) }).expect(200);
    expect(ok.body.data.accessToken).toBeTruthy();

    const login2 = await request(t.app).post('/api/v1/auth/login').send({ email: o.email, password: o.password }).expect(200);
    const rc = en.body.data.recoveryCodes[0];
    await request(t.app).post('/api/v1/auth/2fa/verify').send({ mfaToken: login2.body.data.mfaToken, recoveryCode: rc }).expect(200);
    const login3 = await request(t.app).post('/api/v1/auth/login').send({ email: o.email, password: o.password }).expect(200);
    await request(t.app).post('/api/v1/auth/2fa/verify').send({ mfaToken: login3.body.data.mfaToken, recoveryCode: rc }).expect(401); // single use
  });

  it('sessions list & revoke others; change password (AUTH-08, AUTH-19)', async () => {
    const o = await registerOrg(t);
    const second = await request(t.app).post('/api/v1/auth/login').send({ email: o.email, password: o.password }).expect(200);
    const list = await o.api.get('/api/v1/me/sessions').expect(200);
    expect(list.body.data.length).toBe(2);
    expect(list.body.data.filter((s) => s.current)).toHaveLength(1);
    await o.api.post('/api/v1/me/change-password').send({ currentPassword: 'bad', newPassword: 'Another1pass' }).expect(400);
    await o.api.post('/api/v1/me/change-password').send({ currentPassword: o.password, newPassword: 'Another1pass' }).expect(204);
    expect((await client(t.app, second.body.data.accessToken).get('/api/v1/me')).status).toBe(401);
    await o.api.get('/api/v1/me').expect(200);
  });
});

describe('Phase 1 — invitations, multi-org, RBAC', () => {
  it('invites by email, accepts, and the member gets employee permissions (AUTH-14/16)', async () => {
    const o = await registerOrg(t);
    const e = await addMember(t, o, { role: 'employee' });
    const me = await e.api.get('/api/v1/me').expect(200);
    expect(me.body.data.member.role.baseRole).toBe('employee');
    expect(me.body.data.permissions['timer.use']).toBe('own');
    expect(me.body.data.permissions['roles.manage']).toBeUndefined();
    await e.api.get('/api/v1/roles/' + o.roles.owner).expect(403);
    await e.api.post('/api/v1/invitations').send({ email: 'x@example.com', roleId: o.roles.employee }).expect(403);
  });

  it('prevents role escalation and owner grants by non-owners (RBAC-09)', async () => {
    const o = await registerOrg(t);
    const admin = await addMember(t, o, { role: 'admin' });
    const r = await admin.api.post('/api/v1/invitations').send({ email: 'boss@example.com', roleId: o.roles.owner });
    expect(r.status).toBe(403);
  });

  it('invite links with max uses (AUTH-15)', async () => {
    const o = await registerOrg(t);
    const link = await o.api.post('/api/v1/invitations/links').send({ roleId: o.roles.employee, maxUses: 1 }).expect(201);
    const token = link.body.data.token;
    const prev = await request(t.app).get(`/api/v1/invitations/token/${token}`).expect(200);
    expect(prev.body.data.status).toBe('pending');
    await request(t.app).post(`/api/v1/invitations/token/${token}/accept`).send({ email: 'link1@example.com', firstName: 'L', password: 'Passw0rd!' }).expect(200);
    const second = await request(t.app).post(`/api/v1/invitations/token/${token}/accept`).send({ email: 'link2@example.com', firstName: 'L', password: 'Passw0rd!' });
    expect(second.status).toBe(410);
  });

  it('existing user accepts invite into a second org and switches orgs (AUTH-10)', async () => {
    const a = await registerOrg(t);
    const b = await registerOrg(t);
    await b.api.post('/api/v1/invitations').send({ email: a.email, roleId: b.roles.manager }).expect(201);
    const token = [...t.outbox].reverse().find((m) => m.to === a.email && /invited/.test(m.subject)).text.match(/invite\/(inv_[\w-]+)/)[1];
    const notif = await db.one(`SELECT count(*)::int n FROM notifications WHERE recipient_user_id = $1 AND type = 'invitation.received'`, [a.user.id]);
    expect(notif.n).toBe(1);
    await a.api.post(`/api/v1/invitations/token/${token}/accept`).send({}).expect(200);
    const orgs = await a.api.get('/api/v1/me/organizations').expect(200);
    expect(orgs.body.data).toHaveLength(2);
    const sw = await a.api.post('/api/v1/auth/switch-organization').send({ organizationId: b.orgId }).expect(200);
    const me = await client(t.app, sw.body.data.accessToken).get('/api/v1/me').expect(200);
    expect(me.body.data.organization.id).toBe(b.orgId);
    expect(me.body.data.member.role.baseRole).toBe('manager');
  });

  it('isolates organizations (SEC-21)', async () => {
    const a = await registerOrg(t);
    const b = await registerOrg(t);
    const r = await a.api.get(`/api/v1/roles/${b.roles.owner}`);
    expect(r.status).toBe(404);
    const sw = await a.api.post('/api/v1/auth/switch-organization').send({ organizationId: b.orgId });
    expect(sw.status).toBe(403);
  });

  it('custom roles: create, set grants, cannot edit system roles (RBAC-02/03)', async () => {
    const o = await registerOrg(t);
    const c = await o.api.post('/api/v1/roles').send({ name: 'Auditor', cloneFromRoleId: o.roles.employee }).expect(201);
    expect(c.body.data.permissions['timer.use']).toBe('own');
    const upd = await o.api.put(`/api/v1/roles/${c.body.data.id}/permissions`).send({ grants: [{ permission: 'reports.view', scope: 'org' }, { permission: 'audit.view', scope: 'org' }] }).expect(200);
    expect(Object.keys(upd.body.data.permissions)).toEqual(['audit.view', 'reports.view']);
    await o.api.put(`/api/v1/roles/${o.roles.owner}/permissions`).send({ grants: [] }).expect(403);
    await o.api.put(`/api/v1/roles/${c.body.data.id}/permissions`).send({ grants: [{ permission: 'audit.view', scope: 'own' }] }).expect(400);
    await o.api.delete(`/api/v1/roles/${c.body.data.id}`).expect(204);
  });

  it('serves OpenAPI docs and health', async () => {
    const h = await request(t.app).get('/health').expect(200);
    expect(h.body.database).toBe('ok');
    const spec = await request(t.app).get('/api/openapi.json').expect(200);
    expect(Object.keys(spec.body.paths).length).toBeGreaterThan(40);
  });

  it('signed upload + download for an avatar', async () => {
    const o = await registerOrg(t);
    const up = await o.api.post('/api/v1/me/avatar/upload-url').send({ contentType: 'image/png', size: 4 }).expect(200);
    const path = new URL(up.body.data.uploadUrl);
    await request(t.app).put(path.pathname + path.search).set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3, 4])).expect(200);
    const p = await o.api.patch('/api/v1/me').send({ avatarKey: up.body.data.key }).expect(200);
    const dl = new URL(p.body.data.avatarUrl);
    const file = await request(t.app).get(dl.pathname + dl.search).expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    const tampered = dl.search.replace(/sig=[^&]+/, 'sig=bad');
    await request(t.app).get(dl.pathname + tampered).expect(403);
  });
});
