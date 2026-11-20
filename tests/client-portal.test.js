import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';

let t;
let o;
let emp;
let cu; // client user of client A
let cuB; // client user of client B
let clientA;
let clientB;
let pa; // visible project of A
let paHidden;
let pb;
let task;

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function entry(memberId, projectId, startIso, hours, { status = 'completed', billable = true, taskId = null } = {}) {
  const start = new Date(startIso);
  const secs = Math.round(hours * 3600);
  await db.query(
    `INSERT INTO time_entries (organization_id, member_id, project_id, task_id, started_at, ended_at, duration_seconds, active_seconds, is_billable, status, source)
     SELECT organization_id, id, $2, $3, $4, $5, $6, $7, $8, $9, 'manual' FROM organization_members WHERE id = $1`,
    [memberId, projectId, taskId, start, new Date(start.getTime() + secs * 1000), secs, Math.round(secs / 2), billable, status],
  );
}

async function setPerms(clientId, perms) {
  await db.query(`UPDATE clients SET portal_permissions = portal_permissions || $2::jsonb WHERE id = $1`, [clientId, JSON.stringify(perms)]);
}

beforeAll(async () => {
  t = await setupApp();
  o = await registerOrg(t);
  emp = await addMember(t, o, { role: 'employee', firstName: 'Ellie' });
  clientA = await db.one(`INSERT INTO clients (organization_id, name, email, hourly_rate) VALUES ($1,'Alpha Co','ap@alpha.test',50) RETURNING *`, [o.orgId]);
  clientB = await db.one(`INSERT INTO clients (organization_id, name, hourly_rate) VALUES ($1,'Beta Co',70) RETURNING *`, [o.orgId]);
  pa = await db.one(`INSERT INTO projects (organization_id, name, client_id, budget_type, budget_value, created_by) VALUES ($1,'Alpha App',$2,'hours',100,$3) RETURNING *`, [o.orgId, clientA.id, o.memberId]);
  paHidden = await db.one(`INSERT INTO projects (organization_id, name, client_id, client_visible) VALUES ($1,'Alpha Internal',$2,false) RETURNING *`, [o.orgId, clientA.id]);
  pb = await db.one(`INSERT INTO projects (organization_id, name, client_id) VALUES ($1,'Beta Site',$2) RETURNING *`, [o.orgId, clientB.id]);
  await db.query(`INSERT INTO project_members (project_id, member_id, role, billable_rate) VALUES ($1,$2,'member',60),($1,$3,'manager',NULL)`, [pa.id, emp.memberId, o.memberId]);
  task = await db.one(`INSERT INTO tasks (organization_id, project_id, title, due_date) VALUES ($1,$2,'Build login','2026-11-30') RETURNING *`, [o.orgId, pa.id]);
  await db.query(`INSERT INTO tasks (organization_id, project_id, title, completed_at) VALUES ($1,$2,'Design',now())`, [o.orgId, pa.id]);

  await entry(emp.memberId, pa.id, '2026-11-02T09:00:00Z', 3, { taskId: task.id });
  await entry(emp.memberId, pa.id, '2026-11-03T09:00:00Z', 1, { billable: false });
  await entry(emp.memberId, pa.id, '2026-11-04T09:00:00Z', 5, { status: 'pending' }); // not shown
  await entry(o.memberId, pa.id, '2026-11-02T09:00:00Z', 2);
  await entry(emp.memberId, paHidden.id, '2026-11-05T09:00:00Z', 4);
  await entry(emp.memberId, pb.id, '2026-11-06T09:00:00Z', 6);

  cu = await addMember(t, o, { role: 'client', firstName: 'Carl' });
  await db.query(`UPDATE organization_members SET client_id = $2 WHERE id = $1`, [cu.memberId, clientA.id]);
  cuB = await addMember(t, o, { role: 'client', firstName: 'Bea' });
  await db.query(`UPDATE organization_members SET client_id = $2 WHERE id = $1`, [cuB.memberId, clientB.id]);
});

