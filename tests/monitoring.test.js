import crypto from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, request, client, db } from './helpers.js';
import { runCron } from '../src/lib/jobs.js';
import { startTimer, pauseTimer } from '../src/modules/time/timer-service.js';

let t;
let owner;
let project;
const uuid = () => crypto.randomUUID();
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const today = () => new Date().toISOString().slice(0, 10);

async function agentLogin(m) {
  const res = await request(t.app)
    .post('/api/v1/agent/auth/login')
    .send({ email: m.email, password: m.password, device: { os: 'macos', appVersion: '1.0.0', machineId: `m-${uuid()}` } });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return { ...res.body.data, api: client(t.app, res.body.data.deviceToken) };
}

async function newEmployee() {
  const e = await addMember(t, owner, { role: 'employee' });
  await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2)', [project.id, e.memberId]);
  return e;
}

beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  project = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Monitor') RETURNING *`, [owner.orgId]);
});

describe('live monitoring (ADM-06…09)', () => {
  it('derives tracking / idle / on_break / online / offline', async () => {
    const tracking = await newEmployee();
    const idle = await newEmployee();
    const onBreak = await newEmployee();
    const online = await newEmployee();
    const offline = await newEmployee();
    await startTimer({ orgId: owner.orgId, memberId: tracking.memberId }, { projectId: project.id, startedAt: ago(30) });
    await startTimer({ orgId: owner.orgId, memberId: idle.memberId }, { projectId: project.id, startedAt: ago(30) });
    await pauseTimer({ orgId: owner.orgId, memberId: idle.memberId }, { reason: 'idle', at: ago(5) });
    const bt = await db.one('SELECT id FROM break_types WHERE organization_id = $1 LIMIT 1', [owner.orgId]);
    await db.query('INSERT INTO breaks (organization_id, member_id, break_type_id, started_at) VALUES ($1,$2,$3, now())', [owner.orgId, onBreak.memberId, bt.id]);
    const a = await agentLogin(online);
    await a.api.post('/api/v1/agent/heartbeat').send({ status: 'active', pendingCount: 0, appVersion: '1.0.0' }).expect(200);
    await db.query(`UPDATE organization_members SET last_seen_at = now() - interval '1 hour' WHERE id = $1`, [offline.memberId]);

    const r = await owner.api.get('/api/v1/live/members').expect(200);
    const st = Object.fromEntries(r.body.data.map((m) => [m.memberId, m]));
    expect(st[tracking.memberId].status).toBe('tracking');
    expect(st[tracking.memberId].project.id).toBe(project.id);
    expect(st[tracking.memberId].timer.seconds).toBeGreaterThan(1700);
    expect(st[idle.memberId].status).toBe('idle');
    expect(st[onBreak.memberId].status).toBe('on_break');
    expect(st[online.memberId].status).toBe('online');
    expect(st[offline.memberId].status).toBe('offline');
    const sum = await owner.api.get('/api/v1/live/summary').expect(200);
    expect(sum.body.data.counts.tracking).toBeGreaterThanOrEqual(1);
    expect(sum.body.data.counts.on_break).toBeGreaterThanOrEqual(1);
    // employees only see themselves
    const mine = await tracking.api.get('/api/v1/live/members').expect(200);
    expect(mine.body.data.map((m) => m.memberId)).toEqual([tracking.memberId]);
  });
});

describe('activity (ACT-06…17)', () => {
  let emp;
  let a;
  beforeAll(async () => {
    emp = await newEmployee();
    a = await agentLogin(emp);
    await startTimer({ orgId: owner.orgId, memberId: emp.memberId }, { projectId: project.id, startedAt: ago(60), source: 'desktop', deviceId: a.device.id });
  });

  it('alerts on low activity once per hour (ACT-15)', async () => {
    const samples = [5, 4, 3].map((m) => ({ intervalStart: ago(m), intervalSeconds: 60, keyboardActiveSeconds: 3, mouseActiveSeconds: 5, activeSeconds: 6 }));
    await a.api.post('/api/v1/agent/activity').send({ samples }).expect(200);
    await runCron('alerts.low_activity');
    const n = await db.many(`SELECT recipient_user_id, body FROM notifications WHERE type = 'activity.low' AND data->>'memberId' = $1`, [emp.memberId]);
    expect(n.map((x) => x.recipient_user_id)).toEqual(expect.arrayContaining([emp.user.id, owner.user.id]));
    expect(n[0].body).toMatch(/not the sole measure/);
    await runCron('alerts.low_activity');
    const again = await db.many(`SELECT 1 FROM notifications WHERE type = 'activity.low' AND data->>'memberId' = $1`, [emp.memberId]);
    expect(again.length).toBe(n.length);
  });

  it('does not alert members with healthy activity', async () => {
    const e2 = await newEmployee();
    const a2 = await agentLogin(e2);
    await startTimer({ orgId: owner.orgId, memberId: e2.memberId }, { projectId: project.id, startedAt: ago(60) });
    const samples = [5, 4, 3].map((m) => ({ intervalStart: ago(m), intervalSeconds: 60, keyboardActiveSeconds: 30, mouseActiveSeconds: 40, activeSeconds: 50 }));
    await a2.api.post('/api/v1/agent/activity').send({ samples }).expect(200);
    await runCron('alerts.low_activity');
    expect(await db.one(`SELECT 1 FROM notifications WHERE type = 'activity.low' AND data->>'memberId' = $1`, [e2.memberId])).toBeNull();
  });

  it('serves timeline, summary, compare and trends with the activity note', async () => {
    const tl = await emp.api.get(`/api/v1/activity/timeline?date=${today()}`).expect(200);
    expect(tl.body.data.buckets.length).toBeGreaterThan(0);
    expect(tl.body.data.buckets[0].level).toBe('low');
    expect(tl.body.data.note).toMatch(/not the sole measure/);
    const sum = await owner.api.get(`/api/v1/activity/summary?memberId=${emp.memberId}&granularity=hour`).expect(200);
    expect(sum.body.data.totals.trackedSeconds).toBe(180);
    expect(sum.body.data.totals.activeSeconds).toBe(18);
    expect(sum.body.data.levelDistribution.counts.low).toBe(3);
    const cmp = await owner.api.get(`/api/v1/activity/compare?memberIds=${emp.memberId},${owner.memberId}`).expect(200);
    expect(cmp.body.data.items.find((i) => i.id === emp.memberId).averageActivityPercent).toBe(10);
    const pc = await owner.api.get(`/api/v1/activity/compare?projectIds=${project.id}`).expect(200);
    expect(pc.body.data.items[0].trackedSeconds).toBeGreaterThan(0);
    const tr = await owner.api.get(`/api/v1/activity/trends?memberId=${emp.memberId}&period=week`).expect(200);
    expect(tr.body.data.series).toHaveLength(7);
    // scope: another employee cannot view this member
    const other = await newEmployee();
    expect((await other.api.get(`/api/v1/activity/timeline?memberId=${emp.memberId}&date=${today()}`)).status).toBe(403);
    expect((await other.api.get(`/api/v1/activity/summary?memberId=${emp.memberId}`)).status).toBe(403);
  });
});

