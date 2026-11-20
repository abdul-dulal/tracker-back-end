import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';
import { runCron } from '../src/lib/jobs.js';

let t;
let owner, manager, empA, empB, empC, teamId, projectId;
const Q = 'from=2026-11-02&to=2026-11-03';

beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  manager = await addMember(t, owner, { role: 'manager' });
  empA = await addMember(t, owner, { role: 'employee', firstName: 'Alice' });
  empB = await addMember(t, owner, { role: 'employee', firstName: 'Bob' });
  empC = await addMember(t, owner, { role: 'employee', firstName: 'Carl' });
  const org = owner.orgId;
  teamId = (await db.one(`INSERT INTO teams (organization_id, name) VALUES ($1, 'Alpha') RETURNING id`, [org])).id;
  await db.query('INSERT INTO team_members (team_id, member_id) VALUES ($1,$2),($1,$3)', [teamId, empA.memberId, empB.memberId]);
  await db.query('INSERT INTO team_managers (team_id, member_id) VALUES ($1,$2)', [teamId, manager.memberId]);
  await db.query(
    `INSERT INTO daily_summaries (organization_id, member_id, date, tracked_seconds, active_seconds, activity_percent, productive_seconds, unproductive_seconds, neutral_seconds)
     VALUES ($1,$2,'2026-11-02',28800,17280,60,21600,7200,0), ($1,$3,'2026-11-02',3600,1080,30,0,3600,0), ($1,$4,'2026-11-02',7200,7200,100,7200,0,0)`,
    [org, empA.memberId, empB.memberId, empC.memberId],
  );
  projectId = (await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1,'Apollo') RETURNING id`, [org])).id;
  const task = async (title, due, completedAt, est) => {
    const id = (await db.one(
      `INSERT INTO tasks (organization_id, project_id, title, due_date, completed_at, estimated_hours, created_at) VALUES ($1,$2,$3,$4,$5,$6,'2026-10-30') RETURNING id`,
      [org, projectId, title, due, completedAt, est],
    )).id;
    await db.query('INSERT INTO task_assignees (task_id, member_id) VALUES ($1,$2)', [id, empA.memberId]);
  };
  await task('On time', '2026-11-02', '2026-11-02T10:00:00Z', 2);
  await task('Open', '2026-11-03', null, 4);
});

describe('Productivity score & performance (PERF-01…19)', () => {
  it('computes the weighted productivity score with a disclaimer', async () => {
    const res = (await manager.api.get(`/api/v1/performance/members/${empA.memberId}?${Q}`).expect(200)).body.data;
    expect(res.metrics.activityPercent).toBe(60);
    expect(res.metrics.productiveRatio).toBe(75);
    expect(res.metrics.taskCompletionRate).toBe(50);
    // 0.4·60 + 0.4·75 + 0.2·50 = 64
    expect(res.metrics.productivityScore).toBe(64);
    expect(res.disclaimer).toMatch(/indicator/);
    expect(res.trend).toHaveLength(2);
    expect(res.consistency.days).toHaveLength(2);
    expect(res.metrics.consistencyScore).toBeGreaterThanOrEqual(0);
    expect(res.metrics.consistencyScore).toBeLessThan(100);
    expect(res.estimatedVsActual.estimatedHours).toBe(6);

    await db.query(`UPDATE organization_settings SET productivity_weights = '{"activity":1,"productive":0,"tasks":0}' WHERE organization_id = $1`, [owner.orgId]);
    const w = (await owner.api.get(`/api/v1/performance/members/${empA.memberId}?${Q}`).expect(200)).body.data;
    expect(w.metrics.productivityScore).toBe(60);
    await db.query(`UPDATE organization_settings SET productivity_weights = '{"activity":0.4,"productive":0.4,"tasks":0.2}' WHERE organization_id = $1`, [owner.orgId]);
  });

  it('enforces scope for members and teams', async () => {
    await empA.api.get(`/api/v1/performance/members/${empA.memberId}?${Q}`).expect(200);
    await empA.api.get(`/api/v1/performance/members/${empB.memberId}?${Q}`).expect(403);
    await manager.api.get(`/api/v1/performance/members/${empC.memberId}?${Q}`).expect(403);
    const team = (await manager.api.get(`/api/v1/performance/teams/${teamId}?${Q}&granularity=week`).expect(200)).body.data;
    expect(team.metrics.trackedSeconds).toBe(32400);
    expect(team.members.map((m) => m.memberId)).toEqual([empA.memberId, empB.memberId]);
    const cmp = (await manager.api.get(`/api/v1/performance/compare?${Q}&memberIds=${empA.memberId},${empB.memberId}`).expect(200)).body.data;
    expect(cmp.members).toHaveLength(2);
    await manager.api.get(`/api/v1/performance/compare?${Q}&memberIds=${empC.memberId}`).expect(403);
    const top = (await owner.api.get(`/api/v1/performance/top-contributors?${Q}&teamId=${teamId}`).expect(200)).body.data;
    expect(top.contributors[0]).toMatchObject({ memberId: empA.memberId, tasksCompleted: 1 });
    const wl = (await manager.api.get(`/api/v1/performance/workload?teamId=${teamId}`).expect(200)).body.data;
    expect(wl.members.find((m) => m.memberId === empA.memberId).remainingEstimateHours).toBe(4);
  });

  it('applies leaderboard visibility for employees', async () => {
    const lb = (await empA.api.get(`/api/v1/leaderboard?metric=hours&${Q}`).expect(200)).body.data;
    expect(lb.entries[0]).toMatchObject({ rank: 1, memberId: empA.memberId, value: 28800 });
    expect(lb.me.rank).toBe(1);
    const prod = (await owner.api.get(`/api/v1/leaderboard?metric=productivity&${Q}&teamId=${teamId}`).expect(200)).body.data;
    expect(prod.entries.map((e) => e.memberId)).toEqual([empA.memberId, empB.memberId]);
    await db.query('UPDATE organization_settings SET leaderboard_visible_to_employees = false WHERE organization_id = $1', [owner.orgId]);
    const denied = await empA.api.get('/api/v1/leaderboard');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('LEADERBOARD_HIDDEN');
    await manager.api.get('/api/v1/leaderboard?metric=monthly_ranking').expect(200);
    await db.query('UPDATE organization_settings SET leaderboard_visible_to_employees = true WHERE organization_id = $1', [owner.orgId]);
  });

  it('manages goals and custom metrics', async () => {
    const g = (await manager.api
      .post('/api/v1/performance-goals')
      .send({ name: 'Hours', scopeType: 'member', scopeId: empA.memberId, metric: 'trackedHours', target: 30, period: 'week' })
      .expect(201)).body.data;
    expect(g.progress).toMatchObject({ target: 30, met: false });
    await empA.api
      .post('/api/v1/performance-goals')
      .send({ name: 'X', scopeType: 'member', scopeId: empB.memberId, metric: 'trackedHours', target: 1 })
      .expect(403);
    await empA.api.post('/api/v1/performance-goals').send({ name: 'Mine', scopeType: 'member', scopeId: empA.memberId, metric: 'activityPercent', target: 50 }).expect(201);
    await manager.api.post('/api/v1/performance-goals').send({ name: 'Team', scopeType: 'team', scopeId: teamId, metric: 'tasksCompleted', target: 5, period: 'month' }).expect(201);
    const mine = (await empA.api.get('/api/v1/performance-goals').expect(200)).body.data;
    expect(mine.map((x) => x.name).sort()).toEqual(['Hours', 'Mine', 'Team']);
    expect((await empC.api.get('/api/v1/performance-goals').expect(200)).body.data).toHaveLength(0);
    await manager.api.patch(`/api/v1/performance-goals/${g.id}`).send({ target: 10 }).expect(200);
    await manager.api.delete(`/api/v1/performance-goals/${g.id}`).expect(204);

    const m = (await owner.api
      .post('/api/v1/custom-metrics')
      .send({ name: 'Focus', formula: { terms: [{ metric: 'trackedHours', weight: 1 }, { metric: 'activityPercent', weight: 0.1 }] } })
      .expect(201)).body.data;
    await owner.api.post('/api/v1/custom-metrics').send({ name: 'Bad', formula: { terms: [{ metric: 'salary', weight: 1 }] } }).expect(400);
    await empA.api.post('/api/v1/custom-metrics').send({ name: 'E', formula: { terms: [{ metric: 'trackedHours', weight: 1 }] } }).expect(403);
    const ev = (await manager.api.get(`/api/v1/custom-metrics/${m.id}/evaluate?${Q}&memberIds=${empA.memberId}`).expect(200)).body.data;
    expect(ev.results[0].value).toBe(14); // 8 h + 0.1·60
    await manager.api.get(`/api/v1/custom-metrics/${m.id}/evaluate?${Q}&memberIds=${empC.memberId}`).expect(403);
  });

  it('runs snapshot, alert and summary crons idempotently', async () => {
    await runCron('performance.snapshots');
    await runCron('performance.snapshots');
    const h = (await empA.api.get('/api/v1/performance/history').expect(200)).body.data;
    expect(h.snapshots).toHaveLength(1);
    await empA.api.get(`/api/v1/performance/history?memberId=${empB.memberId}`).expect(403);

    await db.query(
      `INSERT INTO daily_summaries (organization_id, member_id, date, tracked_seconds, active_seconds, activity_percent, unproductive_seconds)
       VALUES ($1,$2,(now() AT TIME ZONE 'UTC')::date - 2, 3600, 360, 10, 3600)`,
      [owner.orgId, empB.memberId],
    );
    await runCron('performance.alerts');
    await runCron('performance.alerts');
    const alerts = await db.many(
      `SELECT n.* FROM notifications n WHERE n.type = 'productivity.alert' AND n.recipient_user_id = $1 AND n.data->>'memberId' = $2`,
      [manager.user.id, empB.memberId],
    );
    expect(alerts).toHaveLength(1);

    await runCron('summary.weekly');
    await runCron('summary.weekly');
    const weekly = await db.many(`SELECT * FROM notifications WHERE type = 'summary.weekly' AND recipient_user_id = $1`, [empA.user.id]);
    expect(weekly).toHaveLength(1);
    const teamSummary = await db.many(`SELECT * FROM notifications WHERE type = 'summary.weekly' AND recipient_user_id = $1 AND data->>'teamId' = $2`, [manager.user.id, teamId]);
    expect(teamSummary).toHaveLength(1);
    await runCron('summary.monthly');
    expect((await db.many(`SELECT 1 FROM notifications WHERE type = 'summary.monthly' AND recipient_user_id = $1`, [empA.user.id]))).toHaveLength(1);
  });
});
