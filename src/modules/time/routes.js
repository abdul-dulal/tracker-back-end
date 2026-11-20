import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created } from '../../lib/http.js';
import { startTimer, pauseTimer, resumeTimer, stopTimer, switchTimer, currentTimer } from './timer-service.js';

/** Web timer (TIME-01…04, TIME-10, TIME-23). Shares server state with the desktop agent via timer-service. */
const r = createRouter('/timer', 'Timer');

const startBody = z.object({
  projectId: z.uuid().nullish(),
  taskId: z.uuid().nullish(),
  note: z.string().trim().max(2000).nullish(),
  entryType: z.enum(['work', 'meeting']).default('work'),
  isBillable: z.boolean().optional(),
});

r.get('/current', { summary: 'Current running/paused timer', ids: 'TIME-10, TIME-23', permission: 'timer.use' }, async (req, res) => {
  const entry = await currentTimer(req.ctx.memberId);
  const brk = await db.one(
    `SELECT b.id, b.started_at, b.break_type_id, bt.name, bt.max_minutes, b.is_paid FROM breaks b JOIN break_types bt ON bt.id = b.break_type_id
     WHERE b.member_id = $1 AND b.ended_at IS NULL`,
    [req.ctx.memberId],
  );
  ok(res, {
    entry,
    activeBreak: brk ? { id: brk.id, breakTypeId: brk.break_type_id, name: brk.name, startedAt: brk.started_at, maxMinutes: brk.max_minutes, isPaid: brk.is_paid } : null,
    serverNow: new Date().toISOString(),
  });
});

r.post('/start', { summary: 'Start timer', ids: 'TIME-01', permission: 'timer.use', body: startBody }, async (req, res) => {
  const b = req.body;
  const result = await startTimer(req.ctx, {
    projectId: b.projectId ?? undefined,
    taskId: b.taskId ?? undefined,
    note: b.note ?? undefined,
    entryType: b.entryType,
    isBillable: b.isBillable,
    source: 'web_timer',
  });
  created(res, { entry: result.entry, warning: result.warning ?? null });
});

r.post('/pause', { summary: 'Pause timer', ids: 'TIME-03', permission: 'timer.use' }, async (req, res) => {
  const result = await pauseTimer(req.ctx, { reason: 'manual' });
  ok(res, { entry: result.entry, warning: null });
});

r.post('/resume', { summary: 'Resume timer', ids: 'TIME-04', permission: 'timer.use' }, async (req, res) => {
  const result = await resumeTimer(req.ctx);
  ok(res, { entry: result.entry, warning: null });
});

r.post(
  '/stop',
  { summary: 'Stop timer', ids: 'TIME-02', permission: 'timer.use', body: z.object({ note: z.string().trim().max(2000).nullish() }) },
  async (req, res) => {
    const result = await stopTimer(req.ctx, { note: req.body.note ?? undefined });
    ok(res, { entry: result.entry, warning: null });
  },
);

r.post('/switch', { summary: 'Stop current timer and start a new one atomically', ids: 'TIME-07, TIME-08', permission: 'timer.use', body: startBody }, async (req, res) => {
  const b = req.body;
  const result = await switchTimer(req.ctx, {
    projectId: b.projectId ?? undefined,
    taskId: b.taskId ?? undefined,
    note: b.note ?? undefined,
    entryType: b.entryType,
    isBillable: b.isBillable,
    source: 'web_timer',
  });
  ok(res, { entry: result.entry, warning: result.warning ?? null });
});

export default r;
