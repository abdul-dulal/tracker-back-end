import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';

let t;
let sa;
let owner;
let emp;
beforeAll(async () => {
  t = await setupApp();
  sa = await registerOrg(t);
  await db.query('UPDATE users SET is_super_admin = true WHERE id = $1', [sa.user.id]);
  owner = await registerOrg(t);
  emp = await addMember(t, owner, { role: 'employee' });
});

const lastAudit = (action) => db.one(`SELECT * FROM audit_logs WHERE action = $1 ORDER BY created_at DESC LIMIT 1`, [action]);

describe('Platform (Super Admin, F.18)', () => {
  it('requires super admin on every endpoint', async () => {
    for (const path of ['/stats', '/organizations', '/users', '/plans', '/subscriptions', '/audit-logs', '/security-events', '/app-releases', '/health']) {
      const r = await owner.api.get(`/api/v1/platform${path}`);
      expect(r.status, path).toBe(403);
    }
    await owner.api.patch(`/api/v1/platform/organizations/${owner.orgId}`).send({ status: 'suspended' }).expect(403);
  });

  it('stats, organizations list/detail', async () => {
    const s = await sa.api.get('/api/v1/platform/stats').expect(200);
    expect(s.body.data.organizations.total).toBeGreaterThanOrEqual(2);
    expect(s.body.data.users.total).toBeGreaterThanOrEqual(3);
    expect(s.body.data.subscriptionsByPlan.professional.trialing).toBeGreaterThanOrEqual(2);
    expect(typeof s.body.data.mrrEstimate).toBe('number');
    const orgName = (await db.one('SELECT name FROM organizations WHERE id = $1', [owner.orgId])).name;
    const list = await sa.api.get(`/api/v1/platform/organizations?search=${encodeURIComponent(orgName)}`).expect(200);
    expect(list.body.data.map((o) => o.id)).toEqual([owner.orgId]);
    expect(list.body.data[0]).toMatchObject({ memberCount: 2, subscription: { plan: 'professional', status: 'trialing' } });
    const d = await sa.api.get(`/api/v1/platform/organizations/${owner.orgId}`).expect(200);
    expect(d.body.data.seatsUsed).toBe(2);
  });

  it('suspends/activates, extends trial and changes plan (audited as super_admin)', async () => {
    const before = await db.one('SELECT trial_ends_at FROM subscriptions WHERE organization_id = $1', [owner.orgId]);
    await sa.api.patch(`/api/v1/platform/organizations/${owner.orgId}`).send({ status: 'suspended', reason: 'abuse' }).expect(200);
    const blocked = await emp.api.get('/api/v1/notifications');
    expect([401, 403]).toContain(blocked.status);
    const a = await lastAudit('platform.organization.update');
    expect(a).toMatchObject({ actor_type: 'super_admin', actor_user_id: sa.user.id, organization_id: owner.orgId });
    await sa.api.patch(`/api/v1/platform/organizations/${owner.orgId}`).send({ status: 'active' }).expect(200);

    const ext = await sa.api.patch(`/api/v1/platform/organizations/${owner.orgId}`).send({ extendTrialDays: 10 }).expect(200);
    expect(new Date(ext.body.data.subscription.trialEndsAt) - new Date(before.trial_ends_at)).toBeGreaterThan(9 * 86_400_000);
    const plan = await sa.api.patch(`/api/v1/platform/organizations/${owner.orgId}`).send({ planCode: 'enterprise' }).expect(200);
    expect(plan.body.data.subscription.plan).toBe('enterprise');
    await sa.api.patch(`/api/v1/platform/organizations/${owner.orgId}`).send({}).expect(400);
  });

  it('users search, disable (revokes sessions) and enable', async () => {
    // the earlier org suspension revoked that org's sessions → use a fresh org
    emp = await addMember(t, await registerOrg(t), { role: 'employee' });
    const list = await sa.api.get(`/api/v1/platform/users?search=${encodeURIComponent(emp.email)}`).expect(200);
    expect(list.body.data).toHaveLength(1);
    const dis = await sa.api.patch(`/api/v1/platform/users/${emp.user.id}`).send({ status: 'disabled' }).expect(200);
    expect(dis.body.data.status).toBe('disabled');
    expect(dis.body.data.sessionsRevoked).toBeGreaterThan(0);
    expect((await emp.api.get('/api/v1/me')).status).toBe(401);
    await sa.api.patch(`/api/v1/platform/users/${emp.user.id}`).send({ status: 'active' }).expect(200);
    await sa.api.patch(`/api/v1/platform/users/${sa.user.id}`).send({ status: 'disabled' }).expect(400);
    expect((await lastAudit('platform.user.update')).actor_type).toBe('super_admin');
  });

  it('plans, subscriptions, audit logs, security events', async () => {
    const plans = await sa.api.get('/api/v1/platform/plans').expect(200);
    const starter = plans.body.data.find((p) => p.code === 'starter');
    const upd = await sa.api.patch(`/api/v1/platform/plans/${starter.id}`).send({ priceMonth: 6, stripePriceMonthId: 'price_123' }).expect(200);
    expect(upd.body.data).toMatchObject({ priceMonth: 6, stripePriceMonthId: 'price_123' });
    const dup = await sa.api.post('/api/v1/platform/plans').send({ code: 'starter', name: 'S2', priceMonth: 1, priceYear: 10, limits: { maxSeats: 5, storageGb: 1, screenshotRetentionDays: 7 }, features: {} });
    expect(dup.status).toBe(409);
    const subs = await sa.api.get('/api/v1/platform/subscriptions?status=trialing').expect(200);
    expect(subs.body.data.every((s) => s.status === 'trialing')).toBe(true);
    const logs = await sa.api.get('/api/v1/platform/audit-logs?actorType=super_admin').expect(200);
    expect(logs.body.data.length).toBeGreaterThan(0);
    const scoped = await sa.api.get(`/api/v1/platform/audit-logs?organizationId=${owner.orgId}`).expect(200);
    expect(scoped.body.data.every((l) => l.organizationId === owner.orgId)).toBe(true);
    await db.query(`INSERT INTO security_events (user_id, type, severity) VALUES ($1, 'test_event', 'warning')`, [emp.user.id]);
    const ev = await sa.api.get('/api/v1/platform/security-events?type=test_event').expect(200);
    expect(ev.body.data[0]).toMatchObject({ type: 'test_event', severity: 'warning' });
  });

  it('app releases CRUD and health', async () => {
    const bad = await sa.api.post('/api/v1/platform/app-releases').send({ os: 'windows', version: 'x', url: 'http://a' });
    expect(bad.status).toBe(400);
    const rel = await sa.api.post('/api/v1/platform/app-releases').send({ os: 'windows', version: '1.2.3', url: 'https://dl.example.com/t.exe', minSupported: true }).expect(201);
    const list = await sa.api.get('/api/v1/platform/app-releases?os=windows').expect(200);
    expect(list.body.data.map((r) => r.version)).toContain('1.2.3');
    await sa.api.delete(`/api/v1/platform/app-releases/${rel.body.data.id}`).expect(204);
    await sa.api.delete(`/api/v1/platform/app-releases/${rel.body.data.id}`).expect(404);
    const h = await sa.api.get('/api/v1/platform/health').expect(200);
    expect(h.body.data.database.status).toBe('ok');
    expect(h.body.data.jobs).toHaveProperty('queued');
    expect(h.body.data.jobs).toHaveProperty('failedLast24h');
  });
});