describe('client portal access (CLI-05, CLI-14)', () => {
  it('only lists client-visible projects of the own client', async () => {
    const res = await cu.api.get('/api/v1/client-portal/projects').expect(200);
    expect(res.body.data.map((p) => p.id)).toEqual([pa.id]);
    expect(res.body.data[0]).toMatchObject({ totalHours: 6, billableHours: 5 });
    expect(res.body.data[0].budget).toMatchObject({ type: 'hours', value: 100, used: 6 });
    expect(res.body.data[0].progress).toMatchObject({ percent: 50, tasksTotal: 2, tasksDone: 1 });
    await cu.api.get(`/api/v1/client-portal/projects/${paHidden.id}`).expect(404);
    await cu.api.get(`/api/v1/client-portal/projects/${pb.id}`).expect(404);
    await cu.api.get(`/api/v1/client-portal/projects/${pb.id}/time`).expect(404);
    await cu.api.get(`/api/v1/client-portal/projects/${pb.id}/comments`).expect(404);
    const b = await cuB.api.get('/api/v1/client-portal/projects').expect(200);
    expect(b.body.data.map((p) => p.id)).toEqual([pb.id]);
  });

  it('is client-only and read-only elsewhere', async () => {
    await emp.api.get('/api/v1/client-portal/dashboard').expect(403);
    await o.api.get('/api/v1/client-portal/projects').expect(403);
    await cu.api.get('/api/v1/invoices').expect(403);
    await cu.api.get('/api/v1/billing/summary').expect(403);
    await cu.api.post('/api/v1/payroll/runs').send({ periodStart: '2026-11-01', periodEnd: '2026-11-30' }).expect(403);
    const unlinked = await addMember(t, o, { role: 'client' });
    const r = await unlinked.api.get('/api/v1/client-portal/projects');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CLIENT_NOT_LINKED');
  });
});

describe('permission filtering (CLI-07, CLI-08, CLI-18)', () => {
  it('hides member names and rates according to portal_permissions', async () => {
    await setPerms(clientA.id, { showMemberNames: false, showRates: false, showActivity: false, showScreenshots: false });
    const d = await cu.api.get(`/api/v1/client-portal/projects/${pa.id}`).expect(200);
    expect(d.body.data.team.map((m) => m.name).sort()).toEqual(['Team member 1', 'Team member 2']);
    expect(d.body.data.team[0].memberId).toBeUndefined();
    expect(d.body.data.billableAmount).toBeUndefined();
    expect(d.body.data.hourlyRate).toBeUndefined();
    expect(d.body.data.activityPercent).toBeUndefined();
    expect(d.body.data.recentScreenshots).toBeUndefined();
    expect(JSON.stringify(d.body.data)).not.toMatch(/Ellie|Olivia/);

    const tm = await cu.api.get(`/api/v1/client-portal/projects/${pa.id}/time?from=2026-11-01&to=2026-11-30&groupBy=member`).expect(200);
    expect(tm.body.data.totals).toEqual({ totalHours: 6, billableHours: 5 });
    expect(tm.body.data.items.every((i) => /^Team member \d$/.test(i.member) && i.billableAmount === undefined)).toBe(true);
    const tasks = await cu.api.get(`/api/v1/client-portal/projects/${pa.id}/tasks`).expect(200);
    expect(tasks.body.data.find((x) => x.id === task.id)).toMatchObject({ trackedHours: 3, status: 'todo' });
  });

  it('shows names, rates, activity and screenshots when allowed', async () => {
    await setPerms(clientA.id, { showMemberNames: true, showRates: true, showActivity: true, showScreenshots: true });
    await db.query(
      `INSERT INTO screenshots (organization_id, member_id, project_id, captured_at, object_key, thumb_key) VALUES ($1,$2,$3,now(),'org/x/shot.png','org/x/thumb.png')`,
      [o.orgId, emp.memberId, pa.id],
    );
    const d = await cu.api.get(`/api/v1/client-portal/projects/${pa.id}`).expect(200);
    expect(d.body.data.team.map((m) => m.name)).toContain('Ellie Test');
    expect(d.body.data.billableAmount).toBe(280); // 3h × 60 (member override) + 2h × 50 (client rate)
    expect(d.body.data.activityPercent).toBe(50);
    expect(d.body.data.recentScreenshots[0].thumbnailUrl).toMatch(/thumb\.png\?/);
    const tm = await cu.api.get(`/api/v1/client-portal/projects/${pa.id}/time?from=2026-11-01&to=2026-11-30&groupBy=day`).expect(200);
    expect(tm.body.data.items.find((i) => i.date === '2026-11-02')).toMatchObject({ totalHours: 5, billableAmount: 280, activityPercent: 50 });
    const byTask = await cu.api.get(`/api/v1/client-portal/projects/${pa.id}/time?from=2026-11-01&to=2026-11-30&groupBy=task`).expect(200);
    expect(byTask.body.data.items.find((i) => i.taskId === task.id).totalHours).toBe(3);
    await cu.api.get(`/api/v1/client-portal/projects/${pa.id}/time?groupBy=week`).expect(400);
  });
});

