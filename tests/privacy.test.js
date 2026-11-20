import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, request, db } from './helpers.js';
import { drainJobs, runCron } from '../src/lib/jobs.js';
import { putObject, objectExists, buildKey } from '../src/lib/storage.js';

let t;
let owner;
let emp;
let other;
beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  emp = await addMember(t, owner, { role: 'employee' });
  other = await addMember(t, owner, { role: 'employee' });
});

async function seedTracking(m, { daysAgo = 0 } = {}) {
  const ts = `now() - interval '${daysAgo} days' - interval '2 hours'`;
  const te = await db.one(
    `INSERT INTO time_entries (organization_id, member_id, started_at, ended_at, duration_seconds, status, source, note)
     VALUES ($1,$2, ${ts}, ${ts} + interval '1 hour', 3600, 'approved', 'desktop', 'secret note') RETURNING id`,
    [m.orgId, m.memberId],
  );
  await db.query(
    `INSERT INTO activity_samples (organization_id, member_id, time_entry_id, interval_start, interval_seconds, active_seconds, activity_percent)
     VALUES ($1,$2,$3, ${ts}, 600, 300, 50)`,
    [m.orgId, m.memberId, te.id],
  );
  await db.query(
    `INSERT INTO app_usage (organization_id, member_id, app_identifier, app_name, started_at, ended_at, duration_seconds) VALUES ($1,$2,'code.exe','VS Code', ${ts}, ${ts} + interval '10 min', 600)`,
    [m.orgId, m.memberId],
  );
  await db.query(
    `INSERT INTO web_usage (organization_id, member_id, domain, started_at, ended_at, duration_seconds) VALUES ($1,$2,'github.com', ${ts}, ${ts} + interval '5 min', 300)`,
    [m.orgId, m.memberId],
  );
  await db.query(`INSERT INTO idle_periods (organization_id, member_id, started_at, ended_at) VALUES ($1,$2, ${ts}, ${ts} + interval '5 min')`, [m.orgId, m.memberId]);
  const key = buildKey({ orgId: m.orgId, purpose: 'screenshot', ext: '.png' });
  await putObject(key, Buffer.from('PNGDATA-fake-image'), { contentType: 'image/png', orgId: m.orgId, purpose: 'screenshot' });
  await db.query(
    `INSERT INTO screenshots (organization_id, member_id, captured_at, object_key, size_bytes, activity_percent) VALUES ($1,$2, ${ts}, $3, 18, 50)`,
    [m.orgId, m.memberId, key],
  );
  return { key, timeEntryId: te.id };
}

const count = async (table, memberId) => (await db.one(`SELECT count(*)::int AS n FROM ${table} WHERE member_id = $1`, [memberId])).n;

describe('Employee data access (PRIV-03)', () => {
  it('returns only my own data per type', async () => {
    await seedTracking(emp);
    await seedTracking(other);
    for (const type of ['time', 'activity', 'screenshots', 'apps', 'websites']) {
      const r = await emp.api.get(`/api/v1/me/data?type=${type}`).expect(200);
      expect(r.body.data.length).toBe(1);
      expect(r.body.meta.type).toBe(type);
    }
    const shots = await emp.api.get('/api/v1/me/data?type=screenshots').expect(200);
    expect(shots.body.data[0].url).toContain('/api/v1/files/');
    const att = await emp.api.get('/api/v1/me/data?type=attendance').expect(200);
    expect(att.body.data).toEqual([]);
    const old = await emp.api.get('/api/v1/me/data?type=time&from=2020-01-01&to=2020-01-31').expect(200);
    expect(old.body.data).toEqual([]);
    await emp.api.get('/api/v1/me/data?type=keystrokes').expect(400);
    await emp.api.get('/api/v1/me/data?from=2026-02-01&to=2026-01-01').expect(400);
  });
});

