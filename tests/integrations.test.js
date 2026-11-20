import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { setupApp, registerOrg, addMember, request, db } from './helpers.js';
import { publish } from '../src/lib/events.js';
import { drainJobs, runNow } from '../src/lib/jobs.js';

let t;
let owner;
let emp;
beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  emp = await addMember(t, owner, { role: 'employee' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResp = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const withKey = (key) => ({
  get: (u) => request(t.app).get(u).set('X-API-Key', key),
  post: (u) => request(t.app).post(u).set('X-API-Key', key),
  delete: (u) => request(t.app).delete(u).set('X-API-Key', key),
});

describe('API keys (INT-02, INT-04)', () => {
  it('creates a key shown once, authenticates with X-API-Key and enforces scopes', async () => {
    await emp.api.post('/api/v1/api-keys').send({ name: 'x', scopes: ['*'] }).expect(403);
    const bad = await owner.api.post('/api/v1/api-keys').send({ name: 'x', scopes: ['nope.perm'] });
    expect(bad.status).toBe(400);
    const res = await owner.api.post('/api/v1/api-keys').send({ name: 'Zapier', scopes: ['webhooks.manage'], expiresInDays: 30 }).expect(201);
    const { secret, id, prefix } = res.body.data;
    expect(secret).toMatch(/^trk_/);
    expect(secret.startsWith(prefix)).toBe(true);
    const list = await owner.api.get('/api/v1/api-keys').expect(200);
    expect(list.body.data[0]).not.toHaveProperty('secret');
    const stored = await db.one('SELECT key_hash FROM api_keys WHERE id = $1', [id]);
    expect(stored.key_hash).toBe(crypto.createHash('sha256').update(secret).digest('hex'));

    const k = withKey(secret);
    await k.get('/api/v1/webhooks').expect(200);
    await k.get('/api/v1/api-keys').expect(403); // not in scope
    await k.get('/api/v1/integrations').expect(403);
    const used = await db.one('SELECT last_used_at FROM api_keys WHERE id = $1', [id]);
    expect(used.last_used_at).toBeTruthy();

    await owner.api.delete(`/api/v1/api-keys/${id}`).expect(204);
    const revoked = await k.get('/api/v1/webhooks');
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('INVALID_API_KEY');
  });

  it('requires the api plan feature', async () => {
    const o2 = await registerOrg(t);
    await db.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'free'), status = 'active' WHERE organization_id = $1`, [o2.orgId]);
    const r = await o2.api.post('/api/v1/api-keys').send({ name: 'x', scopes: ['*'] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
  });
});

describe('Webhooks (INT-03)', () => {
  it('validates input and permissions', async () => {
    await emp.api.get('/api/v1/webhooks').expect(403);
    expect((await owner.api.post('/api/v1/webhooks').send({ url: 'http://example.com/x', events: ['timer.started'] })).status).toBe(400);
    expect((await owner.api.post('/api/v1/webhooks').send({ url: 'https://example.com/x', events: ['bogus'] })).status).toBe(400);
    await owner.api.post('/api/v1/webhooks').send({ url: 'http://localhost:9999/hook', events: ['timer.started'] }).expect(201);
  });

  it('delivers signed payloads on domain events; signature verifiable', async () => {
    const created = await owner.api.post('/api/v1/webhooks').send({ url: 'https://hooks.example.com/a', events: ['project.created'], description: 'test' }).expect(201);
    const { secret, id } = created.body.data;
    expect(secret).toMatch(/^whsec_/);
    const enc = await db.one('SELECT secret_enc FROM webhooks WHERE id = $1', [id]);
    expect(enc.secret_enc).not.toContain(secret);

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await publish('project.created', { orgId: owner.orgId, project: { id: crypto.randomUUID(), name: 'P1' } });
    await publish('project.created', { orgId: (await registerOrg(t)).orgId, project: { name: 'other org' } });
    await drainJobs();
    const calls = fetchMock.mock.calls.filter(([u]) => u === 'https://hooks.example.com/a');
    expect(calls.length).toBe(1);
    const [, init] = calls[0];
    expect(init.headers['X-Tracker-Event']).toBe('project.created');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ event: 'project.created', organizationId: owner.orgId, data: { project: { name: 'P1' } } });
    expect(init.headers['X-Tracker-Delivery']).toBe(body.id);
    const [, ts, v1] = init.headers['X-Tracker-Signature'].match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    expect(crypto.createHmac('sha256', secret).update(`${ts}.${init.body}`).digest('hex')).toBe(v1);

    const del = await owner.api.get(`/api/v1/webhooks/${id}/deliveries`).expect(200);
    expect(del.body.data[0]).toMatchObject({ status: 'success', attempts: 1, responseCode: 200 });
  });

  it('retries with exponential backoff, then fails; auto-disables after 20 consecutive failures', async () => {
    const created = await owner.api.post('/api/v1/webhooks').send({ url: 'https://fail.example.com/h', events: ['task.created'] }).expect(201);
    const id = created.body.data.id;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await publish('task.created', { orgId: owner.orgId, task: { title: 'T' } });
    await drainJobs();
    let d = await db.one('SELECT * FROM webhook_deliveries WHERE webhook_id = $1', [id]);
    expect(d.status).toBe('pending');
    expect(d.attempts).toBe(1);
    expect(new Date(d.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    const next = await db.one(`SELECT run_at FROM jobs WHERE name = 'webhooks.deliver' AND status = 'queued' AND payload->>'deliveryId' = $1`, [d.id]);
    expect(next).toBeTruthy();
    // second attempt → backoff doubles
    await runNow('webhooks.deliver', { deliveryId: d.id });
    const d2 = await db.one('SELECT * FROM webhook_deliveries WHERE id = $1', [d.id]);
    expect(d2.attempts).toBe(2);
    const gap1 = new Date(d.next_attempt_at) - new Date(d.created_at);
    const gap2 = new Date(d2.next_attempt_at) - Date.now();
    expect(gap2).toBeGreaterThan(gap1 * 1.5);
    // exhaust attempts
    for (let i = 0; i < 6; i++) await runNow('webhooks.deliver', { deliveryId: d.id });
    d = await db.one('SELECT * FROM webhook_deliveries WHERE id = $1', [d.id]);
    expect(d.status).toBe('failed');
    expect(d.attempts).toBe(8);
    expect(d.next_attempt_at).toBeNull();

    // manual retry succeeds → failure counter reset
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const retried = await owner.api.post(`/api/v1/webhooks/deliveries/${d.id}/retry`).expect(200);
    expect(retried.body.data.status).toBe('success');
    expect((await db.one('SELECT failure_count FROM webhooks WHERE id = $1', [id])).failure_count).toBe(0);

    // auto-disable
    await db.query('UPDATE webhooks SET failure_count = 19 WHERE id = $1', [id]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const test = await owner.api.post(`/api/v1/webhooks/${id}/test`).send({}).expect(200);
    expect(test.body.data.status).toBe('failed');
    const hook = await owner.api.get(`/api/v1/webhooks/${id}`).expect(200);
    expect(hook.body.data).toMatchObject({ active: false, failureCount: 20 });
    // re-enable resets the counter
    const re = await owner.api.patch(`/api/v1/webhooks/${id}`).send({ active: true }).expect(200);
    expect(re.body.data).toMatchObject({ active: true, failureCount: 0 });
    await owner.api.delete(`/api/v1/webhooks/${id}`).expect(204);
    await owner.api.get(`/api/v1/webhooks/${id}`).expect(404);
  });

  it('REST hooks subscribe/unsubscribe via API key (Zapier/n8n)', async () => {
    const key = (await owner.api.post('/api/v1/api-keys').send({ name: 'n8n', scopes: ['webhooks.manage'] }).expect(201)).body.data.secret;
    const k = withKey(key);
    const me = await k.get('/api/v1/hooks/me').expect(200);
    expect(me.body.data.organization.id).toBe(owner.orgId);
    const sample = await k.get('/api/v1/hooks/sample/timer.started').expect(200);
    expect(sample.body.data[0]).toMatchObject({ event: 'timer.started' });
    expect(sample.body.data[0].data.entry).toBeTruthy();
    await k.get('/api/v1/hooks/sample/nope.event').expect(400);
    const sub = await k.post('/api/v1/hooks/subscriptions').send({ targetUrl: 'https://hooks.zapier.com/x/1', event: 'timer.started', source: 'zapier' }).expect(201);
    const row = await db.one('SELECT source, events FROM webhooks WHERE id = $1', [sub.body.data.id]);
    expect(row).toMatchObject({ source: 'zapier', events: ['timer.started'] });
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await publish('timer.started', { orgId: owner.orgId, memberId: owner.memberId, entry: { id: 'e1' } });
    await drainJobs();
    expect(fetchMock.mock.calls.some(([u]) => u === 'https://hooks.zapier.com/x/1')).toBe(true);
    await k.delete(`/api/v1/hooks/subscriptions/${sub.body.data.id}`).expect(204);
    await k.delete(`/api/v1/hooks/subscriptions/${sub.body.data.id}`).expect(404);
  });
});

describe('Integrations (INT-08…19)', () => {
  it('lists the catalog and requires permission', async () => {
    await emp.api.get('/api/v1/integrations').expect(403);
    const res = await owner.api.get('/api/v1/integrations').expect(200);
    expect(res.body.data.map((p) => p.provider)).toEqual(expect.arrayContaining(['slack', 'ms_teams', 'jira', 'trello', 'asana', 'clickup', 'github', 'gitlab', 'google_calendar', 'outlook_calendar', 'quickbooks', 'xero', 'payroll_csv']));
    expect(res.body.data.every((p) => p.connected === false)).toBe(true);
  });

  it('Slack posts a message on a subscribed event', async () => {
    const bad = await owner.api.post('/api/v1/integrations/slack/connect').send({ settings: { webhookUrl: 'not-a-url' } });
    expect(bad.status).toBe(400);
    const url = 'https://hooks.slack.com/services/T000/B000/XXXX';
    const con = await owner.api.post('/api/v1/integrations/slack/connect').send({ settings: { webhookUrl: url, events: ['timer.started'] } }).expect(200);
    expect(con.body.data).toMatchObject({ connected: true, status: 'connected', hasCredentials: true });
    expect(JSON.stringify(con.body.data)).not.toContain('XXXX');
    const stored = await db.one(`SELECT access_token_enc FROM integrations WHERE organization_id = $1 AND provider = 'slack'`, [owner.orgId]);
    expect(stored.access_token_enc).not.toContain('hooks.slack.com');

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await publish('timer.started', { orgId: owner.orgId, memberId: owner.memberId, entry: { project: { name: 'Website' }, task: { title: 'Hero' } } });
    await publish('timer.stopped', { orgId: owner.orgId, memberId: owner.memberId, entry: {} }); // not subscribed
    await drainJobs();
    const slackCalls = fetchMock.mock.calls.filter(([u]) => u === url);
    expect(slackCalls.length).toBe(1);
    const body = JSON.parse(slackCalls[0][1].body);
    expect(body.text).toContain('Timer started');
    expect(body.text).toContain('Website');

    await owner.api.post('/api/v1/integrations/slack/test').expect(200);
    await owner.api.patch('/api/v1/integrations/slack').send({ settings: { events: ['task.completed'] } }).expect(200);
    const after = await owner.api.get('/api/v1/integrations').expect(200);
    expect(after.body.data.find((p) => p.provider === 'slack').settings.events).toEqual(['task.completed']);
    await owner.api.delete('/api/v1/integrations/slack').expect(204);
    await owner.api.post('/api/v1/integrations/slack/test').expect(404);
  });

  it('Jira connect validates credentials and import creates projects & tasks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResp({ message: 'unauthorized' }, 401)));
    const fail = await owner.api.post('/api/v1/integrations/jira/connect').send({ settings: { siteUrl: 'https://acme.atlassian.net', email: 'a@acme.com', apiToken: 'bad-token-123' } });
    expect(fail.status).toBe(502);
    expect(fail.body.error.code).toBe('INTEGRATION_AUTH_FAILED');

    const fetchMock = vi.fn(async (url, init) => {
      if (url.endsWith('/rest/api/3/myself')) return jsonResp({ displayName: 'Ann' });
      if (url.includes('/rest/api/3/project/search')) return jsonResp({ values: [{ id: '10000', key: 'WEB', name: 'Jira Web' }] });
      if (url.endsWith('/rest/api/3/search/jql')) {
        expect(JSON.parse(init.body).jql).toContain('WEB');
        return jsonResp({
          issues: [
            { id: '1', key: 'WEB-1', fields: { summary: 'Login page', duedate: '2026-12-01', priority: { name: 'High' }, status: { statusCategory: { key: 'new' } }, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Build it' }] }] } } },
            { id: '2', key: 'WEB-2', fields: { summary: 'Footer', status: { statusCategory: { key: 'done' } } } },
          ],
        });
      }
      if (url.includes('/worklog')) return jsonResp({ id: 'w1' }, 201);
      return jsonResp({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const con = await owner.api
      .post('/api/v1/integrations/jira/connect')
      .send({ settings: { siteUrl: 'https://acme.atlassian.net/', email: 'a@acme.com', apiToken: 'secret-token-123', pushWorklogs: true } })
      .expect(200);
    expect(con.body.data.settings).toMatchObject({ siteUrl: 'https://acme.atlassian.net', account: 'Ann' });
    expect(con.body.data.settings).not.toHaveProperty('apiToken');
    const auth = fetchMock.mock.calls[0][1].headers.Authorization;
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe('a@acme.com:secret-token-123');

    const sync = await owner.api.post('/api/v1/integrations/jira/sync').expect(200);
    expect(sync.body.data).toMatchObject({ projectsCreated: 1, tasksCreated: 2 });
    const tasks = await db.many(
      `SELECT t.title, t.due_date, t.priority, t.completed_at, t.description, c.category FROM tasks t JOIN projects p ON p.id = t.project_id
       LEFT JOIN board_columns c ON c.id = t.column_id WHERE p.organization_id = $1 AND p.name = 'Jira Web' ORDER BY t.title`,
      [owner.orgId],
    );
    expect(tasks.map((x) => x.title)).toEqual(['WEB-1 Login page', 'WEB-2 Footer']);
    expect(tasks[0]).toMatchObject({ due_date: '2026-12-01', priority: 'high', category: 'todo', description: 'Build it' });
    expect(tasks[1].completed_at).toBeTruthy();
    expect(tasks[1].category).toBe('done');
    // idempotent re-sync
    const again = await owner.api.post('/api/v1/integrations/jira/sync').expect(200);
    expect(again.body.data).toMatchObject({ projectsCreated: 0, projectsUpdated: 1, tasksCreated: 0, tasksUpdated: 2 });

    // worklog push for a linked task
    const task = await db.one(`SELECT t.id FROM tasks t WHERE t.title = 'WEB-1 Login page' AND t.organization_id = $1`, [owner.orgId]);
    await publish('timer.stopped', { orgId: owner.orgId, memberId: owner.memberId, entry: { task: { id: task.id }, durationSeconds: 1800, startedAt: new Date().toISOString() } });
    await drainJobs();
    const wl = fetchMock.mock.calls.find(([u]) => u.includes('/issue/1/worklog'));
    expect(JSON.parse(wl[1].body).timeSpentSeconds).toBe(1800);
  });

  it('OAuth-only modes return 501 when not configured', async () => {
    const r = await owner.api.post('/api/v1/integrations/google_calendar/connect').send({ settings: { mode: 'oauth' } });
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    await owner.api.post('/api/v1/integrations/google_calendar/connect').send({ settings: {} }).expect(200);
  });

  it('calendar feed (signed per-user token) includes due tasks and holidays', async () => {
    const proj = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Cal project') RETURNING id`, [owner.orgId]);
    const task = await db.one(`INSERT INTO tasks (organization_id, project_id, title, due_date) VALUES ($1,$2,'Ship v2', '2026-12-24') RETURNING id`, [owner.orgId, proj.id]);
    await db.query('INSERT INTO task_assignees (task_id, member_id) VALUES ($1,$2)', [task.id, emp.memberId]);
    await db.query(`INSERT INTO holidays (organization_id, name, date, recurring_yearly) VALUES ($1, 'New Year', '2027-01-01', true)`, [owner.orgId]);
    const u = await emp.api.get('/api/v1/integrations/calendar/feed-url').expect(200);
    const path = u.body.data.url.replace('http://localhost:4000', '');
    const feed = await request(t.app).get(path).expect(200);
    expect(feed.headers['content-type']).toContain('text/calendar');
    expect(feed.text).toContain('BEGIN:VCALENDAR');
    expect(feed.text).toContain('SUMMARY:Due: Ship v2');
    expect(feed.text).toContain('DTSTART;VALUE=DATE:20261224');
    expect(feed.text).toContain('SUMMARY:New Year');
    expect(feed.text).toContain('RRULE:FREQ=YEARLY');
    await request(t.app).get('/api/v1/integrations/calendar/feed.ics?token=00000000-0000-0000-0000-000000000000.forged').expect(401);
  });

  it('accounting invoices CSV and payroll CSV exports', async () => {
    const client = await db.one(`INSERT INTO clients (organization_id, name, email) VALUES ($1,'Acme','ap@acme.com') RETURNING id`, [owner.orgId]);
    const inv = await db.one(
      `INSERT INTO invoices (organization_id, client_id, number, status, issue_date, due_date, currency, subtotal, total)
       VALUES ($1,$2,'INV-0007','sent','2026-11-01','2026-11-15','USD',150,150) RETURNING id`,
      [owner.orgId, client.id],
    );
    await db.query(`INSERT INTO invoice_items (invoice_id, description, hours, rate, amount) VALUES ($1,'Design work',3,50,150)`, [inv.id]);
    await db.query(`INSERT INTO invoices (organization_id, client_id, number, status, currency) VALUES ($1,$2,'INV-0008','draft','USD')`, [owner.orgId, client.id]);
    const qb = await owner.api.get('/api/v1/integrations/accounting/invoices.csv?from=2026-11-01&to=2026-11-30').expect(200);
    expect(qb.headers['content-type']).toContain('text/csv');
    expect(qb.text.split('\n')[0]).toContain('InvoiceNo,Customer,InvoiceDate');
    expect(qb.text).toContain('INV-0007,Acme,11/01/2026,11/15/2026');
    expect(qb.text).not.toContain('INV-0008');
    const xero = await owner.api.get('/api/v1/integrations/accounting/invoices.csv?format=xero').expect(200);
    expect(xero.text.split('\n')[0]).toContain('*ContactName');
    expect(xero.text).toContain('Acme,ap@acme.com,INV-0007,2026-11-01');

    const run = await db.one(`INSERT INTO payroll_runs (organization_id, period_start, period_end, currency, status) VALUES ($1,'2026-10-01','2026-10-31','USD','finalized') RETURNING id`, [owner.orgId]);
    await db.query(
      `INSERT INTO payroll_items (payroll_run_id, member_id, regular_seconds, overtime_seconds, rate, regular_amount, total, currency) VALUES ($1,$2,36000,3600,20,200,230,'USD')`,
      [run.id, emp.memberId],
    );
    const pay = await owner.api.get(`/api/v1/integrations/payroll/${run.id}.csv`).expect(200);
    expect(pay.text.split('\n')[0]).toContain('EmployeeCode,FirstName,LastName,Email');
    expect(pay.text).toContain(emp.email);
    expect(pay.text).toContain('10.00,1.00');
    await emp.api.get(`/api/v1/integrations/payroll/${run.id}.csv`).expect(403);
    const other = await registerOrg(t);
    await other.api.get(`/api/v1/integrations/payroll/${run.id}.csv`).expect(404);
  });
});
