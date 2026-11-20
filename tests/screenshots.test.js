import crypto from 'node:crypto';
import sharp from 'sharp';
import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, request, client, db } from './helpers.js';
import { drainJobs, runCron } from '../src/lib/jobs.js';
import { objectExists, putObject, buildKey, getObject } from '../src/lib/storage.js';

let t;
let owner;
let project;
let png;

const uuid = () => crypto.randomUUID();

async function agentLogin(m) {
  const res = await request(t.app)
    .post('/api/v1/agent/auth/login')
    .send({ email: m.email, password: m.password, device: { os: 'windows', appVersion: '1.0.0', machineId: `m-${uuid()}` } });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return { ...res.body.data, api: client(t.app, res.body.data.deviceToken) };
}

/** Upload + register one screenshot through the agent API. */
async function capture(a, extra = {}) {
  const up = await a.api.post('/api/v1/agent/screenshots/upload-url').send({ contentType: 'image/png', size: png.length }).expect(201);
  const path = up.body.data.uploadUrl.replace(/^https?:\/\/[^/]+/, '');
  await request(t.app).put(path).set('Content-Type', 'image/png').send(png).expect(200);
  const res = await a.api
    .post('/api/v1/agent/screenshots')
    .send({ key: up.body.data.key, clientUuid: uuid(), monitorIndex: 0, capturedAt: new Date().toISOString(), width: 64, height: 48, activityPercent: 70, appName: 'Code', windowTitle: 'main.js', ...extra })
    .expect(201);
  return res.body.data.id;
}

let emp;
let agent;
let manager;
let emp2;

beforeAll(async () => {
  t = await setupApp();
  png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  owner = await registerOrg(t);
  project = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Shots') RETURNING *`, [owner.orgId]);
  emp = await addMember(t, owner, { role: 'employee' });
  emp2 = await addMember(t, owner, { role: 'employee' });
  manager = await addMember(t, owner, { role: 'manager' });
  const team = await db.one(`INSERT INTO teams (organization_id, name) VALUES ($1, 'Team A') RETURNING id`, [owner.orgId]);
  await db.query('INSERT INTO team_members (team_id, member_id, is_leader) VALUES ($1,$2,true), ($1,$3,false)', [team.id, manager.memberId, emp.memberId]);
  for (const m of [emp, emp2]) await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2)', [project.id, m.memberId]);
  agent = await agentLogin(emp);
});

