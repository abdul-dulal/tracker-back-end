import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';
import { runCron } from '../src/lib/jobs.js';

let t;
let owner;
let manager;
let emp;
let emp2;
let project;
let project2;

const iso = (d) => new Date(d).toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000);
/** Monday (UTC) of the previous week, as YYYY-MM-DD. */
function lastWeekMonday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow - 7);
  return d;
}
const at = (base, dayOffset, hour) => {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  manager = await addMember(t, owner, { role: 'manager' });
  emp = await addMember(t, owner, { role: 'employee' });
  emp2 = await addMember(t, owner, { role: 'employee' });
  project = await db.one(`INSERT INTO projects (organization_id, name, color) VALUES ($1, 'Website', '#ff0000') RETURNING *`, [owner.orgId]);
  project2 = await db.one(`INSERT INTO projects (organization_id, name, is_billable_default) VALUES ($1, 'Internal', false) RETURNING *`, [owner.orgId]);
  for (const m of [owner, manager, emp, emp2]) {
    await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2)', [project.id, m.memberId]);
    await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2)', [project2.id, m.memberId]);
  }
});

describe('timer endpoints (TIME-01…04, 10)', () => {
  it('start → current → pause → resume → stop, with switch', async () => {
    const s = await emp.api.post('/api/v1/timer/start').send({ projectId: project.id, note: 'coding', entryType: 'work' }).expect(201);
    expect(s.body.data.entry.status).toBe('running');
    expect(s.body.data).toHaveProperty('warning');
    const dup = await emp.api.post('/api/v1/timer/start').send({ projectId: project.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TIMER_ALREADY_RUNNING');
    const cur = await emp.api.get('/api/v1/timer/current').expect(200);
    expect(cur.body.data.entry.id).toBe(s.body.data.entry.id);
    await emp.api.post('/api/v1/timer/pause').expect(200);
    const paused = await emp.api.get('/api/v1/timer/current').expect(200);
    expect(paused.body.data.entry.pause.reason).toBe('manual');
    await emp.api.post('/api/v1/timer/resume').expect(200);
    const sw = await emp.api.post('/api/v1/timer/switch').send({ projectId: project2.id, note: 'meeting', entryType: 'meeting' }).expect(200);
    expect(sw.body.data.entry.project.id).toBe(project2.id);
    expect(sw.body.data.entry.entryType).toBe('meeting');
    const stop = await emp.api.post('/api/v1/timer/stop').send({ note: 'done' }).expect(200);
    expect(stop.body.data.entry.status).toBe('completed');
    expect(stop.body.data.entry.note).toBe('done');
    const none = await emp.api.post('/api/v1/timer/stop');
    expect(none.body.error.code).toBe('NO_RUNNING_TIMER');
    // timer.started / timer.stopped subscriptions → in-app notification, no email
    const n = await db.many(`SELECT type, channels_sent FROM notifications WHERE recipient_user_id = $1 AND type IN ('timer.started','timer.stopped')`, [emp.user.id]);
    expect(n.map((x) => x.type)).toEqual(expect.arrayContaining(['timer.started', 'timer.stopped']));
    expect(n.every((x) => !x.channels_sent.includes('email'))).toBe(true);
  });

  it('rejects projects the member is not assigned to', async () => {
    const secret = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Secret') RETURNING id`, [owner.orgId]);
    const res = await emp.api.post('/api/v1/timer/start').send({ projectId: secret.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ASSIGNED_TO_PROJECT');
  });
});

describe('manual entries & approval (TIME-06, 28, 29)', () => {
  let pendingId;
  it('employee manual entry is pending and approvers are notified', async () => {
    const res = await emp.api
      .post('/api/v1/time-entries')
      .send({ projectId: project.id, startedAt: iso(hoursAgo(30)), endedAt: iso(hoursAgo(29)), note: 'forgot timer' })
      .expect(201);
    const e = res.body.data.entry;
    expect(e.status).toBe('pending');
    expect(e.source).toBe('manual');
    expect(e.durationSeconds).toBe(3600);
    expect(e.client).toBeNull();
    pendingId = e.id;
    const n = await db.one(`SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND type = 'approval.requested'`, [owner.user.id]);
    expect(n.n).toBeGreaterThan(0);
  });

  it('validates time ranges and future times', async () => {
    const bad = await emp.api.post('/api/v1/time-entries').send({ startedAt: iso(hoursAgo(2)), endedAt: iso(hoursAgo(3)) });
    expect(bad.status).toBe(400);
    const future = await emp.api.post('/api/v1/time-entries').send({ startedAt: iso(hoursAgo(1)), endedAt: iso(Date.now() + 3600_000) });
    expect(future.status).toBe(400);
    expect(future.body.error.code).toBe('INVALID_TIME');
  });

  it('employee cannot create entries for others; overlap → 409 ENTRY_OVERLAP', async () => {
    const other = await emp.api.post('/api/v1/time-entries').send({ memberId: emp2.memberId, startedAt: iso(hoursAgo(50)), endedAt: iso(hoursAgo(49)) });
    expect(other.status).toBe(403);
    const ov = await emp.api.post('/api/v1/time-entries').send({ startedAt: iso(hoursAgo(29.5)), endedAt: iso(hoursAgo(28.5)) });
    expect(ov.status).toBe(409);
    expect(ov.body.error.code).toBe('ENTRY_OVERLAP');
  });

  it('owner manual entry for a member is auto-approved', async () => {
    const res = await owner.api
      .post('/api/v1/time-entries')
      .send({ memberId: emp2.memberId, projectId: project.id, startedAt: iso(hoursAgo(80)), endedAt: iso(hoursAgo(78)) })
      .expect(201);
    expect(res.body.data.entry.status).toBe('approved');
    expect(res.body.data.entry.memberId).toBe(emp2.memberId);
  });

  it('manager outside the team cannot approve; owner approves; employee notified', async () => {
    const denied = await manager.api.post(`/api/v1/time-entries/${pendingId}/approve`).send({});
    expect(denied.status).toBe(403);
    const okRes = await owner.api.post(`/api/v1/time-entries/${pendingId}/approve`).send({}).expect(200);
    expect(okRes.body.data.status).toBe('approved');
    expect(okRes.body.data.approvedBy).toBe(owner.memberId);
    const n = await db.one(`SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND type = 'approval.resolved'`, [emp.user.id]);
    expect(n.n).toBe(1);
    const emps = await emp.api.post(`/api/v1/time-entries/${pendingId}/approve`).send({});
    expect(emps.status).toBe(403);
  });

  it('reject requires a reason; bulk approve/reject report skipped ids', async () => {
    const a = await emp.api.post('/api/v1/time-entries').send({ startedAt: iso(hoursAgo(100)), endedAt: iso(hoursAgo(99)) }).expect(201);
    const b = await emp.api.post('/api/v1/time-entries').send({ startedAt: iso(hoursAgo(98)), endedAt: iso(hoursAgo(97)) }).expect(201);
    const noReason = await owner.api.post(`/api/v1/time-entries/${a.body.data.entry.id}/reject`).send({});
    expect(noReason.status).toBe(400);
    const rej = await owner.api.post(`/api/v1/time-entries/${a.body.data.entry.id}/reject`).send({ reason: 'not on schedule' }).expect(200);
    expect(rej.body.data.status).toBe('rejected');
    expect(rej.body.data.approvalReason).toBe('not on schedule');
    const bulk = await owner.api
      .post('/api/v1/time-entries/bulk-approve')
      .send({ ids: [a.body.data.entry.id, b.body.data.entry.id, '00000000-0000-4000-8000-000000000000'] })
      .expect(200);
    expect(bulk.body.data.approved).toEqual(expect.arrayContaining([a.body.data.entry.id, b.body.data.entry.id]));
    expect(bulk.body.data.skipped).toHaveLength(1);
    const bulkRej = await owner.api.post('/api/v1/time-entries/bulk-reject').send({ ids: [b.body.data.entry.id], reason: 'dup' }).expect(200);
    expect(bulkRej.body.data.rejected).toEqual([b.body.data.entry.id]);
  });
});

describe('editing, deleting & lock rule (TIME-25…27, 30)', () => {
  let entryId;
  beforeAll(async () => {
    const r = await owner.api
      .post('/api/v1/time-entries')
      .send({ memberId: emp.memberId, projectId: project.id, startedAt: iso(hoursAgo(200)), endedAt: iso(hoursAgo(199)), note: 'orig' })
      .expect(201);
    entryId = r.body.data.entry.id;
    await db.query(`UPDATE time_entries SET source = 'web_timer', status = 'completed' WHERE id = $1`, [entryId]);
  });

  it('employee edit/delete blocked by org setting', async () => {
    const res = await emp.api.patch(`/api/v1/time-entries/${entryId}`).send({ note: 'changed' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TIME_EDIT_NOT_ALLOWED');
    const del = await emp.api.delete(`/api/v1/time-entries/${entryId}`);
    expect(del.status).toBe(403);
  });

  it('employee edit allowed by setting returns entry to pending; history recorded', async () => {
    await db.query('UPDATE organization_settings SET allow_employee_edit_time = true WHERE organization_id = $1', [owner.orgId]);
    const res = await emp.api.patch(`/api/v1/time-entries/${entryId}`).send({ note: 'changed', endedAt: iso(hoursAgo(199.5)) }).expect(200);
    expect(res.body.data.note).toBe('changed');
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.durationSeconds).toBe(1800);
    const other = await emp.api.patch(`/api/v1/time-entries/${entryId}`).send({ projectId: project2.id }).expect(200);
    expect(other.body.data.project.id).toBe(project2.id);
    const h = await emp.api.get(`/api/v1/time-entries/${entryId}/history`).expect(200);
    expect(h.body.data.filter((x) => x.action === 'update')).toHaveLength(2);
    await db.query('UPDATE organization_settings SET allow_employee_edit_time = false WHERE organization_id = $1', [owner.orgId]);
  });

  it("editing someone else's entry requires editReason and is audited", async () => {
    const noReason = await owner.api.patch(`/api/v1/time-entries/${entryId}`).send({ note: 'x' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('EDIT_REASON_REQUIRED');
    await owner.api.patch(`/api/v1/time-entries/${entryId}`).send({ note: 'fixed', editReason: 'typo' }).expect(200);
    const a = await db.one(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'time_entry.updated' AND entity_id = $1`, [entryId]);
    expect(a.n).toBe(1);
    const nothing = await owner.api.patch(`/api/v1/time-entries/${entryId}`).send({ editReason: 'x' });
    expect(nothing.status).toBe(400);
  });

  it('running entries only allow note/project/task changes', async () => {
    const s = await emp2.api.post('/api/v1/timer/start').send({ projectId: project.id }).expect(201);
    const bad = await owner.api.patch(`/api/v1/time-entries/${s.body.data.entry.id}`).send({ startedAt: iso(hoursAgo(1)), editReason: 'x' });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('ENTRY_RUNNING');
    const good = await owner.api.patch(`/api/v1/time-entries/${s.body.data.entry.id}`).send({ note: 'live note', editReason: 'x' }).expect(200);
    expect(good.body.data.note).toBe('live note');
    expect(good.body.data.endedAt).toBeNull();
    await emp2.api.post('/api/v1/timer/stop').expect(200);
  });

  it('LOCK RULE: submitted timesheet → 409 TIMESHEET_LOCKED', async () => {
    const e = await db.one('SELECT started_at FROM time_entries WHERE id = $1', [entryId]);
    const day = (await db.one(`SELECT to_char(($1::timestamptz AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d`, [e.started_at])).d;
    const ts = await db.one(
      `INSERT INTO timesheets (organization_id, member_id, period_type, period_start, period_end, status) VALUES ($1,$2,'week',$3::date - 2,$3::date + 2,'submitted') RETURNING id`,
      [owner.orgId, emp.memberId, day],
    );
    const res = await owner.api.patch(`/api/v1/time-entries/${entryId}`).send({ note: 'late', editReason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TIMESHEET_LOCKED');
    const del = await owner.api.delete(`/api/v1/time-entries/${entryId}`);
    expect(del.status).toBe(409);
    await db.query(`UPDATE timesheets SET status = 'draft' WHERE id = $1`, [ts.id]);
    await owner.api.patch(`/api/v1/time-entries/${entryId}`).send({ note: 'late', editReason: 'x' }).expect(200);
    await db.query(`UPDATE timesheets SET locked_at = now() WHERE id = $1`, [ts.id]);
    expect((await owner.api.patch(`/api/v1/time-entries/${entryId}`).send({ note: 'again', editReason: 'x' })).status).toBe(409);
    await db.query(`DELETE FROM timesheets WHERE id = $1`, [ts.id]);
  });

  it('soft delete with audit; deleted entries disappear', async () => {
    await owner.api.delete(`/api/v1/time-entries/${entryId}`).send({ reason: 'duplicate' }).expect(204);
    expect((await owner.api.get(`/api/v1/time-entries/${entryId}`)).status).toBe(404);
    const row = await db.one('SELECT deleted_at FROM time_entries WHERE id = $1', [entryId]);
    expect(row.deleted_at).not.toBeNull();
    const a = await db.one(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'time_entry.deleted' AND entity_id = $1`, [entryId]);
    expect(a.n).toBe(1);
  });
});

describe('listing scope (TIME-24/25)', () => {
  it('employee sees only own entries and cannot list others', async () => {
    const own = await emp.api.get('/api/v1/time-entries?limit=100').expect(200);
    expect(own.body.data.length).toBeGreaterThan(0);
    expect(own.body.data.every((e) => e.memberId === emp.memberId)).toBe(true);
    expect(own.body.meta.totalSeconds).toBeGreaterThan(0);
    const other = await emp.api.get(`/api/v1/time-entries?memberId=${emp2.memberId}`);
    expect(other.status).toBe(403);
  });

  it('manager sees team members only after team membership', async () => {
    expect((await manager.api.get(`/api/v1/time-entries?memberId=${emp2.memberId}`)).status).toBe(403);
    const before = await manager.api.get('/api/v1/time-entries').expect(200);
    expect(before.body.data.every((e) => e.memberId === manager.memberId)).toBe(true);
    const team = await db.one(`INSERT INTO teams (organization_id, name) VALUES ($1, 'Alpha') RETURNING id`, [owner.orgId]);
    await db.query('INSERT INTO team_members (team_id, member_id) VALUES ($1,$2)', [team.id, emp2.memberId]);
    await db.query('INSERT INTO team_managers (team_id, member_id) VALUES ($1,$2)', [team.id, manager.memberId]);
    const after = await manager.api.get(`/api/v1/time-entries?memberId=${emp2.memberId}&status=approved`).expect(200);
    expect(after.body.data.length).toBeGreaterThan(0);
    expect(after.body.data[0].member.name).toBeTruthy();
    expect((await manager.api.get(`/api/v1/time-entries?memberId=${emp.memberId}`)).status).toBe(403);
  });

  it('filters by project, billable and local dates', async () => {
    const res = await owner.api.get(`/api/v1/time-entries?projectId=${project2.id}&isBillable=false`).expect(200);
    expect(res.body.data.every((e) => e.project?.id === project2.id && e.isBillable === false)).toBe(true);
    const future = await owner.api.get('/api/v1/time-entries?from=2099-01-01').expect(200);
    expect(future.body.data).toHaveLength(0);
    expect(future.body.meta.total).toBe(0);
  });
});

describe('summary & calendar (TIME-11…14, 32)', () => {
  let sm;
  let mon;
  beforeAll(async () => {
    sm = await addMember(t, owner, { role: 'employee' });
    mon = lastWeekMonday();
    // Mon–Thu 10h on Website, Fri 5h without project → 45h (expected 8h/day Mon–Fri = 40h)
    for (let d = 0; d < 4; d++)
      await owner.api.post('/api/v1/time-entries').send({ memberId: sm.memberId, projectId: project.id, startedAt: iso(at(mon, d, 8)), endedAt: iso(at(mon, d, 18)) }).expect(201);
    await owner.api.post('/api/v1/time-entries').send({ memberId: sm.memberId, startedAt: iso(at(mon, 4, 8)), endedAt: iso(at(mon, 4, 13)) }).expect(201);
  });

  it('weekly overtime (default mode weekly)', async () => {
    const date = iso(at(mon, 2, 0)).slice(0, 10);
    const res = await sm.api.get(`/api/v1/time/summary?period=week&date=${date}`).expect(200);
    const s = res.body.data;
    expect(s.from).toBe(iso(mon).slice(0, 10));
    expect(s.days).toHaveLength(7);
    expect(s.totals.trackedSeconds).toBe(45 * 3600);
    expect(s.totals.expectedSeconds).toBe(40 * 3600);
    expect(s.totals.overtime.dailySeconds).toBe(0);
    expect(s.totals.overtime.weeklySeconds).toBe(5 * 3600);
    const web = s.projects.find((p) => p.projectId === project.id);
    expect(web.seconds).toBe(40 * 3600);
    expect(web.name).toBe('Website');
    expect(s.projects.find((p) => p.projectId === null).seconds).toBe(5 * 3600);
  });

  it('both mode: weekly overtime applies after daily (no double counting)', async () => {
    await db.query(`UPDATE organization_settings SET overtime_mode = 'both' WHERE organization_id = $1`, [owner.orgId]);
    const date = iso(mon).slice(0, 10);
    const s = (await sm.api.get(`/api/v1/time/summary?period=week&date=${date}`).expect(200)).body.data;
    expect(s.totals.overtime.dailySeconds).toBe(8 * 3600);
    expect(s.totals.overtime.weeklySeconds).toBe(0);
    expect(s.days[0].overtimeSeconds).toBe(2 * 3600);
    // weekly_hours 30 → weekly = 45 − 8 − 30 = 7h
    await db.query('UPDATE organization_members SET weekly_hours = 30 WHERE id = $1', [sm.memberId]);
    const s2 = (await sm.api.get(`/api/v1/time/summary?period=week&date=${date}`).expect(200)).body.data;
    expect(s2.totals.overtime.weeklySeconds).toBe(7 * 3600);
    expect(s2.totals.overtime.totalSeconds).toBe(15 * 3600);
    await db.query(`UPDATE organization_settings SET overtime_mode = 'weekly' WHERE organization_id = $1`, [owner.orgId]);
  });

  it('day period, custom range & scope', async () => {
    const date = iso(at(mon, 4, 0)).slice(0, 10);
    const d = (await owner.api.get(`/api/v1/time/summary?memberId=${sm.memberId}&period=day&date=${date}`).expect(200)).body.data;
    expect(d.totals.trackedSeconds).toBe(5 * 3600);
    expect(d.days).toHaveLength(1);
    const c = (await owner.api.get(`/api/v1/time/summary?memberId=${sm.memberId}&from=${iso(mon).slice(0, 10)}&to=${iso(at(mon, 1, 0)).slice(0, 10)}`).expect(200)).body.data;
    expect(c.period).toBe('custom');
    expect(c.totals.trackedSeconds).toBe(20 * 3600);
    expect((await emp.api.get(`/api/v1/time/summary?memberId=${sm.memberId}`)).status).toBe(403);
  });

  it('calendar groups entries by local date with pauses', async () => {
    const res = await sm.api.get(`/api/v1/time/calendar?from=${iso(mon).slice(0, 10)}&to=${iso(at(mon, 6, 0)).slice(0, 10)}`).expect(200);
    const days = res.body.data.days;
    expect(days).toHaveLength(7);
    expect(days[0].entries).toHaveLength(1);
    expect(days[0].totalSeconds).toBe(10 * 3600);
    expect(days[0].entries[0].pauses).toEqual([]);
    expect(days[5].entries).toHaveLength(0);
  });
});

describe('jobs', () => {
  it('summaries.reconcile and alerts.overtime (once per day)', async () => {
    const m = await addMember(t, owner, { role: 'employee' });
    const ws = await db.one(
      `INSERT INTO work_schedules (organization_id, name, working_days, required_hours_per_day) VALUES ($1, 'Zero', '{0,1,2,3,4,5,6}', 0) RETURNING id`,
      [owner.orgId],
    );
    await db.query('UPDATE organization_members SET work_schedule_id = $2, weekly_hours = 0.01 WHERE id = $1', [m.memberId, ws.id]);
    await db.query(
      `INSERT INTO time_entries (organization_id, member_id, started_at, ended_at, duration_seconds, status, source)
       VALUES ($1,$2, now() - interval '10 minutes', now() - interval '1 minute', 540, 'completed', 'manual')`,
      [owner.orgId, m.memberId],
    );
    await runCron('summaries.reconcile');
    const sum = await db.one('SELECT sum(tracked_seconds)::int AS s FROM daily_summaries WHERE member_id = $1', [m.memberId]);
    expect(sum.s).toBeGreaterThan(0);
    await runCron('alerts.overtime');
    await runCron('alerts.overtime');
    const rows = await db.many(`SELECT data->>'period' AS period FROM notifications WHERE recipient_user_id = $1 AND type = 'overtime.alert'`, [m.user.id]);
    expect(rows.filter((r) => r.period === 'day')).toHaveLength(1);
    expect(rows.filter((r) => r.period === 'week')).toHaveLength(1);
    const ownerRows = await db.many(`SELECT 1 FROM notifications WHERE recipient_user_id = $1 AND type = 'overtime.alert' AND data->>'memberId' = $2`, [owner.user.id, m.memberId]);
    expect(ownerRows).toHaveLength(2);
  });
});
