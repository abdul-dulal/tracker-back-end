import crypto from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, request, client, db } from './helpers.js';
import { startTimer, stopTimer } from '../src/modules/time/timer-service.js';

let t;
let owner;
let project;

const uuid = () => crypto.randomUUID();
const device = (over = {}) => ({ os: 'windows', osVersion: '11', appVersion: '1.4.0', hostname: 'PC-1', machineId: `machine-${uuid()}`, ...over });

async function agentLogin(m, dev = device(), extra = {}) {
  const res = await request(t.app).post('/api/v1/agent/auth/login').send({ email: m.email, password: m.password, device: dev, ...extra });
  if (res.status !== 200 || !res.body.data.deviceToken) throw new Error(`agent login failed ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body.data, api: client(t.app, res.body.data.deviceToken), dev };
}

async function newEmployee() {
  const emp = await addMember(t, owner, { role: 'employee' });
  await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2)', [project.id, emp.memberId]);
  return emp;
}

const checksum = (items) => crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  project = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Agent Project') RETURNING *`, [owner.orgId]);
});

describe('agent auth & devices (DESK-01…26)', () => {
  it('logs in, registers the device and issues a device token', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    expect(a.deviceToken).toMatch(/^dt_/);
    expect(a.member.id).toBe(emp.memberId);
    expect(a.organization.id).toBe(owner.orgId);
    expect(a.config.showIndicator).toBe(true);
    expect(a.config.stealthMode).toBe(false);
    expect(a.config.consent.accepted).toBe(true);
    const dev = await db.one('SELECT * FROM devices WHERE id = $1', [a.device.id]);
    expect(dev.machine_id_hash).toBe(crypto.createHash('sha256').update(a.dev.machineId).digest('hex'));
    const tok = await db.one('SELECT token_hash, expires_at FROM device_tokens WHERE device_id = $1', [a.device.id]);
    expect(tok.token_hash).not.toBe(a.deviceToken);
    expect(new Date(tok.expires_at) - Date.now()).toBeGreaterThan(89 * 86400_000);
    const hist = await db.one(`SELECT method FROM login_history WHERE user_id = $1 AND success ORDER BY created_at DESC LIMIT 1`, [emp.user.id]);
    expect(hist.method).toBe('agent');

    const cfg = await a.api.get('/api/v1/agent/config').expect(200);
    expect(cfg.body.data.activityThresholds).toEqual({ lowMax: 30, moderateMax: 60 });
    expect(cfg.body.data.serverTime).toBeTruthy();
    const projects = await a.api.get('/api/v1/agent/projects').expect(200);
    expect(projects.body.data.map((p) => p.id)).toContain(project.id);
    const orgs = await a.api.get('/api/v1/agent/organizations').expect(200);
    expect(orgs.body.data[0].current).toBe(true);

    // Same machine again → same device row, old token revoked
    const again = await agentLogin(emp, a.dev);
    expect(again.device.id).toBe(a.device.id);
    expect((await a.api.get('/api/v1/agent/config')).status).toBe(401);

    // A dashboard JWT cannot call agent endpoints and vice versa
    const jwt = await emp.api.get('/api/v1/agent/config');
    expect(jwt.status).toBe(401);
    expect(jwt.body.error.code).toBe('DEVICE_TOKEN_REQUIRED');
  });

  it('rejects bad credentials and unknown fields', async () => {
    const emp = await newEmployee();
    const bad = await request(t.app).post('/api/v1/agent/auth/login').send({ email: emp.email, password: 'nope-nope1', device: device() });
    expect(bad.status).toBe(401);
    const extra = await request(t.app).post('/api/v1/agent/auth/login').send({ email: emp.email, password: emp.password, device: { ...device(), stealth: true } });
    expect(extra.status).toBe(400);
  });

  it('requires organization selection when the user belongs to several organizations', async () => {
    const emp = await newEmployee();
    const other = await registerOrg(t);
    await db.query('INSERT INTO organization_members (organization_id, user_id, role_id) VALUES ($1,$2,$3)', [other.orgId, emp.user.id, other.roles.employee]);
    const dev = device();
    const res = await request(t.app).post('/api/v1/agent/auth/login').send({ email: emp.email, password: emp.password, device: dev }).expect(200);
    expect(res.body.data.requiresOrganizationSelection).toBe(true);
    expect(res.body.data.organizations).toHaveLength(2);
    const sel = await request(t.app)
      .post('/api/v1/agent/auth/select-organization')
      .send({ loginTicket: res.body.data.loginTicket, organizationId: other.orgId, device: dev })
      .expect(200);
    expect(sel.body.data.organization.id).toBe(other.orgId);
    const direct = await request(t.app).post('/api/v1/agent/auth/login').send({ email: emp.email, password: emp.password, device: dev, organizationId: owner.orgId }).expect(200);
    expect(direct.body.data.organization.id).toBe(owner.orgId);
  });

  it('returns 426 for app versions below the minimum supported release (DESK-21/22)', async () => {
    await db.query(`INSERT INTO app_releases (os, channel, version, url, min_supported) VALUES ('linux','stable','2.0.0','https://dl.example.com/2.0.0', true)`);
    await db.query(`INSERT INTO app_releases (os, channel, version, url) VALUES ('linux','stable','2.1.0','https://dl.example.com/2.1.0')`);
    const emp = await newEmployee();
    const old = await request(t.app).post('/api/v1/agent/auth/login').send({ email: emp.email, password: emp.password, device: device({ os: 'linux', appVersion: '1.9.9' }) });
    expect(old.status).toBe(426);
    expect(old.body.error.code).toBe('AGENT_UPGRADE_REQUIRED');
    expect(old.body.error.details.minVersion).toBe('2.0.0');
    const a = await agentLogin(emp, device({ os: 'linux', appVersion: '2.0.1' }));
    expect(a.deviceToken).toBeTruthy();
    const rel = await request(t.app).get('/api/v1/agent/releases/latest?os=linux&currentVersion=2.0.1').expect(200);
    expect(rel.body.data.version).toBe('2.1.0');
    expect(rel.body.data.updateAvailable).toBe(true);
    expect(rel.body.data.updateRequired).toBe(false);
    const devs = await owner.api.get(`/api/v1/devices?memberId=${emp.memberId}`).expect(200);
    expect(devs.body.data[0].outdated).toBe(false);
    expect(devs.body.data[0].updateAvailable).toBe(true);
  });

  it('runs the timer, heartbeat, today and logout from the desktop', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    const start = await a.api.post('/api/v1/agent/timer/start').send({ projectId: project.id }).expect(201);
    expect(start.body.data.entry.source).toBe('desktop');
    expect(start.body.data.entry.deviceId).toBe(a.device.id);
    await a.api.post('/api/v1/agent/timer/pause').send({}).expect(200);
    await a.api.post('/api/v1/agent/timer/resume').expect(200);
    const cur = await a.api.get('/api/v1/agent/timer').expect(200);
    expect(cur.body.data.id).toBe(start.body.data.entry.id);
    const hb = await a.api.post('/api/v1/agent/heartbeat').send({ status: 'active', activityPercent: 55, currentApp: 'Code', pendingCount: 3, appVersion: '1.4.0' }).expect(200);
    expect(hb.body.data.timer.id).toBe(start.body.data.entry.id);
    expect(t.emitted.some((e) => e.event === 'presence.updated' && e.data.memberId === emp.memberId && e.room === `org:${owner.orgId}:live`)).toBe(true);
    const d = await db.one('SELECT pending_count, online FROM devices WHERE id = $1', [a.device.id]);
    expect(d).toEqual({ pending_count: 3, online: true });
    await a.api.post('/api/v1/agent/heartbeat').send({ status: 'active', pendingCount: 0, appVersion: '1.4.0', keys: 'abc' }).expect(400);
    const today = await a.api.get('/api/v1/agent/today').expect(200);
    expect(today.body.data.timer.id).toBe(start.body.data.entry.id);
    await a.api.post('/api/v1/agent/timer/stop').send({ note: 'done' }).expect(200);
    const st = await a.api.get('/api/v1/agent/sync/status').expect(200);
    expect(st.body.data.deviceId).toBe(a.device.id);
    await a.api.post('/api/v1/agent/auth/logout').send({}).expect(204);
    expect((await a.api.get('/api/v1/agent/timer')).status).toBe(401);
  });

  it('admins list and revoke devices; employees see only their own', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    const list = await owner.api.get('/api/v1/devices').expect(200);
    expect(list.body.data.some((d) => d.id === a.device.id && d.online === true)).toBe(true);
    const mine = await emp.api.get('/api/v1/devices').expect(200);
    expect(mine.body.data.every((d) => d.member.id === emp.memberId)).toBe(true);
    const other = await newEmployee();
    expect((await other.api.post(`/api/v1/devices/${a.device.id}/revoke`)).status).toBe(403);
    const rv = await owner.api.post(`/api/v1/devices/${a.device.id}/revoke`).expect(200);
    expect(rv.body.data.status).toBe('revoked');
    expect((await a.api.get('/api/v1/agent/config')).status).toBe(401);
  });
});