describe('apps & websites (APP-*)', () => {
  it('categorizes usage with rules and lists discovered apps', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    await owner.api.post('/api/v1/productivity-rules').send({ targetType: 'app', pattern: 'Slack', category: 'unproductive' }).expect(201);
    const rule = await owner.api.post('/api/v1/productivity-rules').send({ targetType: 'website', pattern: 'news.example.com', matchType: 'domain', category: 'unproductive' }).expect(201);
    expect((await emp.api.post('/api/v1/productivity-rules').send({ targetType: 'app', pattern: 'X', category: 'neutral' })).status).toBe(403);
    await owner.api.post('/api/v1/productivity-rules').send({ scopeType: 'team', targetType: 'app', pattern: 'X', category: 'neutral' }).expect(400);
    await a.api
      .post('/api/v1/agent/app-usage')
      .send({
        items: [
          { clientUuid: uuid(), appName: 'Slack', startedAt: ago(60), endedAt: ago(50) },
          { clientUuid: uuid(), appName: 'Notepad', startedAt: ago(50), endedAt: ago(45) },
        ],
      })
      .expect(200);
    await a.api.post('/api/v1/agent/web-usage').send({ items: [{ clientUuid: uuid(), browser: 'safari', domain: 'm.news.example.com', startedAt: ago(40), endedAt: ago(30) }] }).expect(200);
    const byCat = await owner.api.get(`/api/v1/apps/usage?memberId=${emp.memberId}&groupBy=category`).expect(200);
    expect(byCat.body.data.unproductiveSeconds).toBe(600);
    expect(byCat.body.data.neutralSeconds).toBe(300);
    const byApp = await emp.api.get('/api/v1/apps/usage').expect(200);
    expect(byApp.body.data.items.map((i) => i.name)).toEqual(['Slack', 'Notepad']);
    const web = await owner.api.get(`/api/v1/websites/usage?memberId=${emp.memberId}&browser=safari`).expect(200);
    expect(web.body.data.items[0]).toMatchObject({ name: 'm.news.example.com', category: 'unproductive', seconds: 600 });
    const atl = await emp.api.get(`/api/v1/apps/timeline?date=${today()}`).expect(200);
    expect(atl.body.data.items).toHaveLength(2);
    const wtl = await emp.api.get(`/api/v1/websites/timeline?date=${today()}`).expect(200);
    expect(wtl.body.data.items[0].category).toBe('unproductive');
    const disc = await owner.api.get('/api/v1/applications/discovered').expect(200);
    expect(disc.body.data.find((d) => d.name === 'Slack')).toMatchObject({ hasRule: true, category: 'unproductive' });
    expect(disc.body.data.find((d) => d.name === 'Notepad').hasRule).toBe(false);
    await owner.api.patch(`/api/v1/productivity-rules/${rule.body.data.id}`).send({ category: 'productive' }).expect(200);
    const list = await owner.api.get('/api/v1/productivity-rules?targetType=website').expect(200);
    expect(list.body.data[0].category).toBe('productive');
    await owner.api.delete(`/api/v1/productivity-rules/${rule.body.data.id}`).expect(204);
    const otherEmp = await newEmployee();
    expect((await otherEmp.api.get(`/api/v1/apps/timeline?memberId=${emp.memberId}&date=${today()}`)).status).toBe(403);
  });
});

describe('organization isolation', () => {
  it('never shows another organization’s data', async () => {
    const other = await registerOrg(t);
    const live = await other.api.get('/api/v1/live/members').expect(200);
    expect(live.body.data.map((m) => m.memberId)).toEqual([other.memberId]);
    const shots = await other.api.get('/api/v1/screenshots').expect(200);
    expect(shots.body.data).toHaveLength(0);
    const apps = await other.api.get('/api/v1/apps/usage').expect(200);
    expect(apps.body.data.totalSeconds).toBe(0);
    const conflicts = await other.api.get('/api/v1/sync-conflicts').expect(200);
    expect(conflicts.body.data).toHaveLength(0);
  });
});
