import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';

let t;
beforeAll(async () => {
  t = await setupApp();
});

const API = '/api/v1';

describe('Tracking settings (SET-T01…SET-T12)', () => {
  it('upserts per scope with validation, plan limits, version bump, audit and realtime', async () => {
    const o = await registerOrg(t);
    const org = await o.api.get(`${API}/tracking-settings?scopeType=org`).expect(200);
    expect(org.body.data).toMatchObject({ scopeType: 'org', scopeId: null, screenshotIntervalMinutes: 10, version: 1 });

    const before = t.emitted.length;
    const put = await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'org', screenshotIntervalMinutes: 5, screenshotBlur: true }).expect(200);
    expect(put.body.data).toMatchObject({ screenshotIntervalMinutes: 5, screenshotBlur: true, version: 2, idleThresholdMinutes: 5 });
    expect(t.emitted.slice(before).some((e) => e.event === 'settings.updated' && e.room === `org:${o.orgId}`)).toBe(true);
    expect((await db.one(`SELECT count(*)::int n FROM audit_logs WHERE action = 'tracking_settings.updated' AND organization_id = $1`, [o.orgId])).n).toBe(1);

    // validation
    await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'org', screenshotIntervalMinutes: 7 }).expect(400);
    await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'org', idleThresholdMinutes: 0 }).expect(400);
    await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'team' }).expect(400); // scopeId required
    await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'team', scopeId: '00000000-0000-0000-0000-000000000000' }).expect(404);
    // plan limits (starter plan: interval ≥ 5, retention ≤ 30)
    await db.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'starter'), status = 'active' WHERE organization_id = $1`, [o.orgId]);
    const lim = await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'org', screenshotIntervalMinutes: 3 });
    expect(lim.status).toBe(422);
    expect(lim.body.error.code).toBe('PLAN_LIMIT');
    await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'org', screenshotRetentionDays: 31 }).expect(422);
    await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'org', screenshotRetentionDays: 30 }).expect(200);

    // org row cannot be deleted
    await o.api.delete(`${API}/tracking-settings/${put.body.data.id}`).expect(409);
  });

  it('effective settings inherit member > project > team > org (SET-T11, SET-T12)', async () => {
    const o = await registerOrg(t);
    const emp = await addMember(t, o, { role: 'employee' });
    const other = await addMember(t, o, { role: 'employee' });
    const team = (await o.api.post(`${API}/teams`).send({ name: 'Design', memberIds: [emp.memberId] }).expect(201)).body.data;
    const proj = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1,'Secret') RETURNING id`, [o.orgId]);

    await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'org', idleThresholdMinutes: 7, appTrackingEnabled: true }).expect(200);
    const teamRow = await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'team', scopeId: team.id, screenshotIntervalMinutes: 15, idleThresholdMinutes: 9 }).expect(200);
    await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'project', scopeId: proj.id, screenshotsEnabled: false }).expect(200);
    const memRow = await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'member', scopeId: emp.memberId, idleThresholdMinutes: 12 }).expect(200);
    expect(memRow.body.data.scopeName).toBe('Member Test');

    const eff = await o.api.get(`${API}/tracking-settings/effective?memberId=${emp.memberId}&projectId=${proj.id}`).expect(200);
    expect(eff.body.data.settings).toMatchObject({ idleThresholdMinutes: 12, screenshotIntervalMinutes: 15, screenshotsEnabled: false, appTrackingEnabled: true, showIndicator: true, stealthMode: false });
    expect(eff.body.data.inheritedFrom).toMatchObject({ idleThresholdMinutes: 'member', screenshotIntervalMinutes: 'team', screenshotsEnabled: 'project', appTrackingEnabled: 'org' });

    // employee reads own effective settings (no projectId) but not others'
    const self = await emp.api.get(`${API}/tracking-settings/effective`).expect(200);
    expect(self.body.data.memberId).toBe(emp.memberId);
    expect(self.body.data.settings.screenshotsEnabled).toBe(true);
    await emp.api.get(`${API}/tracking-settings/effective?memberId=${other.memberId}`).expect(403);
    const otherEff = await other.api.get(`${API}/tracking-settings/effective`).expect(200);
    expect(otherEff.body.data.settings.idleThresholdMinutes).toBe(7);

    // null clears a field at the scope (inherit), delete removes the override
    await o.api.put(`${API}/tracking-settings`).send({ scopeType: 'member', scopeId: emp.memberId, idleThresholdMinutes: null }).expect(200);
    const eff2 = await o.api.get(`${API}/tracking-settings/effective?memberId=${emp.memberId}`).expect(200);
    expect(eff2.body.data.settings.idleThresholdMinutes).toBe(9);
    await o.api.delete(`${API}/tracking-settings/${teamRow.body.data.id}`).expect(204);
    const eff3 = await o.api.get(`${API}/tracking-settings/effective?memberId=${emp.memberId}`).expect(200);
    expect(eff3.body.data.settings).toMatchObject({ idleThresholdMinutes: 7, screenshotIntervalMinutes: 10 });

    const all = await o.api.get(`${API}/tracking-settings`).expect(200);
    expect(all.body.data.map((r) => r.scopeType)).toEqual(['org', 'project', 'member']);
    expect(all.body.meta.planLimits.minScreenshotInterval).toBe(3);

    // permissions & isolation
    await emp.api.get(`${API}/tracking-settings`).expect(403);
    await emp.api.put(`${API}/tracking-settings`).send({ scopeType: 'member', scopeId: emp.memberId, screenshotsEnabled: false }).expect(403);
    const x = await registerOrg(t);
    await x.api.put(`${API}/tracking-settings`).send({ scopeType: 'team', scopeId: team.id, idleThresholdMinutes: 3 }).expect(404);
    await x.api.delete(`${API}/tracking-settings/${memRow.body.data.id}`).expect(404);
    await x.api.get(`${API}/tracking-settings/effective?memberId=${emp.memberId}`).expect(404);
  });
});

