import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';
import { startTimer } from '../src/modules/time/timer-service.js';

let t;
let owner;
let manager;
let emp;
let emp2;
let p1;
let p2;

const minsAgo = (m) => new Date(Date.now() - m * 60_000);

async function insertIdle(member, entryId, startMinAgo, endMinAgo) {
  return db.one(
    `INSERT INTO idle_periods (organization_id, member_id, time_entry_id, started_at, ended_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [owner.orgId, member.memberId, entryId, minsAgo(startMinAgo), minsAgo(endMinAgo)],
  );
}

beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  manager = await addMember(t, owner, { role: 'manager' });
  emp = await addMember(t, owner, { role: 'employee' });
  emp2 = await addMember(t, owner, { role: 'employee' });
  p1 = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Alpha') RETURNING *`, [owner.orgId]);
  p2 = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Beta') RETURNING *`, [owner.orgId]);
  for (const p of [p1, p2]) for (const m of [emp, emp2]) await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2)', [p.id, m.memberId]);
});

describe('idle resolution (TIME-16, 22, BRK-12)', () => {
  it('reassign splits a running entry into original + reassigned + running continuation', async () => {
    const ctx = { orgId: owner.orgId, memberId: emp.memberId, cache: new Map() };
    const { entry } = await startTimer(ctx, { projectId: p1.id, startedAt: minsAgo(120), source: 'desktop' });
    // a pause inside the idle window (auto-pause) that ended inside it
    await db.query(`INSERT INTO time_entry_pauses (time_entry_id, started_at, ended_at, reason) VALUES ($1,$2,$3,'idle')`, [entry.id, minsAgo(80), minsAgo(70)]);
    await db.query(`UPDATE time_entries SET paused_seconds = 600 WHERE id = $1`, [entry.id]);
    const idle = await insertIdle(emp, entry.id, 90, 60);

    const list = await emp.api.get('/api/v1/idle-periods?status=pending').expect(200);
    expect(list.body.data.map((i) => i.id)).toContain(idle.id);

    const denied = await emp2.api.post(`/api/v1/idle-periods/${idle.id}/resolve`).send({ action: 'keep' });
    expect(denied.status).toBe(403);
    const noProject = await emp.api.post(`/api/v1/idle-periods/${idle.id}/resolve`).send({ action: 'reassign' });
    expect(noProject.status).toBe(400);

    const res = await emp.api.post(`/api/v1/idle-periods/${idle.id}/resolve`).send({ action: 'reassign', projectId: p2.id, note: 'call with client' }).expect(200);
    const { original, reassigned, continuation } = res.body.data.entries;
    expect(res.body.data.idlePeriod.resolution).toBe('reassigned');
    expect(res.body.data.idlePeriod.reassignedEntryId).toBe(reassigned.id);

    expect(original.id).toBe(entry.id);
    expect(new Date(original.endedAt).getTime()).toBe(new Date(idle.started_at).getTime());
    expect(original.status).toBe('completed');
    expect(original.durationSeconds).toBe(30 * 60);
    expect(original.pausedSeconds).toBe(0);

    expect(reassigned.project.id).toBe(p2.id);
    expect(reassigned.status).toBe('completed');
    expect(reassigned.durationSeconds).toBe(30 * 60);
    expect(reassigned.note).toBe('call with client');
    expect(reassigned.source).toBe('desktop');

    expect(continuation.endedAt).toBeNull();
    expect(continuation.status).toBe('running');
    expect(continuation.source).toBe('desktop');
    expect(continuation.project.id).toBe(p1.id);
    expect(new Date(continuation.startedAt).getTime()).toBe(new Date(idle.ended_at).getTime());

    const cur = await emp.api.get('/api/v1/timer/current').expect(200);
    expect(cur.body.data.entry.id).toBe(continuation.id);
    const hist = await db.many('SELECT time_entry_id, action FROM time_entry_history WHERE time_entry_id = ANY($1::uuid[])', [[original.id, reassigned.id, continuation.id]]);
    expect(hist.some((h) => h.time_entry_id === original.id && h.action === 'update')).toBe(true);
    expect(hist.some((h) => h.time_entry_id === reassigned.id && h.action === 'create')).toBe(true);
    expect(hist.some((h) => h.time_entry_id === continuation.id && h.action === 'create')).toBe(true);

    const again = await emp.api.post(`/api/v1/idle-periods/${idle.id}/resolve`).send({ action: 'keep' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('IDLE_ALREADY_RESOLVED');

    // stopping still works on the continuation
    const stop = await emp.api.post('/api/v1/timer/stop').expect(200);
    expect(stop.body.data.entry.id).toBe(continuation.id);
  });

  it('reassign on a completed entry ending after the idle creates a completed continuation', async () => {
    const e = await db.one(
      `INSERT INTO time_entries (organization_id, member_id, project_id, started_at, ended_at, duration_seconds, status, source)
       VALUES ($1,$2,$3,$4,$5,3600,'completed','web_timer') RETURNING id`,
      [owner.orgId, emp.memberId, p1.id, minsAgo(300), minsAgo(240)],
    );
    const idle = await insertIdle(emp, e.id, 280, 270);
    const res = await emp.api.post(`/api/v1/timer/idle/${idle.id}/resolve`).send({ action: 'reassign', projectId: p2.id }).expect(200);
    const { original, reassigned, continuation } = res.body.data.entries;
    expect(original.durationSeconds).toBe(20 * 60);
    expect(reassigned.durationSeconds).toBe(10 * 60);
    expect(continuation.durationSeconds).toBe(30 * 60);
    expect(continuation.status).toBe('completed');
  });

  it('discard reduces worked time; keep leaves it', async () => {
    const e = await db.one(
      `INSERT INTO time_entries (organization_id, member_id, project_id, started_at, ended_at, duration_seconds, status, source)
       VALUES ($1,$2,$3,$4,$5,3600,'completed','web_timer') RETURNING id`,
      [owner.orgId, emp.memberId, p1.id, minsAgo(500), minsAgo(440)],
    );
    const i1 = await insertIdle(emp, e.id, 490, 480);
    const i2 = await insertIdle(emp, e.id, 470, 465);
    const d = await emp.api.post(`/api/v1/idle-periods/${i1.id}/resolve`).send({ action: 'discard' }).expect(200);
    expect(d.body.data.entry.durationSeconds).toBe(3000);
    expect(d.body.data.entry.idleDiscardedSeconds).toBe(600);
    const k = await emp.api.post(`/api/v1/idle-periods/${i2.id}/resolve`).send({ action: 'keep' }).expect(200);
    expect(k.body.data.idlePeriod.resolution).toBe('kept');
    expect(k.body.data.entry.durationSeconds).toBe(3000);
    expect(k.body.data.entry.idleSeconds).toBe(900);
  });
});

describe('idle adjustments (BRK-14, BRK-15)', () => {
  let idle;
  let entryId;
  beforeAll(async () => {
    const e = await db.one(
      `INSERT INTO time_entries (organization_id, member_id, project_id, started_at, ended_at, duration_seconds, status, source)
       VALUES ($1,$2,$3,$4,$5,3600,'completed','web_timer') RETURNING id`,
      [owner.orgId, emp2.memberId, p1.id, minsAgo(700), minsAgo(640)],
    );
    entryId = e.id;
    idle = await insertIdle(emp2, e.id, 690, 670);
    await emp2.api.post(`/api/v1/idle-periods/${idle.id}/resolve`).send({ action: 'discard' }).expect(200);
  });

  it('employee requests, manager outside scope is denied, owner approves → entry restored', async () => {
    const other = await emp.api.post('/api/v1/idle-adjustments').send({ idlePeriodId: idle.id, requestedAction: 'keep', reason: 'was reading docs' });
    expect(other.status).toBe(403);
    const same = await emp2.api.post('/api/v1/idle-adjustments').send({ idlePeriodId: idle.id, requestedAction: 'discard', reason: 'x' });
    expect(same.body.error.code).toBe('NO_CHANGE');
    const req = await emp2.api.post('/api/v1/idle-adjustments').send({ idlePeriodId: idle.id, requestedAction: 'keep', reason: 'was reading docs' }).expect(201);
    expect(req.body.data.status).toBe('pending');
    const dup = await emp2.api.post('/api/v1/idle-adjustments').send({ idlePeriodId: idle.id, requestedAction: 'keep', reason: 'again' });
    expect(dup.body.error.code).toBe('ADJUSTMENT_PENDING');
    const n = await db.one(`SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND type = 'approval.requested'`, [owner.user.id]);
    expect(n.n).toBeGreaterThan(0);

    const mine = await emp2.api.get('/api/v1/idle-adjustments').expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect((await emp.api.get('/api/v1/idle-adjustments').expect(200)).body.data).toHaveLength(0);
    expect((await emp.api.post(`/api/v1/idle-adjustments/${req.body.data.id}/approve`).send({})).status).toBe(403);
    expect((await manager.api.post(`/api/v1/idle-adjustments/${req.body.data.id}/approve`).send({})).status).toBe(403);
    expect((await manager.api.get(`/api/v1/idle-adjustments?memberId=${emp2.memberId}`)).status).toBe(403);

    const before = await db.one('SELECT duration_seconds FROM time_entries WHERE id = $1', [entryId]);
    expect(before.duration_seconds).toBe(2400);
    const ap = await owner.api.post(`/api/v1/idle-adjustments/${req.body.data.id}/approve`).send({ note: 'fine' }).expect(200);
    expect(ap.body.data.status).toBe('approved');
    expect(ap.body.data.idlePeriod.resolution).toBe('kept');
    const after = await db.one('SELECT duration_seconds FROM time_entries WHERE id = $1', [entryId]);
    expect(after.duration_seconds).toBe(3600);
    const resolved = await db.one(`SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND type = 'approval.resolved'`, [emp2.user.id]);
    expect(resolved.n).toBe(1);
    expect((await owner.api.post(`/api/v1/idle-adjustments/${req.body.data.id}/reject`).send({})).status).toBe(409);
  });

  it('manager with team scope can reject', async () => {
    const team = await db.one(`INSERT INTO teams (organization_id, name) VALUES ($1, 'Ops') RETURNING id`, [owner.orgId]);
    await db.query('INSERT INTO team_members (team_id, member_id) VALUES ($1,$2)', [team.id, emp2.memberId]);
    await db.query('INSERT INTO team_managers (team_id, member_id) VALUES ($1,$2)', [team.id, manager.memberId]);
    const req = await emp2.api.post('/api/v1/idle-adjustments').send({ idlePeriodId: idle.id, requestedAction: 'discard', reason: 'oops' }).expect(201);
    const list = await manager.api.get('/api/v1/idle-adjustments?status=pending').expect(200);
    expect(list.body.data.map((a) => a.id)).toContain(req.body.data.id);
    const rj = await manager.api.post(`/api/v1/idle-adjustments/${req.body.data.id}/reject`).send({ note: 'no' }).expect(200);
    expect(rj.body.data.status).toBe('rejected');
    expect(rj.body.data.idlePeriod.resolution).toBe('kept');
    const periods = await manager.api.get(`/api/v1/idle-periods?memberId=${emp2.memberId}`).expect(200);
    expect(periods.body.data.length).toBeGreaterThan(0);
  });
});