describe('screenshot capture & processing (SS-01, SS-12, SS-P4)', () => {
  it('refuses upload URLs while no timer runs', async () => {
    const r = await agent.api.post('/api/v1/agent/screenshots/upload-url').send({ contentType: 'image/png', size: 100 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('NO_ACTIVE_TIMER');
    const bad = await agent.api.post('/api/v1/agent/screenshots/upload-url').send({ contentType: 'image/gif', size: 100 });
    expect(bad.status).toBe(400);
  });

  it('stores a screenshot, links it to the entry and creates a thumbnail', async () => {
    await agent.api.post('/api/v1/agent/timer/start').send({ projectId: project.id }).expect(201);
    const id = await capture(agent);
    let s = await db.one('SELECT * FROM screenshots WHERE id = $1', [id]);
    expect(s.project_id).toBe(project.id);
    expect(s.time_entry_id).toBeTruthy();
    expect(s.thumb_key).toBeNull();
    expect(t.emitted.some((e) => e.event === 'screenshot.captured' && e.room === `user:${emp.user.id}`)).toBe(true);
    await drainJobs();
    s = await db.one('SELECT * FROM screenshots WHERE id = $1', [id]);
    expect(s.thumb_key).toMatch(/\.webp$/);
    expect(await objectExists(s.thumb_key)).toBe(true);
    expect(s.is_blurred).toBe(false);
    const meta = await sharp(await getObject(s.thumb_key)).metadata();
    expect(meta.format).toBe('webp');
    // strict metadata
    const extra = await agent.api.post('/api/v1/agent/screenshots').send({ key: s.object_key, clientUuid: uuid(), capturedAt: new Date().toISOString(), width: 1, height: 1, keystrokes: 'x' });
    expect(extra.status).toBe(400);
  });

  it('scopes gallery access: own always, managers see team, others nothing (SS-26, SS-P3)', async () => {
    const own = await emp.api.get('/api/v1/screenshots').expect(200);
    expect(own.body.data.length).toBeGreaterThan(0);
    const id = own.body.data[0].id;
    expect(own.body.data[0].thumbUrl).toContain('/api/v1/files/');
    const other = await emp2.api.get('/api/v1/screenshots').expect(200);
    expect(other.body.data).toHaveLength(0);
    expect((await emp2.api.get(`/api/v1/screenshots/${id}`)).status).toBe(404);
    expect((await emp2.api.get(`/api/v1/screenshots/${id}/download`)).status).toBe(404);
    const mgr = await manager.api.get(`/api/v1/screenshots?memberId=${emp.memberId}`).expect(200);
    expect(mgr.body.data.map((x) => x.id)).toContain(id);
    const tl = await emp.api.get(`/api/v1/screenshots/timeline?date=${new Date().toISOString().slice(0, 10)}`).expect(200);
    expect(tl.body.data.totalScreenshots).toBeGreaterThan(0);
    const latest = await owner.api.get('/api/v1/screenshots/latest?limit=5').expect(200);
    expect(latest.body.data.length).toBeGreaterThan(0);
    const high = await owner.api.get('/api/v1/screenshots?activityLevel=high').expect(200);
    expect(high.body.data.length).toBeGreaterThan(0);
    const low = await owner.api.get('/api/v1/screenshots?activityLevel=low').expect(200);
    expect(low.body.data).toHaveLength(0);
  });

  it('blur hides the original from managers but not from the employee (SS-16)', async () => {
    await db.query(`UPDATE tracking_settings SET screenshot_blur = true WHERE organization_id = $1 AND scope_type = 'org'`, [owner.orgId]);
    const id = await capture(agent);
    // before processing: manager gets no URL at all, never the original
    const pre = await manager.api.get(`/api/v1/screenshots/${id}`).expect(200);
    expect(pre.body.data.url).toBeNull();
    await drainJobs();
    const s = await db.one('SELECT * FROM screenshots WHERE id = $1', [id]);
    expect(s.is_blurred).toBe(true);
    expect(s.blurred_key).toBeTruthy();
    const mgr = await manager.api.get(`/api/v1/screenshots/${id}`).expect(200);
    expect(mgr.body.data.blurredForViewer).toBe(true);
    expect(mgr.body.data.url).toContain(s.blurred_key);
    expect(mgr.body.data.url).not.toContain(s.object_key);
    expect(mgr.body.data.thumbUrl).not.toContain(s.thumb_key);
    const dl = await manager.api.get(`/api/v1/screenshots/${id}/download`).expect(200);
    expect(dl.body.data.blurred).toBe(true);
    expect(dl.body.data.url).toContain(s.blurred_key);
    const mine = await emp.api.get(`/api/v1/screenshots/${id}`).expect(200);
    expect(mine.body.data.url).toContain(s.object_key);
    expect(mine.body.data.blurredForViewer).toBe(false);
    await db.query(`UPDATE tracking_settings SET screenshot_blur = false WHERE organization_id = $1 AND scope_type = 'org'`, [owner.orgId]);
  });

  it('deletes screenshots respecting the employee-delete setting (SS-15)', async () => {
    const id = await capture(agent);
    await drainJobs();
    const denied = await emp.api.delete(`/api/v1/screenshots/${id}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('SCREENSHOT_DELETE_NOT_ALLOWED');
    expect((await manager.api.delete(`/api/v1/screenshots/${id}`)).status).toBe(403); // managers lack screenshots.delete
    const s = await db.one('SELECT * FROM screenshots WHERE id = $1', [id]);
    await owner.api.delete(`/api/v1/screenshots/${id}`).expect(204);
    expect(await objectExists(s.object_key)).toBe(false);
    expect(await objectExists(s.thumb_key)).toBe(false);
    expect((await emp.api.get(`/api/v1/screenshots/${id}`)).status).toBe(404);
    await db.query(`UPDATE tracking_settings SET allow_employee_screenshot_delete = true WHERE organization_id = $1 AND scope_type = 'org'`, [owner.orgId]);
    const id2 = await capture(agent);
    await emp.api.delete(`/api/v1/screenshots/${id2}`).expect(204);
  });

  it('exports screenshots as a ZIP and notifies (SS-25)', async () => {
    const r = await owner.api.post('/api/v1/screenshots/export').send({ filters: { memberId: emp.memberId } }).expect(201);
    expect(r.body.data.screenshotCount).toBeGreaterThan(0);
    await drainJobs();
    const job = await owner.api.get(`/api/v1/exports/${r.body.data.id}`).expect(200);
    expect(job.body.data.status).toBe('done');
    expect(job.body.data.downloadUrl).toContain('/api/v1/files/');
    const zip = await request(t.app).get(job.body.data.downloadUrl.replace(/^https?:\/\/[^/]+/, '')).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(zip.status).toBe(200);
    expect(zip.body.subarray(0, 2).toString()).toBe('PK');
    const n = await db.one(`SELECT 1 FROM notifications WHERE type = 'export.ready' AND recipient_user_id = $1`, [owner.user.id]);
    expect(n).toBeTruthy();
    expect((await emp.api.get(`/api/v1/exports/${r.body.data.id}`)).status).toBe(404);
    expect((await emp2.api.post('/api/v1/screenshots/export').send({ filters: {} })).status).toBe(403);
  });

  it('reports storage and enforces retention nightly (SS-17, SS-24)', async () => {
    const st = await owner.api.get('/api/v1/screenshots/storage').expect(200);
    expect(st.body.data.screenshotBytes).toBeGreaterThan(0);
    expect((await emp.api.get('/api/v1/screenshots/storage')).status).toBe(403);
    // an old screenshot (40 days) beyond the 30-day retention
    const entry = await db.one(
      `INSERT INTO time_entries (organization_id, member_id, started_at, ended_at, status) VALUES ($1,$2, now() - interval '40 days', now() - interval '40 days' + interval '1 hour', 'completed') RETURNING id`,
      [owner.orgId, emp.memberId],
    );
    const key = buildKey({ orgId: owner.orgId, purpose: 'screenshot', ext: '.png' });
    await putObject(key, png, { orgId: owner.orgId, purpose: 'screenshot', contentType: 'image/png' });
    const before = Number((await db.one(`SELECT value FROM usage_counters WHERE organization_id = $1 AND metric = 'storage_bytes'`, [owner.orgId])).value);
    const old = await db.one(
      `INSERT INTO screenshots (organization_id, member_id, time_entry_id, captured_at, object_key, size_bytes) VALUES ($1,$2,$3, now() - interval '40 days' + interval '10 minutes', $4, $5) RETURNING id`,
      [owner.orgId, emp.memberId, entry.id, key, png.length],
    );
    const recent = (await db.one('SELECT id FROM screenshots WHERE member_id = $1 AND deleted_at IS NULL ORDER BY captured_at DESC LIMIT 1', [emp.memberId])).id;
    await runCron('screenshots.retention');
    expect(await db.one('SELECT id FROM screenshots WHERE id = $1', [old.id])).toBeNull();
    expect(await objectExists(key)).toBe(false);
    expect(await db.one('SELECT id FROM screenshots WHERE id = $1', [recent])).toBeTruthy();
    const after = Number((await db.one(`SELECT value FROM usage_counters WHERE organization_id = $1 AND metric = 'storage_bytes'`, [owner.orgId])).value);
    expect(after).toBe(before - png.length);
  });
});