describe('ingestion (ACT/APP/idle)', () => {
  it('ingests activity samples (deduped, linked, strict)', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    await startTimer({ orgId: owner.orgId, memberId: emp.memberId }, { projectId: project.id, startedAt: ago(60), source: 'desktop', deviceId: a.device.id });
    const samples = [0, 1, 2].map((i) => ({ intervalStart: ago(10 - i), intervalSeconds: 60, keyboardActiveSeconds: 20, mouseActiveSeconds: 30, activeSeconds: 45 }));
    const r1 = await a.api.post('/api/v1/agent/activity').send({ samples }).expect(200);
    expect(r1.body.data.accepted).toBe(3);
    const r2 = await a.api.post('/api/v1/agent/activity').send({ samples }).expect(200);
    expect(r2.body.data.duplicates).toBe(3);
    const rows = await db.many('SELECT activity_percent, time_entry_id, project_id FROM activity_samples WHERE member_id = $1', [emp.memberId]);
    expect(rows).toHaveLength(3);
    expect(rows[0].activity_percent).toBe(75);
    expect(rows[0].project_id).toBe(project.id);
    expect(rows[0].time_entry_id).toBeTruthy();
    // PRIVACY: keystroke content / coordinates are rejected outright
    const bad = await a.api.post('/api/v1/agent/activity').send({ samples: [{ ...samples[0], keys: 'abc' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const bad2 = await a.api.post('/api/v1/agent/activity').send({ samples: [{ ...samples[0], mouseX: 10, mouseY: 20 }] });
    expect(bad2.status).toBe(400);
    const tooMuch = await a.api.post('/api/v1/agent/activity').send({ samples: [{ ...samples[0], intervalStart: ago(1), activeSeconds: 90 }] }).expect(200);
    expect(tooMuch.body.data.rejected).toBe(1);
    // disabled → rejected
    await db.query(`INSERT INTO tracking_settings (organization_id, scope_type, scope_id, activity_tracking_enabled, app_tracking_enabled) VALUES ($1,'member',$2,false,false)`, [owner.orgId, emp.memberId]);
    const off = await a.api.post('/api/v1/agent/activity').send({ samples: [{ ...samples[0], intervalStart: ago(2) }] });
    expect(off.status).toBe(422);
    expect(off.body.error.code).toBe('TRACKING_DISABLED');
    const offApps = await a.api.post('/api/v1/agent/app-usage').send({ items: [{ appName: 'Code', startedAt: ago(5), endedAt: ago(4) }] });
    expect(offApps.status).toBe(422);
    await stopTimer({ orgId: owner.orgId, memberId: emp.memberId });
  });

  it('stores websites respecting sensitive exclusions, URL and title settings (PRIV-05, APP-04)', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    await owner.api.post('/api/v1/sensitive-exclusions').send({ domainPattern: 'bank.com', reason: 'Banking' }).expect(201);
    expect((await owner.api.post('/api/v1/sensitive-exclusions').send({ domainPattern: 'bank.com' })).status).toBe(409);
    expect((await emp.api.get('/api/v1/sensitive-exclusions')).status).toBe(403);
    const items = [
      { clientUuid: uuid(), browser: 'chrome', domain: 'secure.bank.com', url: 'https://secure.bank.com/acct?id=1', title: 'My account', startedAt: ago(30), endedAt: ago(25) },
      { clientUuid: uuid(), browser: 'firefox', domain: 'www.GitHub.com', url: 'https://github.com/org/repo?tab=x#y', title: 'Repo', startedAt: ago(20), endedAt: ago(10) },
    ];
    const r = await a.api.post('/api/v1/agent/web-usage').send({ items }).expect(200);
    expect(r.body.data.accepted).toBe(2);
    const rows = await db.many('SELECT * FROM web_usage WHERE member_id = $1 ORDER BY started_at', [emp.memberId]);
    expect(rows[0]).toMatchObject({ domain: '(excluded)', url: null, title: null, is_excluded: true, browser: 'chrome' });
    expect(rows[1]).toMatchObject({ domain: 'github.com', url: 'https://github.com/org/repo', title: 'Repo', is_excluded: false });
    const dup = await a.api.post('/api/v1/agent/web-usage').send({ items }).expect(200);
    expect(dup.body.data.duplicates).toBe(2);
    const badBrowser = await a.api.post('/api/v1/agent/web-usage').send({ items: [{ ...items[1], clientUuid: uuid(), browser: 'netscape' }] });
    expect(badBrowser.status).toBe(400);

    const apps = await a.api.post('/api/v1/agent/app-usage').send({ items: [{ clientUuid: uuid(), appIdentifier: 'code.exe', appName: 'Code', windowTitle: 'main.js', startedAt: ago(9), endedAt: ago(5) }] }).expect(200);
    expect(apps.body.data.accepted).toBe(1);
    const app = await db.one('SELECT * FROM app_usage WHERE member_id = $1', [emp.memberId]);
    expect(app.duration_seconds).toBe(240);
    expect(app.window_title).toBe('main.js');
  });

  it('auto-pauses the timer on idle and alerts (TIME-21, ACT-16)', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    await startTimer({ orgId: owner.orgId, memberId: emp.memberId }, { projectId: project.id, startedAt: ago(60), source: 'desktop', deviceId: a.device.id });
    const cu = uuid();
    const r = await a.api.post('/api/v1/agent/idle').send({ periods: [{ clientUuid: cu, startedAt: ago(15), endedAt: ago(0) }] }).expect(200);
    expect(r.body.data.results[0].timerPaused).toBe(true);
    const timer = await a.api.get('/api/v1/agent/timer').expect(200);
    expect(timer.body.data.pause.reason).toBe('idle');
    expect(Math.abs(new Date(timer.body.data.pause.startedAt) - new Date(ago(15)))).toBeLessThan(5000);
    expect(t.emitted.some((e) => e.event === 'idle.detected' && e.room === `user:${emp.user.id}`)).toBe(true);
    const n = await db.many(`SELECT recipient_user_id FROM notifications WHERE type = 'idle.alert' AND data->>'memberId' = $1`, [emp.memberId]);
    expect(n.map((x) => x.recipient_user_id)).toEqual(expect.arrayContaining([emp.user.id, owner.user.id]));
    // re-sending the same idle period extends it without alerting twice
    await a.api.post('/api/v1/agent/idle').send({ periods: [{ clientUuid: cu, startedAt: ago(15), endedAt: new Date().toISOString() }] }).expect(200);
    expect((await db.many(`SELECT 1 FROM notifications WHERE type = 'idle.alert' AND data->>'memberId' = $1`, [emp.memberId])).length).toBe(n.length);
    expect((await db.many('SELECT 1 FROM idle_periods WHERE member_id = $1', [emp.memberId])).length).toBe(1);
    await stopTimer({ orgId: owner.orgId, memberId: emp.memberId });
  });
});

describe('offline sync (SYNC-01…12)', () => {
  it('is idempotent per batch and validates the checksum', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    const entryUuid = uuid();
    const items = {
      timeEntries: [{ clientUuid: entryUuid, projectId: project.id, startedAt: ago(300), endedAt: ago(240), note: 'offline work' }],
      pauses: [{ clientUuid: uuid(), timeEntryClientUuid: entryUuid, startedAt: ago(280), endedAt: ago(270) }],
      activity: [{ intervalStart: ago(290), intervalSeconds: 600, keyboardActiveSeconds: 100, mouseActiveSeconds: 300, activeSeconds: 360 }],
      appUsage: [{ clientUuid: uuid(), appName: 'Figma', startedAt: ago(260), endedAt: ago(250) }],
      webUsage: [{ clientUuid: uuid(), browser: 'edge', domain: 'figma.com', startedAt: ago(250), endedAt: ago(245) }],
      idlePeriods: [{ clientUuid: uuid(), startedAt: ago(244), endedAt: ago(242) }],
      breaks: [{ clientUuid: uuid(), startedAt: ago(238), endedAt: ago(230) }],
      screenshots: [],
    };
    const batch = { batchUuid: uuid(), checksum: checksum(items), items, pendingCount: 0 };
    const r1 = await a.api.post('/api/v1/agent/sync').send(batch).expect(200);
    expect(r1.body.data.replayed).toBe(false);
    expect(r1.body.data.results.every((x) => x.status === 'ok')).toBe(true);
    expect(r1.body.data.results).toHaveLength(7);
    const entry = await db.one('SELECT * FROM time_entries WHERE member_id = $1', [emp.memberId]);
    expect(entry).toMatchObject({ is_offline: true, source: 'desktop', status: 'completed', paused_seconds: 600, duration_seconds: 3000 });
    const r2 = await a.api.post('/api/v1/agent/sync').send(batch).expect(200);
    expect(r2.body.data.replayed).toBe(true);
    expect(r2.body.data.results).toEqual(r1.body.data.results);
    // a new batch with the same items → duplicates, never double-inserted
    const r3 = await a.api.post('/api/v1/agent/sync').send({ ...batch, batchUuid: uuid() }).expect(200);
    expect(r3.body.data.results.every((x) => x.status === 'duplicate')).toBe(true);
    expect((await db.many('SELECT 1 FROM time_entries WHERE member_id = $1', [emp.memberId])).length).toBe(1);
    expect((await db.many('SELECT 1 FROM activity_samples WHERE member_id = $1', [emp.memberId])).length).toBe(1);
    expect((await db.many('SELECT 1 FROM time_entry_pauses WHERE time_entry_id = $1', [entry.id])).length).toBe(1);
    const dev = await db.one('SELECT last_sync_at FROM devices WHERE id = $1', [a.device.id]);
    expect(dev.last_sync_at).toBeTruthy();

    const mismatch = await a.api.post('/api/v1/agent/sync').send({ ...batch, batchUuid: uuid(), checksum: 'a'.repeat(64) });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('CHECKSUM_MISMATCH');
    const strict = await a.api.post('/api/v1/agent/sync').send({ ...batch, batchUuid: uuid(), items: { ...items, keystrokes: [] }, checksum: checksum({ ...items, keystrokes: [] }) });
    expect(strict.status).toBe(400);
  });

  it('flags future / too old items as per-item errors', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    const items = {
      timeEntries: [
        { clientUuid: uuid(), startedAt: new Date(Date.now() + 3600_000).toISOString(), endedAt: new Date(Date.now() + 7200_000).toISOString() },
        { clientUuid: uuid(), startedAt: new Date(Date.now() - 40 * 86400_000).toISOString(), endedAt: new Date(Date.now() - 40 * 86400_000 + 3600_000).toISOString() },
        { clientUuid: uuid(), startedAt: ago(100), endedAt: ago(90) },
      ],
    };
    const r = await a.api.post('/api/v1/agent/sync').send({ batchUuid: uuid(), checksum: checksum(items), items }).expect(200);
    expect(r.body.data.results.map((x) => x.status)).toEqual(['error', 'error', 'ok']);
    expect(r.body.data.results[0].message).toMatch(/future/);
  });

  it('creates a conflict for overlapping entries and resolves it (SYNC-08)', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    const server = await db.one(
      `INSERT INTO time_entries (organization_id, member_id, project_id, started_at, ended_at, status, source) VALUES ($1,$2,$3,$4,$5,'completed','web_timer') RETURNING id`,
      [owner.orgId, emp.memberId, project.id, ago(200), ago(140)],
    );
    const cu = uuid();
    const items = { timeEntries: [{ clientUuid: cu, projectId: project.id, startedAt: ago(180), endedAt: ago(120) }] };
    const r = await a.api.post('/api/v1/agent/sync').send({ batchUuid: uuid(), checksum: checksum(items), items }).expect(200);
    expect(r.body.data.results[0].status).toBe('conflict');
    expect(r.body.data.results[0].conflictingEntryId).toBe(server.id);
    // re-sync of the same item does not create a second conflict
    const again = await a.api.post('/api/v1/agent/sync').send({ batchUuid: uuid(), checksum: checksum(items), items }).expect(200);
    expect(again.body.data.results[0].conflictId).toBe(r.body.data.results[0].conflictId);
    const list = await owner.api.get('/api/v1/sync-conflicts?status=open').expect(200);
    const c = list.body.data.find((x) => x.memberId === emp.memberId);
    expect(c.conflictingEntry.id).toBe(server.id);
    expect((await emp.api.get('/api/v1/sync-conflicts')).body.data.every((x) => x.memberId === emp.memberId)).toBe(true);
    // server entry untouched until resolution
    const untouched = await db.one('SELECT ended_at FROM time_entries WHERE id = $1', [server.id]);
    expect(Math.abs(new Date(untouched.ended_at) - new Date(ago(140)))).toBeLessThan(5000);
    const res = await owner.api.post(`/api/v1/sync-conflicts/${c.id}/resolve`).send({ resolution: 'keep_device' }).expect(200);
    expect(res.body.data.status).toBe('resolved');
    expect(res.body.data.createdEntryId).toBeTruthy();
    const trimmed = await db.one('SELECT started_at, ended_at, deleted_at FROM time_entries WHERE id = $1', [server.id]);
    expect(Math.abs(new Date(trimmed.ended_at) - new Date(ago(180)))).toBeLessThan(5000);
    const dev = await db.one('SELECT * FROM time_entries WHERE id = $1', [res.body.data.createdEntryId]);
    expect(dev).toMatchObject({ is_offline: true, source: 'desktop' });
    expect((await owner.api.post(`/api/v1/sync-conflicts/${c.id}/resolve`).send({ resolution: 'keep_server' })).status).toBe(409);
  });

  it('never overwrites approved entries when keeping device data', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    await db.query(
      `INSERT INTO time_entries (organization_id, member_id, started_at, ended_at, status) VALUES ($1,$2,$3,$4,'approved')`,
      [owner.orgId, emp.memberId, ago(500), ago(440)],
    );
    const items = { timeEntries: [{ clientUuid: uuid(), startedAt: ago(470), endedAt: ago(430) }] };
    const r = await a.api.post('/api/v1/agent/sync').send({ batchUuid: uuid(), checksum: checksum(items), items }).expect(200);
    const res = await owner.api.post(`/api/v1/sync-conflicts/${r.body.data.results[0].conflictId}/resolve`).send({ resolution: 'keep_device' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ENTRY_LOCKED');
    await owner.api.post(`/api/v1/sync-conflicts/${r.body.data.results[0].conflictId}/resolve`).send({ resolution: 'keep_server' }).expect(200);
  });
});

describe('desktop notifications', () => {
  it('returns notifications delivered to the desktop channel', async () => {
    const emp = await newEmployee();
    const a = await agentLogin(emp);
    const { notify } = await import('../src/modules/notifications/service.js');
    await notify({ orgId: owner.orgId, memberIds: [emp.memberId], type: 'task.assigned', title: 'New task', email: false });
    const r = await a.api.get(`/api/v1/agent/notifications?since=${encodeURIComponent(ago(5))}`).expect(200);
    expect(r.body.data.some((n) => n.title === 'New task')).toBe(true);
  });
});
