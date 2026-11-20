import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';
import { runCron } from '../src/lib/jobs.js';

let t;
let owner, manager, empA, empB, empC, teamId, projectId;

const sum = (orgId, memberId, date, v) =>
  db.query(
    `INSERT INTO daily_summaries (organization_id, member_id, date, tracked_seconds, active_seconds, idle_seconds, break_seconds,
       productive_seconds, unproductive_seconds, neutral_seconds, overtime_seconds, activity_percent, screenshot_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [orgId, memberId, date, v.tracked, v.active ?? 0, v.idle ?? 0, v.brk ?? 0, v.prod ?? 0, v.unprod ?? 0, v.neut ?? 0, v.ot ?? 0, v.act ?? 0, v.shots ?? 0],
  );

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

  await sum(org, empA.memberId, '2026-11-02', { tracked: 28800, active: 14400, idle: 600, brk: 900, prod: 3600, unprod: 1800, neut: 1800, act: 50 });
  await sum(org, empA.memberId, '2026-11-03', { tracked: 14400, act: 70 });
  await sum(org, empB.memberId, '2026-11-02', { tracked: 7200, act: 40 });
  await sum(org, empC.memberId, '2026-11-02', { tracked: 3600, act: 90 });
  await sum(org, empA.memberId, '2026-11-01', { tracked: 3600, act: 50 });

  projectId = (await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Apollo') RETURNING id`, [org])).id;
  await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2),($1,$3),($1,$4)', [projectId, empA.memberId, empB.memberId, empC.memberId]);
  const task = async (title, assignee, { done = false, due = null } = {}) => {
    const id = (await db.one(
      `INSERT INTO tasks (organization_id, project_id, title, due_date, completed_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [org, projectId, title, due, done ? '2026-11-02T10:00:00Z' : null],
    )).id;
    await db.query('INSERT INTO task_assignees (task_id, member_id) VALUES ($1,$2)', [id, assignee]);
    return id;
  };
  await task('A done', empA.memberId, { done: true, due: '2026-11-03' });
  await task('A overdue', empA.memberId, { due: '2026-11-01' });
  await task('B open', empB.memberId);
  await task('C open', empC.memberId);
  // B has a running timer (online + tracking)
  await db.query(
    `INSERT INTO time_entries (organization_id, member_id, project_id, started_at, status, source) VALUES ($1,$2,$3, now() - interval '5 minutes', 'running', 'web_timer')`,
    [org, empB.memberId, projectId],
  );
});

const Q = '?from=2026-11-02&to=2026-11-03';

describe('Dashboard stats (RPT-D01…D14)', () => {
  it('computes org-wide KPIs with previous-period deltas for admins', async () => {
    const res = await owner.api.get(`/api/v1/dashboard/stats${Q}`).expect(200);
    const s = res.body.data;
    expect(s.totalEmployees).toBe(5);
    expect(s.totalWorkingSeconds).toBe(54000);
    expect(s.avgActivityPercent).toBeCloseTo(56.67, 1);
    expect(s.productiveSeconds).toBe(3600);
    expect(s.idleSeconds).toBe(600);
    expect(s.breakSeconds).toBe(900);
    expect(s.currentlyTracking).toBe(1);
    expect(s.onlineEmployees).toBeGreaterThanOrEqual(1);
    expect(s.totalProjects).toBe(1);
    expect(s.totalTasks).toBe(4);
    expect(s.completedTasks).toBe(1);
    expect(s.pendingTasks).toBe(3);
    expect(s.overtimeSeconds).toBe(0);
    expect(s.deltas.totalWorkingSeconds.previous).toBe(3600);
    expect(s.deltas.totalWorkingSeconds.change).toBe(50400);
    expect(s.previousPeriod).toEqual({ from: '2026-10-31', to: '2026-11-01' });
  });

  it('scopes employees to their own data and rejects other members', async () => {
    const s = (await empA.api.get(`/api/v1/dashboard/stats${Q}`).expect(200)).body.data;
    expect(s.totalEmployees).toBe(1);
    expect(s.totalWorkingSeconds).toBe(43200);
    expect(s.totalTasks).toBe(2);
    expect(s.completedTasks).toBe(1);
    await empA.api.get(`/api/v1/dashboard/stats${Q}&memberId=${empB.memberId}`).expect(403);
  });

  it('scopes managers to their team and supports team/member filters', async () => {
    const s = (await manager.api.get(`/api/v1/dashboard/stats${Q}`).expect(200)).body.data;
    expect(s.totalWorkingSeconds).toBe(50400); // A + B (+ manager with no data)
    const f = (await owner.api.get(`/api/v1/dashboard/stats${Q}&teamId=${teamId}`).expect(200)).body.data;
    expect(f.totalWorkingSeconds).toBe(50400);
    expect(f.totalEmployees).toBe(2);
    const m = (await owner.api.get(`/api/v1/dashboard/stats${Q}&memberId=${empC.memberId}`).expect(200)).body.data;
    expect(m.totalWorkingSeconds).toBe(3600);
    await manager.api.get(`/api/v1/dashboard/stats${Q}&memberId=${empC.memberId}`).expect(403);
  });

  it('returns overview, charts and the employee dashboard', async () => {
    const o = (await owner.api.get(`/api/v1/dashboard/overview${Q}`).expect(200)).body.data;
    expect(o.employees.total).toBe(5);
    expect(o.teams.find((x) => x.name === 'Alpha').trackedSeconds).toBe(50400);
    expect(o.tasks.overdue).toBe(1);
    expect(o.projects.active).toBe(1);

    const h = (await owner.api.get(`/api/v1/dashboard/charts/hours-distribution${Q}`).expect(200)).body.data;
    expect(h.series.map((x) => x.date)).toEqual(['2026-11-02', '2026-11-03']);
    expect(h.totals.trackedSeconds).toBe(54000);
    const ai = (await owner.api.get(`/api/v1/dashboard/charts/active-vs-idle${Q}&granularity=month`).expect(200)).body.data;
    expect(ai.series).toHaveLength(1);
    const ec = (await manager.api.get(`/api/v1/dashboard/charts/employee-comparison${Q}`).expect(200)).body.data;
    expect(ec.series.map((x) => x.memberId).sort()).toEqual([empA.memberId, empB.memberId].sort());
    for (const c of ['productivity-trend', 'app-usage', 'attendance', 'project-comparison'])
      await owner.api.get(`/api/v1/dashboard/charts/${c}${Q}`).expect(200);
    await owner.api.get(`/api/v1/dashboard/charts/nope${Q}`).expect(400);

    const me = (await empA.api.get('/api/v1/dashboard/me').expect(200)).body.data;
    expect(me.week.days).toHaveLength(7);
    expect(me.tasks.overdue.map((x) => x.title)).toContain('A overdue');
    expect(me.timer).toBeNull();
  });
});

describe('Approvals & action center (ADM-13…18)', () => {
  beforeAll(async () => {
    const ins = (m, day) =>
      db.query(
        `INSERT INTO time_entries (organization_id, member_id, started_at, ended_at, duration_seconds, status, source, approval_reason)
         VALUES ($1,$2,$3::timestamptz,$3::timestamptz + interval '1 hour',3600,'pending','manual','forgot')`,
        [owner.orgId, m, `2026-10-${day}T09:00:00Z`],
      );
    await ins(empA.memberId, '20');
    await ins(empC.memberId, '21');
  });

  it('lists only approvals within the approver scope', async () => {
    const all = (await owner.api.get('/api/v1/approvals/pending').expect(200)).body;
    expect(all.meta.total).toBe(2);
    expect(all.data[0]).toMatchObject({ type: 'manual_time', summary: expect.stringContaining('Manual time') });
    const mgr = (await manager.api.get('/api/v1/approvals/pending?type=manual_time').expect(200)).body;
    expect(mgr.data.map((x) => x.member.id)).toEqual([empA.memberId]);
    const counts = (await manager.api.get('/api/v1/approvals/counts').expect(200)).body.data;
    expect(counts.manual_time).toBe(1);
    expect(counts.total).toBe(1);
    await empA.api.get('/api/v1/approvals/pending').expect(403);
  });

  it('builds the action center and the activity feed', async () => {
    const ac = (await owner.api.get('/api/v1/action-center').expect(200)).body.data;
    expect(ac.approvals.total).toBe(2);
    expect(Array.isArray(ac.systemAlerts)).toBe(true);
    expect(ac.overdueTasks).toBe(1);
    const emp = (await empA.api.get('/api/v1/action-center').expect(200)).body.data;
    expect(emp.approvals).toBeNull();
    expect(emp.systemAlerts).toBeNull();

    await db.query(`INSERT INTO activity_log (organization_id, entity_type, entity_id, actor_member_id, action) VALUES ($1,'project',$2,$3,'project.updated')`, [owner.orgId, projectId, owner.memberId]);
    await db.query(`INSERT INTO activity_log (organization_id, entity_type, entity_id, actor_member_id, action) VALUES ($1,'invoice',gen_random_uuid(),$2,'invoice.sent')`, [owner.orgId, owner.memberId]);
    const feed = (await owner.api.get('/api/v1/activity-log?limit=10').expect(200)).body.data;
    expect(feed).toHaveLength(2);
    const empFeed = (await empA.api.get('/api/v1/activity-log').expect(200)).body.data;
    expect(empFeed.map((x) => x.action)).toEqual(['project.updated']);
  });

  it('raises, lists, resolves and auto-resolves system alerts', async () => {
    await db.query(`UPDATE subscriptions SET trial_ends_at = now() + interval '1 day' WHERE organization_id = $1`, [owner.orgId]);
    await runCron('system-alerts.check');
    await runCron('system-alerts.check'); // idempotent: still one open alert
    let alerts = (await owner.api.get('/api/v1/system-alerts').expect(200)).body.data;
    expect(alerts.filter((a) => a.type === 'trial.ending')).toHaveLength(1);
    await empA.api.get('/api/v1/system-alerts').expect(403);

    await db.query(`UPDATE subscriptions SET trial_ends_at = now() + interval '10 days' WHERE organization_id = $1`, [owner.orgId]);
    await runCron('system-alerts.check');
    alerts = (await owner.api.get('/api/v1/system-alerts').expect(200)).body.data;
    expect(alerts.some((a) => a.type === 'trial.ending')).toBe(false);

    await db.query(`INSERT INTO system_alerts (organization_id, type, message) VALUES ($1, 'custom.test', 'hello')`, [owner.orgId]);
    const a = (await owner.api.get('/api/v1/system-alerts').expect(200)).body.data.find((x) => x.type === 'custom.test');
    const resolved = (await owner.api.post(`/api/v1/system-alerts/${a.id}/resolve`).expect(200)).body.data;
    expect(resolved.resolvedAt).toBeTruthy();
  });
});
