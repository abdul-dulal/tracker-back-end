import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, request, db } from './helpers.js';
import { runCron } from '../src/lib/jobs.js';

let t;
let owner, manager, empA, empB, empC, teamId, p1, p2, taskId;

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const entry = (m, project, start, hours, { task = null, billable = true } = {}) =>
  db.query(
    `INSERT INTO time_entries (organization_id, member_id, project_id, task_id, started_at, ended_at, duration_seconds, active_seconds, status, source, is_billable)
     VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + make_interval(hours => $6),$6 * 3600,$6 * 1800,'completed','web_timer',$7)`,
    [owner.orgId, m, project, task, start, hours, billable],
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
  const client = (await db.one(`INSERT INTO clients (organization_id, name) VALUES ($1, 'Acme') RETURNING id`, [org])).id;
  p1 = (await db.one(`INSERT INTO projects (organization_id, name, client_id, budget_type, budget_value) VALUES ($1,'P1',$2,'hours',3) RETURNING id`, [org, client])).id;
  p2 = (await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1,'P2') RETURNING id`, [org])).id;
  await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2),($1,$3),($4,$2)', [p1, empA.memberId, empB.memberId, p2]);
  taskId = (await db.one(`INSERT INTO tasks (organization_id, project_id, title, due_date, estimated_hours, created_at) VALUES ($1,$2,'Build',$3,4,'2026-11-01T08:00:00Z') RETURNING id`, [org, p1, '2026-11-03'])).id;
  await db.query('INSERT INTO task_assignees (task_id, member_id) VALUES ($1,$2)', [taskId, empA.memberId]);
  await db.query(
    `INSERT INTO member_rates (organization_id, member_id, rate_type, amount, currency, effective_from) VALUES ($1,$2,'cost',10,'USD','2026-01-01')`,
    [org, empA.memberId],
  );
  await entry(empA.memberId, p1, '2026-11-02T09:00:00Z', 2, { task: taskId });
  await entry(empA.memberId, p2, '2026-11-03T09:00:00Z', 2, { billable: false });
  await entry(empB.memberId, p1, '2026-11-02T13:00:00Z', 1);
  await entry(empC.memberId, p2, '2026-11-02T13:00:00Z', 1);
  await db.query(
    `INSERT INTO daily_summaries (organization_id, member_id, date, tracked_seconds, active_seconds, activity_percent)
     VALUES ($1,$2,'2026-11-02',7200,3600,50),($1,$2,'2026-11-03',7200,5040,70),($1,$3,'2026-11-02',3600,1440,40),($1,$4,'2026-11-02',3600,3240,90)`,
    [org, empA.memberId, empB.memberId, empC.memberId],
  );
  await db.query(`INSERT INTO productivity_rules (organization_id, target_type, pattern, category) VALUES ($1,'app','slack','unproductive'),($1,'app','code','productive')`, [org]);
  await db.query(
    `INSERT INTO app_usage (organization_id, member_id, app_identifier, app_name, started_at, ended_at, duration_seconds) VALUES
     ($1,$2,'code','Code','2026-11-02T09:00Z','2026-11-02T10:00Z',3600),
     ($1,$2,'slack','Slack','2026-11-02T10:00Z','2026-11-02T10:30Z',1800),
     ($1,$3,'notes','Notes','2026-11-02T13:00Z','2026-11-02T13:30Z',1800)`,
    [org, empA.memberId, empB.memberId],
  );
  await db.query(
    `INSERT INTO attendance_records (organization_id, member_id, date, status, late_minutes) VALUES ($1,$2,'2026-11-02','present',0),($1,$2,'2026-11-03','late',15),($1,$3,'2026-11-02','absent',0)`,
    [org, empA.memberId, empB.memberId],
  );
});

const Q = 'from=2026-11-02&to=2026-11-03';

describe('Report engine (RPT-E, RPT-P, RPT-A)', () => {
  it('groups time by project with totals, cost and series', async () => {
    const r = (await owner.api.get(`/api/v1/reports/time?${Q}&groupBy=project`).expect(200)).body.data;
    const byName = Object.fromEntries(r.rows.map((x) => [x.project, x]));
    expect(byName.P1.trackedSeconds).toBe(10800);
    expect(byName.P2.trackedSeconds).toBe(10800);
    expect(r.totals.trackedSeconds).toBe(21600);
    expect(r.totals.billableSeconds).toBe(14400);
    expect(r.totals.cost).toBe(40); // only Alice has a cost rate: 4 h × 10
    expect(byName.P1.cost).toBe(20);
    expect(r.series.map((s) => s.date)).toEqual(['2026-11-02', '2026-11-03']);
    expect(r.columns[0]).toMatchObject({ key: 'project' });

    const dm = (await owner.api.get(`/api/v1/reports/time?${Q}&groupBy=day,member`).expect(200)).body.data;
    expect(dm.rows).toHaveLength(4);
    expect(dm.rows[0].day).toBe('2026-11-02');
    const sumRows = dm.rows.reduce((s, x) => s + x.trackedSeconds, 0);
    expect(sumRows).toBe(dm.totals.trackedSeconds);

    const team = (await owner.api.get(`/api/v1/reports/time?${Q}&groupBy=team`).expect(200)).body.data;
    expect(team.rows.find((x) => x.team === 'Alpha').trackedSeconds).toBe(18000);
    expect(team.rows.find((x) => x.team === '(no team)').trackedSeconds).toBe(3600);
  });

  it('applies scope: employee own only, manager team only, 403 on foreign member filter', async () => {
    const a = (await empA.api.get(`/api/v1/reports/time?${Q}&groupBy=member`).expect(200)).body.data;
    expect(a.rows.map((x) => x.memberId)).toEqual([empA.memberId]);
    expect(a.totals.trackedSeconds).toBe(14400);
    await empA.api.get(`/api/v1/reports/time?${Q}&memberIds=${empB.memberId}`).expect(403);
    const m = (await manager.api.get(`/api/v1/reports/activity?${Q}&groupBy=member`).expect(200)).body.data;
    expect(m.rows.map((x) => x.memberId).sort()).toEqual([empA.memberId, empB.memberId].sort());
    expect(m.totals.trackedSeconds).toBe(18000);
    await owner.api.get(`/api/v1/reports/time?${Q}&groupBy=app`).expect(400);
    await owner.api.get(`/api/v1/reports/nope?${Q}`).expect(400);
  });

  it('computes activity, apps by category, attendance, tasks, projects and employees reports', async () => {
    const act = (await owner.api.get(`/api/v1/reports/activity?${Q}&groupBy=day`).expect(200)).body.data;
    expect(act.totals.trackedSeconds).toBe(21600);
    // weighted: (50·7200 + 70·7200 + 40·3600 + 90·3600) / 21600 = 61.67
    expect(act.totals.activityPercent).toBeCloseTo(61.67, 1);

    const cat = (await owner.api.get(`/api/v1/reports/apps?${Q}&groupBy=category`).expect(200)).body.data;
    const c = Object.fromEntries(cat.rows.map((x) => [x.category, x.seconds]));
    expect(c).toMatchObject({ productive: 3600, unproductive: 1800, neutral: 1800 });
    expect(cat.totals.seconds).toBe(7200);

    const att = (await owner.api.get(`/api/v1/reports/attendance?${Q}&groupBy=member`).expect(200)).body.data;
    expect(att.totals).toMatchObject({ present: 2, late: 1, absent: 1 });

    const tasks = (await owner.api.get(`/api/v1/reports/tasks?${Q}`).expect(200)).body.data;
    expect(tasks.totals.tasks).toBe(1);
    expect(tasks.totals.actualHours).toBe(2);

    const proj = (await owner.api.get(`/api/v1/reports/projects?${Q}`).expect(200)).body.data;
    const pp1 = proj.rows.find((x) => x.project === 'P1');
    expect(pp1.trackedSeconds).toBe(10800);
    expect(pp1.budgetUsedPercent).toBe(100);
    expect(pp1.atRisk).toBe(true);

    const emp = (await manager.api.get(`/api/v1/reports/employees?${Q}`).expect(200)).body.data;
    expect(emp.rows.map((x) => x.memberId)).toEqual(expect.arrayContaining([empA.memberId, empB.memberId]));
    expect(emp.rows.some((x) => x.memberId === empC.memberId)).toBe(false);
    expect(emp.disclaimer).toBeTruthy();

    const detail = (await owner.api.get(`/api/v1/reports/projects/${p1}?${Q}`).expect(200)).body.data;
    expect(detail.contribution.find((x) => x.memberId === empA.memberId).contributionPercent).toBeCloseTo(66.7, 0);

    const ind = (await manager.api.get(`/api/v1/reports/employees/${empA.memberId}?${Q}`).expect(200)).body.data;
    expect(ind.hours.totals.trackedSeconds).toBe(14400);
    expect(ind.attendance.totals.late).toBe(1);
    await manager.api.get(`/api/v1/reports/employees/${empC.memberId}?${Q}`).expect(403);

    const cmp = (await owner.api.get(`/api/v1/reports/compare?${Q}&dimension=project&ids=${p1},${p2}`).expect(200)).body.data;
    expect(cmp.items).toHaveLength(2);
    expect(cmp.series).toHaveLength(2);
  });

  it('runs custom reports and exports PDF / Excel / CSV', async () => {
    const run = await owner.api
      .post('/api/v1/reports/run')
      .send({ reportType: 'time', from: '2026-11-02', to: '2026-11-03', groupBy: ['member'], metrics: ['trackedSeconds', 'cost'], filters: { projectIds: [p1] } })
      .expect(200);
    expect(run.body.data.columns.map((c) => c.key)).toEqual(['member', 'trackedSeconds', 'cost']);
    expect(run.body.data.totals.trackedSeconds).toBe(10800);
    await empA.api.post('/api/v1/reports/run').send({ reportType: 'time' }).expect(403); // reports.custom missing

    const definition = { reportType: 'time', from: '2026-11-02', to: '2026-11-03', groupBy: ['project'] };
    const pdf = await owner.api.post('/api/v1/reports/export').send({ definition, format: 'pdf' }).buffer(true).parse(binary).expect(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    const xlsx = await owner.api.post('/api/v1/reports/export').send({ definition, format: 'xlsx' }).buffer(true).parse(binary).expect(200);
    expect(xlsx.body.subarray(0, 2).toString()).toBe('PK');
    const csv = await owner.api.post('/api/v1/reports/export').send({ definition, format: 'csv' }).buffer(true).parse(binary).expect(200);
    const text = csv.body.toString('utf8');
    expect(text).toContain('Tracked (h)');
    expect(text).toContain('P1,3');
    expect(text).toMatch(/Total,6/);

    const before = t.outbox.length;
    await owner.api.post('/api/v1/reports/email').send({ definition, format: 'csv', recipients: ['boss@example.com'] }).expect(200);
    const mail = t.outbox.slice(before).find((m) => m.to === 'boss@example.com');
    expect(mail.attachments[0].filename).toMatch(/\.csv$/);
  });

  it('saves reports, schedules them and delivers due schedules by email', async () => {
    const saved = (await manager.api
      .post('/api/v1/saved-reports')
      .send({ name: 'Team hours', definition: { reportType: 'activity', groupBy: ['member'] } })
      .expect(201)).body.data;
    const list = (await manager.api.get('/api/v1/saved-reports').expect(200)).body.data;
    expect(list.map((x) => x.id)).toContain(saved.id);
    expect((await owner.api.get('/api/v1/saved-reports').expect(200)).body.data.map((x) => x.id)).not.toContain(saved.id);
    await manager.api.patch(`/api/v1/saved-reports/${saved.id}`).send({ isSharedInOrg: true }).expect(200);
    expect((await owner.api.get(`/api/v1/saved-reports/${saved.id}/run`).expect(200)).body.data.reportType).toBe('activity');

    await manager.api.post('/api/v1/report-schedules').send({ savedReportId: saved.id, frequency: 'weekly', recipients: ['x@example.com'] }).expect(400);
    const s = (await manager.api
      .post('/api/v1/report-schedules')
      .send({ savedReportId: saved.id, frequency: 'weekly', dayOfWeek: 1, timeOfDay: '07:30', timezone: 'Europe/Berlin', format: 'xlsx', recipients: ['team@example.com'] })
      .expect(201)).body.data;
    expect(new Date(s.nextRunAt) > new Date()).toBe(true);
    expect(new Date(s.nextRunAt).getUTCDay()).toBe(1);

    await db.query(`UPDATE report_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [s.id]);
    const before = t.outbox.length;
    await runCron('reports.scheduled');
    const mail = t.outbox.slice(before).find((m) => m.to === 'team@example.com');
    expect(mail).toBeTruthy();
    expect(mail.attachments[0].content.subarray(0, 2).toString()).toBe('PK');
    const after = (await manager.api.get(`/api/v1/report-schedules/${s.id}`).expect(200)).body.data;
    expect(after.lastRunAt).toBeTruthy();
    expect(new Date(after.nextRunAt) > new Date()).toBe(true);
    await manager.api.delete(`/api/v1/report-schedules/${s.id}`).expect(204);
    await manager.api.delete(`/api/v1/saved-reports/${saved.id}`).expect(204);
  });

  it('creates password-protected share links, enforces expiry and revocation', async () => {
    const definition = { reportType: 'time', from: '2026-11-02', to: '2026-11-03', groupBy: ['project'] };
    const share = (await manager.api
      .post('/api/v1/report-shares')
      .send({ definition, name: 'Client view', password: 'secret12', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
      .expect(201)).body.data;
    expect(share.token).toMatch(/^rs_/);
    expect(share.url).toContain(`/shared/reports/${share.token}`);
    const url = `/api/v1/public/reports/${share.token}`;
    expect((await request(t.app).get(url)).status).toBe(401);
    expect((await request(t.app).get(url).set('X-Share-Password', 'wrong')).status).toBe(401);
    const pub = await request(t.app).get(url).set('X-Share-Password', 'secret12').expect(200);
    expect(pub.body.data.organization.name).toBeTruthy();
    // manager scope: only team members' time (A + B) = 18000
    expect(pub.body.data.report.totals.trackedSeconds).toBe(18000);
    const listed = (await manager.api.get('/api/v1/report-shares').expect(200)).body.data.find((x) => x.id === share.id);
    expect(listed.viewCount).toBe(1);
    expect(listed.token).toBeUndefined();

    await db.query(`UPDATE report_shares SET expires_at = now() - interval '1 minute' WHERE id = $1`, [share.id]);
    expect((await request(t.app).get(url).set('X-Share-Password', 'secret12')).status).toBe(410);

    const s2 = (await owner.api.post('/api/v1/report-shares').send({ definition }).expect(201)).body.data;
    await request(t.app).get(`/api/v1/public/reports/${s2.token}`).expect(200);
    await owner.api.delete(`/api/v1/report-shares/${s2.id}`).expect(204);
    expect((await request(t.app).get(`/api/v1/public/reports/${s2.token}`)).status).toBe(410);
    expect((await request(t.app).get('/api/v1/public/reports/rs_doesnotexist000')).status).toBe(404);
    await empA.api.post('/api/v1/report-shares').send({ definition }).expect(403);
  });
});
