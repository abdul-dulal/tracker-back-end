import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, dateStr } from '../../lib/http.js';
import { badRequest } from '../../lib/errors.js';
import { assertMemberAccess, getOrgMember } from '../../rbac/scope.js';
import { ENTRY_SELECT, entryDto } from './timer-service.js';
import { memberTimezone } from './summary-service.js';
import { buildSummary, periodBounds, localToday, datesBetween } from './entry-service.js';

/** Working-hours summaries and calendar (TIME-11…17, TIME-32, TIME-33). */
const r = createRouter('/time', 'Time summary');

const MAX_RANGE_DAYS = 92;

r.get(
  '/summary',
  {
    summary: 'Daily / weekly / monthly working hours summary',
    ids: 'TIME-11, TIME-12, TIME-13, TIME-14, TIME-15, TIME-16, TIME-17, TIME-18, TIME-32',
    permission: 'time.view',
    query: z.object({
      memberId: z.uuid().optional(),
      period: z.enum(['day', 'week', 'month']).default('week'),
      date: dateStr.optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const memberId = q.memberId ?? ctx.memberId;
    await getOrgMember(ctx.orgId, memberId);
    await assertMemberAccess(ctx, 'time.view', memberId);
    const tz = await memberTimezone(memberId);
    let start;
    let end;
    let period = q.period;
    if (q.from || q.to) {
      if (!q.from || !q.to) throw badRequest('from and to must be given together', undefined, 'INVALID_RANGE');
      if (q.to < q.from) throw badRequest('to must not be before from', undefined, 'INVALID_RANGE');
      start = q.from;
      end = q.to;
      period = 'custom';
    } else {
      const date = q.date ?? (await localToday(tz));
      const ws = (await db.one('SELECT week_start FROM organizations WHERE id = $1', [ctx.orgId])).week_start;
      ({ start, end } = periodBounds(q.period, date, ws));
    }
    if (datesBetween(start, end).length > MAX_RANGE_DAYS) throw badRequest(`Range cannot exceed ${MAX_RANGE_DAYS} days`, undefined, 'INVALID_RANGE');
    const summary = await buildSummary(ctx.orgId, memberId, start, end);
    ok(res, { period, ...summary });
  },
);

r.get(
  '/calendar',
  {
    summary: 'Entries grouped by member-local date for the calendar UI',
    ids: 'TIME-24, TIME-25, TIME-33',
    permission: 'time.view',
    query: z.object({ memberId: z.uuid().optional(), from: dateStr, to: dateStr }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const memberId = q.memberId ?? ctx.memberId;
    await getOrgMember(ctx.orgId, memberId);
    await assertMemberAccess(ctx, 'time.view', memberId);
    if (q.to < q.from) throw badRequest('to must not be before from', undefined, 'INVALID_RANGE');
    const dates = datesBetween(q.from, q.to);
    if (dates.length > MAX_RANGE_DAYS) throw badRequest(`Range cannot exceed ${MAX_RANGE_DAYS} days`, undefined, 'INVALID_RANGE');
    const tz = await memberTimezone(memberId);
    const rows = await db.many(
      `SELECT x.*, to_char((x.started_at AT TIME ZONE $4), 'YYYY-MM-DD') AS local_date FROM (${ENTRY_SELECT}
         WHERE e.organization_id = $1 AND e.member_id = $2 AND e.deleted_at IS NULL
           AND e.started_at < (($5::date + 1)::timestamp AT TIME ZONE $4) AND coalesce(e.ended_at, now()) > ($3::date::timestamp AT TIME ZONE $4)) x
       ORDER BY x.started_at`,
      [ctx.orgId, memberId, q.from, tz, q.to],
    );
    const pauses = rows.length
      ? await db.many('SELECT id, time_entry_id, started_at, ended_at, reason FROM time_entry_pauses WHERE time_entry_id = ANY($1::uuid[]) ORDER BY started_at', [rows.map((e) => e.id)])
      : [];
    const byEntry = new Map();
    for (const p of pauses) {
      if (!byEntry.has(p.time_entry_id)) byEntry.set(p.time_entry_id, []);
      byEntry.get(p.time_entry_id).push({ id: p.id, startedAt: p.started_at, endedAt: p.ended_at, reason: p.reason });
    }
    const days = new Map(dates.map((d) => [d, { date: d, totalSeconds: 0, entries: [] }]));
    for (const e of rows) {
      const date = e.local_date < q.from ? q.from : e.local_date;
      const day = days.get(date);
      if (!day) continue;
      const dto = entryDto(e);
      dto.pauses = byEntry.get(e.id) ?? [];
      day.entries.push(dto);
      if (e.status !== 'rejected') day.totalSeconds += dto.durationSeconds;
    }
    ok(res, { memberId, timezone: tz, from: q.from, to: q.to, days: [...days.values()] });
  },
);

export default r;