describe('Privacy settings & consents (PRIV-01…PRIV-05)', () => {
  it('changing the policy text bumps the consent version; consents list', async () => {
    const o = await registerOrg(t);
    const e1 = await addMember(t, o, { role: 'employee' });
    const e2 = await addMember(t, o, { role: 'employee', consent: false });
    const p = await o.api.get(`${API}/privacy-settings`).expect(200);
    expect(p.body.data).toMatchObject({ consentPolicyVersion: 1, showIndicator: true, screenshotRetentionDays: 30, consent: { total: 3, accepted: 2, pending: 1 } });

    const pending = await o.api.get(`${API}/consents?status=pending`).expect(200);
    expect(pending.body.data.map((c) => c.member.id)).toEqual([e2.memberId]);
    const accepted = await o.api.get(`${API}/consents?status=accepted`).expect(200);
    expect(accepted.body.meta.total).toBe(2);

    // retention only → no version bump
    const r1 = await o.api.put(`${API}/privacy-settings`).send({ dataRetentionDays: 365, screenshotRetentionDays: 14, trackFullUrl: true }).expect(200);
    expect(r1.body.data).toMatchObject({ consentPolicyVersion: 1, dataRetentionDays: 365, screenshotRetentionDays: 14, trackFullUrl: true });
    const org = await o.api.get(`${API}/tracking-settings?scopeType=org`).expect(200);
    expect(org.body.data.version).toBe(2);
    await o.api.put(`${API}/privacy-settings`).send({ screenshotRetentionDays: 400 }).expect(422);
    await o.api.put(`${API}/privacy-settings`).send({ dataRetentionDays: 5 }).expect(400);

    const before = t.emitted.length;
    const r2 = await o.api.put(`${API}/privacy-settings`).send({ consentPolicyText: 'We track working time, activity levels and screenshots while the timer runs.' }).expect(200);
    expect(r2.body.data.consentPolicyVersion).toBe(2);
    expect(r2.body.data.consent.accepted).toBe(0);
    expect(t.emitted.slice(before).some((e) => e.event === 'consent.required')).toBe(true);
    // same text → no bump
    const r3 = await o.api.put(`${API}/privacy-settings`).send({ consentPolicyText: 'We track working time, activity levels and screenshots while the timer runs.' }).expect(200);
    expect(r3.body.data.consentPolicyVersion).toBe(2);
    const pend2 = await o.api.get(`${API}/consents?status=pending`).expect(200);
    expect(pend2.body.meta.total).toBe(3);
    expect(pend2.body.data.find((c) => c.member.id === e1.memberId).lastAcceptedVersion).toBe(1);

    // permissions
    await e1.api.get(`${API}/privacy-settings`).expect(403);
    await e1.api.put(`${API}/privacy-settings`).send({ dataRetentionDays: 60 }).expect(403);
    await e1.api.get(`${API}/consents`).expect(403);
    const mgr = await addMember(t, o, { role: 'manager' });
    await mgr.api.get(`${API}/consents`).expect(403);
    const audits = await db.one(`SELECT count(*)::int n FROM audit_logs WHERE action = 'privacy_settings.updated' AND organization_id = $1`, [o.orgId]);
    expect(audits.n).toBe(3);
  });
});
