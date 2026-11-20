import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';
import { periodFor, getOrCreateTimesheet, addDays } from '../src/modules/timesheets/service.js';
import { runCron } from '../src/lib/jobs.js';

let t;
let owner;
let emp;
let leader;
let manager;
let outsider;
let team;
let project;
let current; // emp's current timesheet dto

const notifTypes = async (userId) => (await db.many('SELECT type FROM notifications WHERE recipient_user_id = $1', [userId])).map((r) => r.type);
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function addEntry(memberId, start, end, { billable = true, status = 'completed' } = {}) {
  const secs = (Date.parse(end) - Date.parse(start)) / 1000;
  return db.one(
    `INSERT INTO time_entries (organization_id, member_id, project_id, started_at, ended_at, duration_seconds, is_billable, status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual') RETURNING id`,
    [owner.orgId, memberId, project.id, start, end, secs, billable, status],
  );
}

beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  await db.query('UPDATE organization_settings SET timesheet_approval_levels = 2 WHERE organization_id = $1', [owner.orgId]);
  emp = await addMember(t, owner, { role: 'employee', firstName: 'Emma' });
  leader = await addMember(t, owner, { role: 'team_leader', firstName: 'Liam' });
  manager = await addMember(t, owner, { role: 'manager', firstName: 'Mia' });
  outsider = await addMember(t, owner, { role: 'manager', firstName: 'Otto' });
  team = await db.one(`INSERT INTO teams (organization_id, name) VALUES ($1, 'Alpha') RETURNING id`, [owner.orgId]);
  await db.query('INSERT INTO team_members (team_id, member_id, is_leader) VALUES ($1,$2,false), ($1,$3,true)', [team.id, emp.memberId, leader.memberId]);
  await db.query('INSERT INTO team_managers (team_id, member_id) VALUES ($1,$2)', [team.id, manager.memberId]);
  project = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Website') RETURNING id`, [owner.orgId]);
  await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2)', [project.id, emp.memberId]);
});

describe('periods', () => {
  it('aligns weeks to week_start, biweeks and months', () => {
    expect(periodFor('2026-11-19', 'week', 1)).toEqual({ type: 'week', start: '2026-11-16', end: '2026-11-22' });
    expect(periodFor('2026-11-19', 'week', 0)).toEqual({ type: 'week', start: '2026-11-15', end: '2026-11-21' });
    expect(periodFor('2026-11-15', 'week', 1).start).toBe('2026-11-09');
    expect(periodFor('2026-02-10', 'month')).toEqual({ type: 'month', start: '2026-02-01', end: '2026-02-28' });
    const b1 = periodFor('2026-11-19', 'biweek', 1);
    const b2 = periodFor(addDays(b1.end, 1), 'biweek', 1);
    expect(addDays(b1.start, 13)).toBe(b1.end);
    expect(b2.start).toBe(addDays(b1.end, 1));
    expect(periodFor(b1.end, 'biweek', 1).start).toBe(b1.start);
  });
});

