import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, dateStr } from '../../lib/http.js';
import { PERM, rangeWindow, dayWindow, resolveMemberFilter, assertCanSeeMember, aggregateUsage, categorizerFactory } from './usage-service.js';

/** Application usage views (APP-09, APP-11, APP-13…18, APP-20, APP-22, APP-23). */
const r = createRouter('/apps', 'Apps & websites');

r.get(
  '/usage',
  {
    summary: 'Application usage aggregated by app or productivity category',
    ids: 'APP-09, APP-13, APP-14, APP-15, APP-17, APP-18, APP-20, APP-22, APP-23',
    query: z.object({
      memberId: z.uuid().optional(),
      teamId: z.uuid().optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
      groupBy: z.enum(['app', 'category']).default('app'),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const memberIds = await resolveMemberFilter(ctx, PERM, q);
    const win = await rangeWindow(ctx, q);
    const rows = await db.many(
      `SELECT member_id, app_identifier AS key, max(app_name) AS label, sum(duration_seconds)::int AS s FROM app_usage
       WHERE organization_id = $1 AND started_at >= $2 AND started_at < $3 AND ($4::uuid[] IS NULL OR member_id = ANY($4::uuid[]))
       GROUP BY member_id, app_identifier`,
      [ctx.orgId, win.ws, win.we, memberIds],
    );
    const agg = await aggregateUsage(ctx.orgId, rows, 'app', q.groupBy);
    ok(res, { from: win.from, to: win.to, timezone: win.tz, groupBy: q.groupBy, ...agg });
  },
);

r.get(
  '/timeline',
  { summary: 'Application usage timeline for one member-day', ids: 'APP-11', query: z.object({ memberId: z.uuid().optional(), date: dateStr }) },
  async (req, res) => {
    const ctx = req.ctx;
    const memberId = req.v.query.memberId ?? ctx.memberId;
    await assertCanSeeMember(ctx, PERM, memberId);
    const win = await dayWindow(memberId, req.v.query.date);
    const rows = await db.many(
      `SELECT id, app_identifier, app_name, window_title, started_at, ended_at, duration_seconds, time_entry_id FROM app_usage
       WHERE organization_id = $1 AND member_id = $2 AND started_at >= $3 AND started_at < $4 ORDER BY started_at LIMIT 5000`,
      [ctx.orgId, memberId, win.ws, win.we],
    );
    const categorize = await (await categorizerFactory(ctx.orgId))(memberId);
    ok(res, {
      memberId,
      date: req.v.query.date,
      timezone: win.tz,
      items: rows.map((a) => ({
        id: a.id,
        appIdentifier: a.app_identifier,
        appName: a.app_name,
        windowTitle: a.window_title,
        startedAt: a.started_at,
        endedAt: a.ended_at,
        durationSeconds: a.duration_seconds,
        timeEntryId: a.time_entry_id,
        category: categorize('app', [a.app_name, a.app_identifier]),
      })),
    });
  },
);

export default r;
