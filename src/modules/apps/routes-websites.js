import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, dateStr } from '../../lib/http.js';
import { PERM, rangeWindow, dayWindow, resolveMemberFilter, assertCanSeeMember, aggregateUsage, categorizerFactory } from './usage-service.js';

/** Website usage views (APP-10, APP-12, APP-19, APP-21). Excluded domains appear only as "(excluded)". */
const r = createRouter('/websites', 'Apps & websites');

const browser = z.enum(['chrome', 'firefox', 'edge', 'safari', 'other']);

r.get(
  '/usage',
  {
    summary: 'Website usage aggregated by domain or productivity category',
    ids: 'APP-05, APP-10, APP-19, APP-21, APP-22, APP-23',
    query: z.object({
      memberId: z.uuid().optional(),
      teamId: z.uuid().optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
      browser: browser.optional(),
      groupBy: z.enum(['domain', 'category']).default('domain'),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const memberIds = await resolveMemberFilter(ctx, PERM, q);
    const win = await rangeWindow(ctx, q);
    const rows = await db.many(
      `SELECT member_id, domain AS key, domain AS label, sum(duration_seconds)::int AS s FROM web_usage
       WHERE organization_id = $1 AND started_at >= $2 AND started_at < $3 AND ($4::uuid[] IS NULL OR member_id = ANY($4::uuid[]))
         AND ($5::text IS NULL OR browser = $5)
       GROUP BY member_id, domain`,
      [ctx.orgId, win.ws, win.we, memberIds, q.browser ?? null],
    );
    const browsers = await db.many(
      `SELECT browser, sum(duration_seconds)::int AS s FROM web_usage
       WHERE organization_id = $1 AND started_at >= $2 AND started_at < $3 AND ($4::uuid[] IS NULL OR member_id = ANY($4::uuid[]))
       GROUP BY browser ORDER BY 2 DESC`,
      [ctx.orgId, win.ws, win.we, memberIds],
    );
    const agg = await aggregateUsage(ctx.orgId, rows, 'website', q.groupBy === 'category' ? 'category' : 'domain');
    ok(res, {
      from: win.from,
      to: win.to,
      timezone: win.tz,
      groupBy: q.groupBy,
      browser: q.browser ?? null,
      ...agg,
      browsers: browsers.map((b) => ({ browser: b.browser, seconds: b.s })),
    });
  },
);

r.get(
  '/timeline',
  { summary: 'Website usage timeline for one member-day', ids: 'APP-12', query: z.object({ memberId: z.uuid().optional(), date: dateStr, browser: browser.optional() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const memberId = req.v.query.memberId ?? ctx.memberId;
    await assertCanSeeMember(ctx, PERM, memberId);
    const win = await dayWindow(memberId, req.v.query.date);
    const rows = await db.many(
      `SELECT id, browser, domain, url, title, started_at, ended_at, duration_seconds, is_excluded, time_entry_id FROM web_usage
       WHERE organization_id = $1 AND member_id = $2 AND started_at >= $3 AND started_at < $4 AND ($5::text IS NULL OR browser = $5)
       ORDER BY started_at LIMIT 5000`,
      [ctx.orgId, memberId, win.ws, win.we, req.v.query.browser ?? null],
    );
    const categorize = await (await categorizerFactory(ctx.orgId))(memberId);
    ok(res, {
      memberId,
      date: req.v.query.date,
      timezone: win.tz,
      items: rows.map((w) => ({
        id: w.id,
        browser: w.browser,
        domain: w.domain,
        url: w.url,
        title: w.title,
        startedAt: w.started_at,
        endedAt: w.ended_at,
        durationSeconds: w.duration_seconds,
        isExcluded: w.is_excluded,
        timeEntryId: w.time_entry_id,
        category: w.is_excluded ? 'neutral' : categorize('website', [w.domain]),
      })),
    });
  },
);

export default r;