describe('timesheets, reports, comments, notifications (CLI-12, 13, 15, 16)', () => {
  it('shows approved timesheets limited to the project hours', async () => {
    await db.query(
      `INSERT INTO timesheets (organization_id, member_id, period_type, period_start, period_end, status, approved_at) VALUES
       ($1,$2,'week','2026-11-02','2026-11-08','approved',now()), ($1,$3,'week','2026-11-02','2026-11-08','submitted',NULL)`,
      [o.orgId, emp.memberId, o.memberId],
    );
    const r = await cu.api.get(`/api/v1/client-portal/projects/${pa.id}/timesheets`).expect(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ member: 'Ellie Test', projectHours: 4, billableHours: 3 }); // pending, hidden & other-client time excluded
    const rb = await cuB.api.get(`/api/v1/client-portal/projects/${pb.id}/timesheets`).expect(200);
    expect(rb.body.data[0].projectHours).toBe(6);
  });

  it('lists only valid report shares of the own client', async () => {
    await db.query(
      `INSERT INTO report_shares (organization_id, name, definition_snapshot, token_hash, client_id, expires_at, revoked_at) VALUES
       ($1,'Monthly','{"type":"time"}','h1',$2,NULL,NULL), ($1,'Expired','{}','h2',$2,now() - interval '1 day',NULL),
       ($1,'Revoked','{}','h3',$2,NULL,now()), ($1,'Other client','{}','h4',$3,NULL,NULL)`,
      [o.orgId, clientA.id, clientB.id],
    );
    const r = await cu.api.get('/api/v1/client-portal/reports').expect(200);
    expect(r.body.data.map((x) => x.name)).toEqual(['Monthly']);
  });

  it('posts client-visible comments and notifies project managers', async () => {
    await db.query(`INSERT INTO comments (organization_id, entity_type, entity_id, author_member_id, body, visibility) VALUES ($1,'project',$2,$3,'internal note','internal')`, [o.orgId, pa.id, o.memberId]);
    await db.query(`INSERT INTO comments (organization_id, entity_type, entity_id, author_member_id, body, visibility) VALUES ($1,'task',$2,$3,'progress update','client')`, [o.orgId, task.id, emp.memberId]);
    const c = await cu.api.post(`/api/v1/client-portal/projects/${pa.id}/comments`).send({ body: 'Looks great!' }).expect(201);
    expect(c.body.data).toMatchObject({ body: 'Looks great!', authorIsClient: true, isMine: true, entityType: 'project' });
    await cu.api.post(`/api/v1/client-portal/projects/${pa.id}/comments`).send({ body: 'On task', taskId: task.id }).expect(201);
    await cu.api.post(`/api/v1/client-portal/projects/${pa.id}/comments`).send({ body: '' }).expect(400);
    await cu.api.post(`/api/v1/client-portal/projects/${pb.id}/comments`).send({ body: 'sneaky' }).expect(404);
    const list = await cu.api.get(`/api/v1/client-portal/projects/${pa.id}/comments`).expect(200);
    expect(list.body.data.map((x) => x.body).sort()).toEqual(['Looks great!', 'On task', 'progress update']);
    const n = await db.many(`SELECT n.type, n.title FROM notifications n WHERE n.recipient_user_id = $1 AND n.type = 'task.comment'`, [o.user.id]);
    expect(n.length).toBe(2);
    const bView = await cuB.api.get(`/api/v1/client-portal/projects/${pb.id}/comments`).expect(200);
    expect(bView.body.data).toHaveLength(0);
  });

  it('updates the own profile only', async () => {
    const p = await cu.api.patch('/api/v1/client-portal/profile').send({ firstName: 'Carlos', client: { phone: '+1 555' } }).expect(200);
    expect(p.body.data.user.firstName).toBe('Carlos');
    expect(p.body.data.client.phone).toBe('+1 555');
    await cu.api.patch('/api/v1/client-portal/profile').send({ client: { hourlyRate: 1 } }).expect(400);
    await cu.api.patch('/api/v1/client-portal/profile').send({ email: 'x@y.z' }).expect(400);
    const g = await cu.api.get('/api/v1/client-portal/profile').expect(200);
    expect(g.body.data.client.name).toBe('Alpha Co');
  });
});