describe('timesheet workflow', () => {
  it('creates the current timesheet with totals from entries (TS-01)', async () => {
    const first = await emp.api.get('/api/v1/timesheets/current').expect(200);
    const start = first.body.data.periodStart;
    await addEntry(emp.memberId, `${start}T09:00:00Z`, `${start}T11:00:00Z`);
    await addEntry(emp.memberId, `${start}T13:00:00Z`, `${start}T14:00:00Z`, { billable: false, status: 'pending' });
    await addEntry(emp.memberId, `${start}T15:00:00Z`, `${start}T16:00:00Z`, { status: 'rejected' });
    const res = await emp.api.get('/api/v1/timesheets/current').expect(200);
    current = res.body.data;
    expect(current.id).toBe(first.body.data.id);
    expect(current).toMatchObject({ status: 'draft', totalSeconds: 3 * 3600, billableSeconds: 2 * 3600, approvalLevels: 2, revision: 1 });
  });

  it('2-level approval with scope checks; entries approved on final approval (TS-11/12/15/16)', async () => {
    await leader.api.post(`/api/v1/timesheets/${current.id}/submit`).expect(403); // not own
    const sub = await emp.api.post(`/api/v1/timesheets/${current.id}/submit`).expect(200);
    expect(sub.body.data.status).toBe('submitted');
    expect(await notifTypes(leader.user.id)).toContain('timesheet.submitted');
    expect(await notifTypes(manager.user.id)).toContain('timesheet.submitted');
    await emp.api.post(`/api/v1/timesheets/${current.id}/submit`).expect(409);

    await emp.api.post(`/api/v1/timesheets/${current.id}/approve`).send({}).expect(403);
    await outsider.api.post(`/api/v1/timesheets/${current.id}/approve`).send({}).expect(403);

    const l1 = await leader.api.post(`/api/v1/timesheets/${current.id}/approve`).send({ comment: 'Looks good' }).expect(200);
    expect(l1.body.data).toMatchObject({ status: 'submitted', currentLevel: 2 });
    const dup = await leader.api.post(`/api/v1/timesheets/${current.id}/approve`).send({}).expect(409);
    expect(dup.body.error.code).toBe('ALREADY_APPROVED');

    const l2 = await manager.api.post(`/api/v1/timesheets/${current.id}/approve`).send({}).expect(200);
    expect(l2.body.data).toMatchObject({ status: 'approved', locked: true });
    expect(l2.body.data.lockedAt).toBeTruthy();
    const entries = await db.many('SELECT status, approved_by, timesheet_id FROM time_entries WHERE member_id = $1 ORDER BY started_at', [emp.memberId]);
    expect(entries.map((e) => e.status)).toEqual(['approved', 'approved', 'rejected']);
    expect(entries[0]).toMatchObject({ approved_by: manager.memberId, timesheet_id: current.id });
    expect(await notifTypes(emp.user.id)).toContain('timesheet.approved');

    const detail = await manager.api.get(`/api/v1/timesheets/${current.id}`).expect(200);
    expect(detail.body.data.approvals.map((a) => a.level)).toEqual([1, 2]);
    expect(detail.body.data.entries).toHaveLength(2);
    expect(detail.body.data.events.map((e) => e.toStatus)).toEqual(['draft', 'submitted', 'submitted', 'approved']);
  });

  it('reject → resubmit increments revision (TS-13/14/21)', async () => {
    const ts = await getOrCreateTimesheet(owner.orgId, emp.memberId, addDays(current.periodStart, -7));
    await emp.api.post(`/api/v1/timesheets/${ts.id}/submit`).expect(200);
    await leader.api.post(`/api/v1/timesheets/${ts.id}/reject`).send({}).expect(400);
    const rj = await leader.api.post(`/api/v1/timesheets/${ts.id}/reject`).send({ comment: 'Missing Friday' }).expect(200);
    expect(rj.body.data.status).toBe('rejected');
    expect(await notifTypes(emp.user.id)).toContain('timesheet.rejected');
    await manager.api.post(`/api/v1/timesheets/${ts.id}/approve`).send({}).expect(409);
    const re = await emp.api.post(`/api/v1/timesheets/${ts.id}/submit`).expect(200);
    expect(re.body.data).toMatchObject({ status: 'submitted', revision: 2, currentLevel: 1 });
    // the leader can approve again in the new revision
    await leader.api.post(`/api/v1/timesheets/${ts.id}/approve`).send({}).expect(200);
    const hist = await emp.api.get(`/api/v1/timesheets/${ts.id}/history`).expect(200);
    expect(hist.body.data.map((e) => e.toStatus)).toEqual(['draft', 'submitted', 'rejected', 'submitted', 'submitted']);
    expect(hist.body.data[2].comment).toBe('Missing Friday');
    const detail = await emp.api.get(`/api/v1/timesheets/${ts.id}`).expect(200);
    expect(detail.body.data.approvals).toHaveLength(1); // current revision only
  });

  it('bulk approve reports per-id results', async () => {
    const ts = await getOrCreateTimesheet(owner.orgId, emp.memberId, addDays(current.periodStart, -7));
    const res = await manager.api.post('/api/v1/timesheets/bulk-approve').send({ ids: [ts.id, current.id] }).expect(200);
    expect(res.body.data.approved.map((x) => x.id)).toEqual([ts.id]);
    expect(res.body.data.failed[0]).toMatchObject({ id: current.id, code: 'INVALID_STATUS' });
    await manager.api.post('/api/v1/timesheets/bulk-approve').send({ ids: [] }).expect(400);
  });

  it('lock / unlock (TS-16)', async () => {
    await manager.api.post(`/api/v1/timesheets/${current.id}/unlock`).expect(403);
    const un = await owner.api.post(`/api/v1/timesheets/${current.id}/unlock`).expect(200);
    expect(un.body.data).toMatchObject({ status: 'draft', lockedAt: null, editable: true });
    const statuses = (await db.many('SELECT status FROM time_entries WHERE member_id = $1 ORDER BY started_at', [emp.memberId])).map((e) => e.status);
    expect(statuses).toEqual(['completed', 'completed', 'rejected']);
    expect(await db.one(`SELECT 1 FROM audit_logs WHERE action = 'timesheet.unlocked' AND entity_id = $1`, [current.id])).toBeTruthy();
    const lk = await owner.api.post(`/api/v1/timesheets/${current.id}/lock`).expect(200);
    expect(lk.body.data.lockedAt).toBeTruthy();
    await owner.api.post(`/api/v1/timesheets/${current.id}/lock`).expect(409);
    await emp.api.post(`/api/v1/timesheets/${current.id}/submit`).expect(409);
    await owner.api.post(`/api/v1/timesheets/${current.id}/unlock`).expect(200);
  });

  it('comments (TS-17)', async () => {
    const c = await manager.api.post(`/api/v1/timesheets/${current.id}/comments`).send({ body: 'Please add notes' }).expect(201);
    expect(c.body.data.author.id).toBe(manager.memberId);
    const list = await emp.api.get(`/api/v1/timesheets/${current.id}/comments`).expect(200);
    expect(list.body.data).toHaveLength(1);
    await outsider.api.get(`/api/v1/timesheets/${current.id}/comments`).expect(403);
    await emp.api.post(`/api/v1/timesheets/${current.id}/comments`).send({ body: '' }).expect(400);
  });
});

