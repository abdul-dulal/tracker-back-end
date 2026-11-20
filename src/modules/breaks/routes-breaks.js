import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, paginationQuery, pageMeta, pageClause, where, dateStr } from '../../lib/http.js';
import { scopeMembers, assertMemberAccess } from '../../rbac/scope.js';
import { BREAK_SELECT, breakDto, getOpenBreak, startBreak, endBreak } from './service.js';

/** Break control & history (BRK-01…08, TIME-17). /break-types CRUD lives in another module. */
const r = createRouter('/breaks', 'Breaks');

r.get('/current', { summary: 'Current open break', ids: 'BRK-01, BRK-08', permission: 'breaks.use' }, async (req, res) => {
  ok(res, breakDto(await getOpenBreak(req.ctx.memberId)));
});

r.post('/start', { summary: 'Start a break (pauses the running timer)', ids: 'BRK-01, BRK-03, BRK-04', permission: 'breaks.use', body: z.object({ breakTypeId: z.uuid() }) }, async (req, res) => {
  created(res, await startBreak(req.ctx, { breakTypeId: req.body.breakTypeId }));
});

r.post(
  '/end',
  { summary: 'End the current break (optionally resumes the timer)', ids: 'BRK-02, BRK-08', permission: 'breaks.use', body: z.object({ resumeTimer: z.boolean().default(true) }) },
  async (req, res) => {
    ok(res, await endBreak(req.ctx, { resumeTimer: req.body.resumeTimer }));
  },
);

const LOCAL_DATE = `((b.started_at AT TIME ZONE coalesce(m.timezone, o.timezone, 'UTC'))::date)`;

r.get(
  '/',
  {
    summary: 'Break history',
    ids: 'BRK-08, TIME-17',
    permission: 'time.view',
    query: paginationQuery.extend({ memberId: z.uuid().optional(), from: dateStr.optional(), to: dateStr.optional(), breakTypeId: z.uuid().optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    if (q.memberId) await assertMemberAccess(ctx, 'time.view', q.memberId);
    const w = where();
    w.add('b.organization_id = ?', ctx.orgId);
    await scopeMembers(ctx, 'time.view', w, 'b.member_id');
    w.add('b.member_id = ?', q.memberId);
    w.add('b.break_type_id = ?', q.breakTypeId);
    w.add(`${LOCAL_DATE} >= ?::date`, q.from);
    w.add(`${LOCAL_DATE} <= ?::date`, q.to);
    const from = `FROM breaks b JOIN organization_members m ON m.id = b.member_id JOIN organizations o ON o.id = b.organization_id`;
    const agg = await db.one(
      `SELECT count(*)::int AS total, coalesce(sum(b.duration_seconds), 0)::int AS total_seconds,
              coalesce(sum(CASE WHEN b.is_paid THEN b.duration_seconds ELSE 0 END), 0)::int AS paid_seconds,
              count(*) FILTER (WHERE b.exceeded)::int AS exceeded_count
       ${from} ${w.sql}`,
      w.params,
    );
    const pc = pageClause(q, { startedAt: 'b.started_at', duration: 'b.duration_seconds' }, 'startedAt');
    const ids = (await db.many(`SELECT b.id ${from} ${w.sql} ${pc.orderBy} LIMIT ${pc.limit} OFFSET ${pc.offset}`, w.params)).map((x) => x.id);
    const rows = ids.length ? await db.many(`${BREAK_SELECT} WHERE b.id = ANY($1::uuid[])`, [ids]) : [];
    const byId = new Map(rows.map((b) => [b.id, b]));
    ok(
      res,
      ids.map((id) => breakDto(byId.get(id))),
      { ...pageMeta(q, agg.total), totalSeconds: agg.total_seconds, paidSeconds: agg.paid_seconds, exceededCount: agg.exceeded_count },
    );
  },
);

export default r;