describe('Data requests (PRIV-07, PRIV-08, SEC-19, SEC-20)', () => {
  it('export: request → approve → ZIP produced, notified, downloadable', async () => {
    const r = await emp.api.post('/api/v1/data-requests').send({ type: 'export', reason: 'GDPR' }).expect(201);
    expect(r.body.data).toMatchObject({ type: 'export', status: 'pending' });
    const dup = await emp.api.post('/api/v1/data-requests').send({ type: 'export' });
    expect(dup.body.error.code).toBe('REQUEST_PENDING');
    // employees cannot approve, nor file for others
    await emp.api.post(`/api/v1/data-requests/${r.body.data.id}/approve`).send({}).expect(403);
    await emp.api.post('/api/v1/data-requests').send({ type: 'export', memberId: other.memberId }).expect(403);
    // scoping of the list
    const mine = await emp.api.get('/api/v1/data-requests').expect(200);
    expect(mine.body.data.every((d) => d.member.id === emp.memberId)).toBe(true);
    await other.api.get(`/api/v1/data-requests/${r.body.data.id}`).expect(404);
    const all = await owner.api.get('/api/v1/data-requests?status=pending').expect(200);
    expect(all.body.data.some((d) => d.id === r.body.data.id)).toBe(true);
    // approvers notified
    expect(await db.one(`SELECT 1 AS ok FROM notifications WHERE recipient_user_id = $1 AND type = 'approval.requested'`, [owner.user.id])).toBeTruthy();

    await emp.api.get(`/api/v1/data-requests/${r.body.data.id}/download`).expect(409);
    await owner.api.post(`/api/v1/data-requests/${r.body.data.id}/approve`).send({ notes: 'ok' }).expect(200);
    await owner.api.post(`/api/v1/data-requests/${r.body.data.id}/approve`).send({}).expect(409);
    await drainJobs();
    const done = await emp.api.get(`/api/v1/data-requests/${r.body.data.id}`).expect(200);
    expect(done.body.data).toMatchObject({ status: 'completed', downloadAvailable: true });
    expect(await db.one(`SELECT 1 AS ok FROM notifications WHERE recipient_user_id = $1 AND type = 'export.ready'`, [emp.user.id])).toBeTruthy();

    const dl = await emp.api.get(`/api/v1/data-requests/${r.body.data.id}/download`).expect(200);
    const path = dl.body.data.url.replace('http://localhost:4000', '');
    const file = await request(t.app).get(path).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(file.body.subarray(0, 2).toString()).toBe('PK');
    const zipText = file.body.toString('latin1');
    for (const name of ['profile.json', 'time_entries.csv', 'activity_samples.json', 'app_usage.csv', 'web_usage.csv', 'screenshots.json', 'screenshots/']) expect(zipText).toContain(name);
    const row = await db.one('SELECT file_key FROM data_requests WHERE id = $1', [r.body.data.id]);
    expect((await db.one('SELECT purpose FROM files WHERE key = $1', [row.file_key])).purpose).toBe('export');
  });

  it('deletion removes tracking rows and screenshot objects, anonymizes time notes', async () => {
    const { key, timeEntryId } = await seedTracking(other, { daysAgo: 3 });
    expect(await count('activity_samples', other.memberId)).toBe(2);
    const r = await other.api.post('/api/v1/data-requests').send({ type: 'deletion' }).expect(201);
    const rej = await owner.api.post(`/api/v1/data-requests/${r.body.data.id}/reject`).send({ reason: 'legal hold' }).expect(200);
    expect(rej.body.data.status).toBe('rejected');
    const r2 = await other.api.post('/api/v1/data-requests').send({ type: 'deletion' }).expect(201);
    await owner.api.post(`/api/v1/data-requests/${r2.body.data.id}/approve`).send({}).expect(200);
    await drainJobs();
    for (const table of ['activity_samples', 'app_usage', 'web_usage', 'idle_periods', 'screenshots']) expect(await count(table, other.memberId)).toBe(0);
    expect(await objectExists(key)).toBe(false);
    const te = await db.one('SELECT note, duration_seconds FROM time_entries WHERE id = $1', [timeEntryId]);
    expect(te).toMatchObject({ note: null, duration_seconds: 3600 });
    expect(await count('time_entries', other.memberId)).toBe(2);
    const done = await owner.api.get(`/api/v1/data-requests/${r2.body.data.id}`).expect(200);
    expect(done.body.data.status).toBe('completed');
    // the employee's own data is untouched
    expect(await count('activity_samples', emp.memberId)).toBe(1);
  });
});

describe('Audit logs (SEC-10, PRIV-09)', () => {
  it('lists org audit history with filters; audit.view required', async () => {
    await emp.api.get('/api/v1/audit-logs').expect(403);
    const all = await owner.api.get('/api/v1/audit-logs').expect(200);
    expect(all.body.meta.total).toBeGreaterThan(0);
    const f = await owner.api.get('/api/v1/audit-logs?action=data_request.&entityType=data_request').expect(200);
    expect(f.body.data.length).toBeGreaterThan(0);
    expect(f.body.data.every((a) => a.action.startsWith('data_request.'))).toBe(true);
    const byActor = await owner.api.get(`/api/v1/audit-logs?actor=${owner.user.id}`).expect(200);
    expect(byActor.body.data.every((a) => a.actor.userId === owner.user.id)).toBe(true);
    const o2 = await registerOrg(t);
    const iso = await o2.api.get('/api/v1/audit-logs?action=data_request.').expect(200);
    expect(iso.body.data.length).toBe(0);
  });
});

describe('Retention cron (SEC-18)', () => {
  it('deletes data older than the org retention settings and expired tokens', async () => {
    const o = await registerOrg(t);
    const m = await addMember(t, o, { role: 'employee' });
    await seedTracking(m, { daysAgo: 40 });
    await seedTracking(m, { daysAgo: 1 });
    await db.query(`INSERT INTO notifications (organization_id, recipient_user_id, type, title, created_at) VALUES ($1,$2,'system','old', now() - interval '100 days')`, [o.orgId, m.user.id]);
    await db.query(`INSERT INTO auth_tokens (user_id, type, token_hash, expires_at) VALUES ($1,'password_reset','expired-hash-x', now() - interval '1 day')`, [m.user.id]);
    await db.query(`UPDATE organization_settings SET activity_retention_days = 30, data_retention_days = 90 WHERE organization_id = $1`, [o.orgId]);
    const keepOther = await count('activity_samples', emp.memberId);
    await runCron('retention.cleanup');
    expect(await count('activity_samples', m.memberId)).toBe(1);
    expect(await count('app_usage', m.memberId)).toBe(1);
    expect(await count('web_usage', m.memberId)).toBe(1);
    expect(await count('activity_samples', emp.memberId)).toBe(keepOther);
    expect((await db.one(`SELECT count(*)::int AS n FROM notifications WHERE organization_id = $1 AND title = 'old'`, [o.orgId])).n).toBe(0);
    expect(await db.one(`SELECT 1 FROM auth_tokens WHERE token_hash = 'expired-hash-x'`)).toBeNull();
  });
});