describe('timesheet views & exports', () => {
  it('list and grid views with scope (TS-02…08)', async () => {
    const own = await emp.api.get('/api/v1/timesheets').expect(200);
    expect(own.body.data.every((x) => x.memberId === emp.memberId)).toBe(true);
    expect(own.body.meta.total).toBe(2);
    await emp.api.get('/api/v1/timesheets/current').expect(200);
    const mine = await leader.api.get('/api/v1/timesheets').expect(200);
    expect(mine.body.data.every((x) => [emp.memberId, leader.memberId].includes(x.memberId))).toBe(true);
    const out = await outsider.api.get(`/api/v1/timesheets?memberId=${emp.memberId}`).expect(200);
    expect(out.body.data).toHaveLength(0);
    await outsider.api.get(`/api/v1/timesheets/${current.id}`).expect(403);

    const wk = await emp.api.get(`/api/v1/timesheets/view?period=week&date=${current.periodStart}`).expect(200);
    expect(wk.body.data.days).toHaveLength(7);
    expect(wk.body.data.groupedBy).toBe('project_task');
    expect(wk.body.data.rows[0].project.name).toBe('Website');
    expect(wk.body.data.totalSeconds).toBe(3 * 3600);
    expect(wk.body.data.dayTotals[current.periodStart]).toBe(3 * 3600);
    expect(wk.body.data.timesheet.id).toBe(current.id);

    const day = await emp.api.get(`/api/v1/timesheets/view?period=day&date=${current.periodStart}`).expect(200);
    expect(day.body.data.days).toEqual([current.periodStart]);
    const month = await emp.api.get(`/api/v1/timesheets/view?period=month&date=${current.periodStart}`).expect(200);
    expect(month.body.data.days.length).toBeGreaterThanOrEqual(28);

    const tm = await manager.api.get(`/api/v1/timesheets/view?teamId=${team.id}&date=${current.periodStart}`).expect(200);
    expect(tm.body.data.groupedBy).toBe('member');
    expect(tm.body.data.rows.map((r) => r.member.id).sort()).toEqual([emp.memberId, leader.memberId].sort());
    const pj = await owner.api.get(`/api/v1/timesheets/view?projectId=${project.id}&date=${current.periodStart}`).expect(200);
    expect(pj.body.data.rows).toHaveLength(1);
    await emp.api.get(`/api/v1/timesheets/view?memberId=${leader.memberId}`).expect(403);
    await emp.api.get(`/api/v1/timesheets/view?memberId=${leader.memberId}&teamId=${team.id}`).expect(400);
  });

  it('exports pdf / xlsx / csv with correct headers (TS-18/19/20)', async () => {
    const csv = await emp.api.get(`/api/v1/timesheets/${current.id}/export?format=csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename=".*\.csv"/);
    expect(csv.text).toContain('Website');
    expect(csv.text).toContain('Emma');
    expect(csv.text).toMatch(/Total,.*3/);

    const xlsx = await manager.api.get(`/api/v1/timesheets/${current.id}/export?format=xlsx`).buffer(true).parse(binary).expect(200);
    expect(xlsx.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(xlsx.headers['content-disposition']).toMatch(/\.xlsx"/);
    expect(xlsx.body.subarray(0, 2).toString()).toBe('PK');

    const pdf = await owner.api.get(`/api/v1/timesheets/${current.id}/export?format=pdf`).buffer(true).parse(binary).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');

    await outsider.api.get(`/api/v1/timesheets/${current.id}/export?format=csv`).expect(403);
    await emp.api.get(`/api/v1/timesheets/${current.id}/export?format=doc`).expect(400);
  });

  it('organization isolation', async () => {
    const o2 = await registerOrg(t);
    await o2.api.get(`/api/v1/timesheets/${current.id}`).expect(404);
    await o2.api.post(`/api/v1/timesheets/${current.id}/approve`).send({}).expect(404);
  });
});

describe('timesheet jobs', () => {
  it('generates, reminds once and auto-locks', async () => {
    await runCron('timesheets.generate');
    const n = await db.one(`SELECT count(DISTINCT member_id)::int AS n FROM timesheets WHERE organization_id = $1`, [owner.orgId]);
    expect(n.n).toBe(5);

    const old = await getOrCreateTimesheet(owner.orgId, leader.memberId, '2026-01-07');
    await runCron('timesheets.reminders');
    const r1 = await db.one('SELECT reminder_sent_at FROM timesheets WHERE id = $1', [old.id]);
    expect(r1.reminder_sent_at).toBeTruthy();
    const count = async () => (await db.one(`SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND type = 'timesheet.reminder'`, [leader.user.id])).n;
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(1);
    await runCron('timesheets.reminders');
    expect(await count()).toBe(before);

    await db.query(`UPDATE timesheets SET status = 'submitted' WHERE id = $1`, [old.id]);
    await db.query('UPDATE organization_settings SET timesheet_lock_after_days = 3 WHERE organization_id = $1', [owner.orgId]);
    await runCron('timesheets.autolock');
    const locked = await db.one('SELECT locked_at FROM timesheets WHERE id = $1', [old.id]);
    expect(locked.locked_at).toBeTruthy();
    const ev = await db.one(`SELECT comment FROM timesheet_events WHERE timesheet_id = $1 ORDER BY created_at DESC LIMIT 1`, [old.id]);
    expect(ev.comment).toBe('Auto-locked');
  });
});