describe('invoices in the portal (CLI-17)', () => {
  it('lists own non-draft invoices, serves PDFs and notifies on send', async () => {
    const draft = await o.api.post('/api/v1/invoices').send({ clientId: clientA.id, items: [{ description: 'Draft work', amount: 10 }] }).expect(201);
    const gen = await o.api.post('/api/v1/invoices/generate').send({ clientId: clientA.id, from: '2026-11-01', to: '2026-11-30' }).expect(201);
    expect(gen.body.data.total).toBe(480); // includes the hidden project's 4h × 50
    await o.api.post(`/api/v1/invoices/${gen.body.data.id}/send`).expect(200);
    const bInv = await o.api.post('/api/v1/invoices').send({ clientId: clientB.id, items: [{ description: 'B work', amount: 99 }] }).expect(201);
    await o.api.post(`/api/v1/invoices/${bInv.body.data.id}/send`).expect(200);

    const list = await cu.api.get('/api/v1/client-portal/invoices').expect(200);
    expect(list.body.data.map((i) => i.id)).toEqual([gen.body.data.id]);
    expect(list.body.data[0]).toMatchObject({ total: 480, balance: 480, status: 'sent' });
    expect(list.body.data[0].items).toBeUndefined();
    const pdf = await cu.api.get(`/api/v1/client-portal/invoices/${gen.body.data.id}/pdf`).buffer(true).parse(binary).expect(200);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    await cu.api.get(`/api/v1/client-portal/invoices/${draft.body.data.id}/pdf`).expect(404);
    await cu.api.get(`/api/v1/client-portal/invoices/${bInv.body.data.id}/pdf`).expect(404);

    expect(t.outbox.some((m) => m.to === cu.email && m.attachments?.length)).toBe(true);
    const notes = await cu.api.get('/api/v1/client-portal/notifications?unread=true').expect(200);
    expect(notes.body.data.some((x) => x.type === 'invoice.sent')).toBe(true);
    const notesB = await cuB.api.get('/api/v1/client-portal/notifications').expect(200);
    expect(notesB.body.data.every((x) => x.data?.invoiceId !== gen.body.data.id)).toBe(true);

    const dash = await cu.api.get('/api/v1/client-portal/dashboard').expect(200);
    expect(dash.body.data.projects.total).toBe(1);
    expect(dash.body.data.hours).toMatchObject({ total: 6, billable: 5 });
    expect(dash.body.data.invoices.outstanding).toEqual([{ currency: 'USD', amount: 480 }]);
    expect(dash.body.data.invoices.recent.map((i) => i.id)).toEqual([gen.body.data.id]);
  });

  it('is gated by the clientPortal plan feature', async () => {
    await db.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'free') WHERE organization_id = $1`, [o.orgId]);
    const r = await cu.api.get('/api/v1/client-portal/dashboard');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
  });
});
