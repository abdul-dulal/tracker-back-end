import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, db } from './helpers.js';
import { startTimer, pauseTimer, resumeTimer, stopTimer, switchTimer, currentTimer } from '../src/modules/time/timer-service.js';
import { recomputeDailySummary } from '../src/modules/time/summary-service.js';

let t;
let o;
let ctx;
let project;
beforeAll(async () => {
  t = await setupApp();
  o = await registerOrg(t);
  ctx = { orgId: o.orgId, memberId: o.memberId, cache: new Map() };
  project = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Website') RETURNING *`, [o.orgId]);
  await db.query('INSERT INTO project_members (project_id, member_id) VALUES ($1,$2)', [project.id, o.memberId]);
});

describe('timer service', () => {
  it('start → pause → resume → stop computes net duration', async () => {
    const t0 = new Date(Date.now() - 3600_000);
    const s = await startTimer(ctx, { projectId: project.id, startedAt: t0 });
    expect(s.entry.status).toBe('running');
    await expect(startTimer(ctx, { projectId: project.id })).rejects.toMatchObject({ code: 'TIMER_ALREADY_RUNNING' });
    await pauseTimer(ctx, { at: new Date(t0.getTime() + 600_000) });
    await expect(pauseTimer(ctx)).rejects.toMatchObject({ code: 'TIMER_ALREADY_PAUSED' });
    await resumeTimer(ctx, { at: new Date(t0.getTime() + 900_000) });
    const stopped = await stopTimer(ctx, { at: new Date(t0.getTime() + 3600_000) });
    expect(stopped.entry.pausedSeconds).toBe(300);
    expect(stopped.entry.durationSeconds).toBe(3300);
    expect(stopped.entry.status).toBe('completed');
    expect(await currentTimer(o.memberId)).toBeNull();
    const sum = await db.one('SELECT tracked_seconds FROM daily_summaries WHERE member_id = $1 ORDER BY date DESC LIMIT 1', [o.memberId]);
    expect(sum.tracked_seconds).toBeGreaterThanOrEqual(3299);
    expect(t.emitted.some((e) => e.event === 'timer.stopped')).toBe(true);
  });

  it('rejects overlapping entries and switches tasks atomically', async () => {
    await startTimer(ctx, { projectId: project.id });
    const sw = await switchTimer(ctx, { projectId: project.id, note: 'next' });
    expect(sw.entry.note).toBe('next');
    const open = await db.many('SELECT id FROM time_entries WHERE member_id = $1 AND ended_at IS NULL', [o.memberId]);
    expect(open).toHaveLength(1);
    await stopTimer(ctx);
    await expect(
      db.query(`INSERT INTO time_entries (organization_id, member_id, started_at, ended_at, status) VALUES ($1,$2, now() - interval '30 minutes', now() - interval '20 minutes', 'completed')`, [o.orgId, o.memberId]),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('requires consent and project assignment', async () => {
    const other = await db.one(`INSERT INTO projects (organization_id, name) VALUES ($1, 'Secret') RETURNING id`, [o.orgId]);
    await expect(startTimer(ctx, { projectId: other.id })).rejects.toMatchObject({ code: 'NOT_ASSIGNED_TO_PROJECT' });
    await db.query('DELETE FROM consents WHERE member_id = $1', [o.memberId]);
    await expect(startTimer(ctx, { projectId: project.id })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await db.query(`INSERT INTO consents (organization_id, member_id, policy_version) VALUES ($1,$2,1)`, [o.orgId, o.memberId]);
  });

  it('weekly limit in block mode', async () => {
    await db.query(`UPDATE tracking_settings SET weekly_limit_hours = 0.01, limit_mode = 'block' WHERE organization_id = $1 AND scope_type = 'org'`, [o.orgId]);
    await expect(startTimer(ctx, { projectId: project.id })).rejects.toMatchObject({ code: 'WEEKLY_LIMIT_EXCEEDED' });
    await db.query(`UPDATE tracking_settings SET weekly_limit_hours = NULL, limit_mode = 'warn' WHERE organization_id = $1 AND scope_type = 'org'`, [o.orgId]);
  });

  it('daily summary includes activity, breaks and productivity', async () => {
    const day = (await db.one(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d`)).d;
    await db.query(
      `INSERT INTO activity_samples (organization_id, member_id, interval_start, interval_seconds, active_seconds, activity_percent)
       VALUES ($1,$2, date_trunc('hour', now()) - interval '1 hour', 600, 300, 50)`,
      [o.orgId, o.memberId],
    );
    await db.query(
      `INSERT INTO app_usage (organization_id, member_id, app_identifier, app_name, started_at, ended_at, duration_seconds)
       VALUES ($1,$2,'code.exe','Code', date_trunc('hour', now()) - interval '1 hour', date_trunc('hour', now()) - interval '50 minutes', 600)`,
      [o.orgId, o.memberId],
    );
    const s = await recomputeDailySummary(o.memberId, day);
    expect(s.activity_percent).toBe(50);
    expect(s.productive_seconds).toBe(600);
  });
});
