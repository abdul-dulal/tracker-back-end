import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';

let t;
let owner;
let emp;
let emp2;
let tea;
let lunch;
let project;

beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  emp = await addMember(t, owner, { role: 'employee' });
  emp2 = await addMember(t, owner, { role: 'employee' });
  tea = await db.one(`SELECT * FROM break_types WHERE organization_id = $1 AND name = 'Tea Break'`, [owner.orgId]);
  lunch = await db.one(`SELECT * FROM break_types WHERE organization_id = $1 AND name = 'Lunch Break'`, [owner.orgId]);
  project = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Website') RETURNING *`, [owner.orgId]);
  await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2)', [project.id, emp.memberId]);
});

describe('breaks (BRK-01…08, TIME-17)', () => {
  it('break pauses the running timer and resumes it on end', async () => {
    const timer = await emp.api.post('/api/v1/timer/start').send({ projectId: project.id }).expect(201);
    const s = await emp.api.post('/api/v1/breaks/start').send({ breakTypeId: tea.id }).expect(201);
    expect(s.body.data.timerPaused).toBe(true);
    expect(s.body.data.break.isPaid).toBe(true);
    expect(s.body.data.break.timeEntryId).toBe(timer.body.data.entry.id);
    expect(s.body.data.entry.pause.reason).toBe('break');
    expect(s.body.data.entry.status).toBe('paused');
    const cur = await emp.api.get('/api/v1/breaks/current').expect(200);
    expect(cur.body.data.id).toBe(s.body.data.break.id);
    const tc = await emp.api.get('/api/v1/timer/current').expect(200);
    expect(tc.body.data.activeBreak.id).toBe(s.body.data.break.id);
    const dup = await emp.api.post('/api/v1/breaks/start').send({ breakTypeId: lunch.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('BREAK_ALREADY_ACTIVE');
    const end = await emp.api.post('/api/v1/breaks/end').send({}).expect(200);
    expect(end.body.data.timerResumed).toBe(true);
    expect(end.body.data.entry.status).toBe('running');
    expect(end.body.data.entry.pause).toBeNull();
    expect(end.body.data.break.endedAt).not.toBeNull();
    expect(end.body.data.break.exceeded).toBe(false);
    expect((await emp.api.get('/api/v1/breaks/current').expect(200)).body.data).toBeNull();
    expect(t.emitted.some((e) => e.event === 'break.ended')).toBe(true);
  });

  it('resumeTimer=false keeps the timer paused; a manual pause is not resumed by a break', async () => {
    await emp.api.post('/api/v1/breaks/start').send({ breakTypeId: lunch.id }).expect(201);
    const end = await emp.api.post('/api/v1/breaks/end').send({ resumeTimer: false }).expect(200);
    expect(end.body.data.timerResumed).toBe(false);
    expect(end.body.data.entry.pause.reason).toBe('break');
    await emp.api.post('/api/v1/timer/resume').expect(200);
    await emp.api.post('/api/v1/timer/pause').expect(200);
    const s = await emp.api.post('/api/v1/breaks/start').send({ breakTypeId: lunch.id }).expect(201);
    expect(s.body.data.timerPaused).toBe(false);
    const e2 = await emp.api.post('/api/v1/breaks/end').send({}).expect(200);
    expect(e2.body.data.timerResumed).toBe(false);
    expect(e2.body.data.entry.pause.reason).toBe('manual');
    await emp.api.post('/api/v1/timer/stop').expect(200);
  });

  it('breaks without a timer, exceeded flag, validation', async () => {
    const s = await emp2.api.post('/api/v1/breaks/start').send({ breakTypeId: tea.id }).expect(201);
    expect(s.body.data.timerPaused).toBe(false);
    expect(s.body.data.entry).toBeNull();
    await db.query(`UPDATE breaks SET started_at = now() - interval '20 minutes' WHERE id = $1`, [s.body.data.break.id]);
    const end = await emp2.api.post('/api/v1/breaks/end').send({}).expect(200);
    expect(end.body.data.break.exceeded).toBe(true);
    expect(end.body.data.break.durationSeconds).toBeGreaterThanOrEqual(1200);
    expect((await emp2.api.post('/api/v1/breaks/end').send({})).body.error.code).toBe('NO_ACTIVE_BREAK');
    const bad = await emp2.api.post('/api/v1/breaks/start').send({ breakTypeId: '00000000-0000-4000-8000-000000000000' });
    expect(bad.status).toBe(400);
    const other = await registerOrg(t);
    const foreign = await db.one(`SELECT id FROM break_types WHERE organization_id = $1 LIMIT 1`, [other.orgId]);
    expect((await emp2.api.post('/api/v1/breaks/start').send({ breakTypeId: foreign.id })).status).toBe(400);
    const arch = await db.one(`INSERT INTO break_types (organization_id, name, archived_at) VALUES ($1, 'Old', now()) RETURNING id`, [owner.orgId]);
    const a = await emp2.api.post('/api/v1/breaks/start').send({ breakTypeId: arch.id });
    expect(a.status).toBe(422);
    expect(a.body.error.code).toBe('BREAK_TYPE_ARCHIVED');
  });

  it('break history is scoped and break time lands in daily summaries', async () => {
    const own = await emp.api.get('/api/v1/breaks').expect(200);
    expect(own.body.data.length).toBe(3);
    expect(own.body.data.every((b) => b.memberId === emp.memberId)).toBe(true);
    expect(own.body.meta.total).toBe(3);
    expect((await emp.api.get(`/api/v1/breaks?memberId=${emp2.memberId}`)).status).toBe(403);
    const all = await owner.api.get('/api/v1/breaks?limit=50').expect(200);
    expect(all.body.data.length).toBe(4);
    expect(all.body.meta.exceededCount).toBe(1);
    const byMember = await owner.api.get(`/api/v1/breaks?memberId=${emp2.memberId}`).expect(200);
    expect(byMember.body.data[0].breakType.name).toBe('Tea Break');
    const sum = await db.one('SELECT sum(break_seconds)::int AS s FROM daily_summaries WHERE member_id = $1', [emp2.memberId]);
    expect(sum.s).toBeGreaterThanOrEqual(1200);
  });
});
