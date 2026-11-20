import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, dateStr, where, paginationQuery, pageClause, pageMeta } from '../../lib/http.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { scopeMembers, assertMemberAccess, getOrgMember, accessibleMemberIds } from '../../rbac/scope.js';
import {
  TS_SELECT,
  timesheetDto,
  loadTimesheet,
  getOrCreateTimesheet,
  refreshTotals,
  submitTimesheet,
  approveTimesheet,
  rejectTimesheet,
  lockTimesheet,
  unlockTimesheet,
  orgTimesheetSettings,
  periodFor,
  memberLocalToday,
  entryInPeriodSql,
  addDays,
} from './service.js';
import { renderExport } from './export.js';
import { memberTimezone } from '../time/summary-service.js';
import { entryDto, ENTRY_SELECT } from '../time/timer-service.js';

const r = createRouter('/timesheets', 'Timesheets');
const idParam = z.object({ id: z.uuid() });

async function levels(orgId) {
  return Number((await orgTimesheetSettings(orgId)).approval_levels);
}

r.get(
  '/current',
  { summary: "Current period timesheet of the caller (created if missing)", ids: 'TS-01, TS-03, TS-05', permission: ['timesheets.view', 'timesheets.submit'] },
  async (req, res) => {
    const ctx = req.ctx;
    const ts = await getOrCreateTimesheet(ctx.orgId, ctx.memberId);
    ok(res, timesheetDto(await loadTimesheet(ctx.orgId, ts.id), await levels(ctx.orgId)));
  },
);

r.get(
  '/',
  {
    summary: 'List timesheets',
    ids: 'TS-05, TS-06',
    permission: 'timesheets.view',
    query: paginationQuery.extend({
      memberId: z.uuid().optional(),
      teamId: z.uuid().optional(),
      status: z.enum(['draft', 'submitted', 'approved', 'rejected']).optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const w = where([ctx.orgId]);
    w.raw('ts.organization_id = $1');
    w.add('ts.member_id = ?', q.memberId);
    if (q.teamId) w.add('ts.member_id IN (SELECT member_id FROM team_members WHERE team_id = ?)', q.teamId);
    w.add('ts.status = ?', q.status);
    w.add('ts.period_end >= ?::date', q.from);
    w.add('ts.period_start <= ?::date', q.to);
    if (q.search) w.add(`(u.first_name || ' ' || coalesce(u.last_name,'')) ILIKE ?`, `%${q.search}%`);
    await scopeMembers(ctx, 'timesheets.view', w, 'ts.member_id');
    const pc = pageClause(q, { periodStart: 'ts.period_start', status: 'ts.status', totalSeconds: 'ts.total_seconds', submittedAt: 'ts.submitted_at', member: 'u.first_name' }, 'periodStart');
    const total = (await db.one(
      `SELECT count(*)::int AS n FROM timesheets ts JOIN organization_members m ON m.id = ts.member_id JOIN users u ON u.id = m.user_id ${w.sql}`,
      w.params,
    )).n;
    const rows = await db.many(`${TS_SELECT} ${w.sql} ${pc.orderBy} LIMIT ${pc.limit} OFFSET ${pc.offset}`, w.params);
    const lv = await levels(ctx.orgId);
    ok(res, rows.map((x) => timesheetDto(x, lv)), pageMeta(q, total));
  },
);

r.get(
  '/view',
  {
    summary: 'Timesheet grid view (rows × days)',
    ids: 'TS-02, TS-03, TS-04, TS-05, TS-06, TS-07, TS-08',
    permission: 'timesheets.view',
    query: z.object({
      period: z.enum(['day', 'week', 'month']).default('week'),
      date: dateStr.optional(),
      memberId: z.uuid().optional(),
      teamId: z.uuid().optional(),
      projectId: z.uuid().optional(),
      taskId: z.uuid().optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const filters = ['memberId', 'teamId', 'projectId', 'taskId'].filter((k) => q[k]);
    if (filters.length > 1) throw badRequest('Use only one of memberId, teamId, projectId, taskId');
    const s = await orgTimesheetSettings(ctx.orgId);
    const date = q.date ?? (await memberLocalToday(ctx.memberId));
    const p = periodFor(date, q.period, s.week_start);
    const mode = filters[0] ?? 'memberId';
    const memberId = mode === 'memberId' ? (q.memberId ?? ctx.memberId) : undefined;
    if (memberId) {
      await getOrgMember(ctx.orgId, memberId);
      await assertMemberAccess(ctx, 'timesheets.view', memberId);
    }
    const w = where([ctx.orgId, p.start, p.end]);
    w.raw('e.organization_id = $1');
    w.raw(entryInPeriodSql(`coalesce(m.timezone, o.timezone, 'UTC')`, '$2', '$3'));
    w.add('e.member_id = ?', memberId);
    if (q.teamId) w.add('e.member_id IN (SELECT member_id FROM team_members WHERE team_id = ?)', q.teamId);
    w.add('e.project_id = ?', q.projectId);
    w.add('e.task_id = ?', q.taskId);
    await scopeMembers(ctx, 'timesheets.view', w, 'e.member_id');
    const rows = await db.many(
      `SELECT to_char((e.started_at AT TIME ZONE coalesce(m.timezone, o.timezone, 'UTC'))::date, 'YYYY-MM-DD') AS date,
              e.member_id, u.first_name, u.last_name, e.project_id, p.name AS project_name, e.task_id, t.title AS task_title,
              sum(CASE WHEN e.ended_at IS NULL THEN greatest(extract(epoch FROM (now() - e.started_at))::int - e.paused_seconds - e.idle_discarded_seconds, 0)
                       ELSE e.duration_seconds END)::int AS seconds,
              sum(CASE WHEN e.is_billable THEN e.duration_seconds ELSE 0 END)::int AS billable
       FROM time_entries e
       JOIN organization_members m ON m.id = e.member_id JOIN organizations o ON o.id = e.organization_id JOIN users u ON u.id = m.user_id
       LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN tasks t ON t.id = e.task_id
       ${w.sql}
       GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`,
      w.params,
    );
    const days = [];
    for (let d = p.start; d <= p.end; d = addDays(d, 1)) days.push(d);
    const byMember = mode !== 'memberId';
    const grid = new Map();
    for (const x of rows) {
      const key = byMember ? x.member_id : `${x.project_id ?? 'none'}|${x.task_id ?? 'none'}`;
      if (!grid.has(key))
        grid.set(
          key,
          byMember
            ? { key, type: 'member', member: { id: x.member_id, name: `${x.first_name ?? ''} ${x.last_name ?? ''}`.trim() }, days: {}, totalSeconds: 0, billableSeconds: 0 }
            : {
                key,
                type: 'project_task',
                project: x.project_id ? { id: x.project_id, name: x.project_name } : null,
                task: x.task_id ? { id: x.task_id, title: x.task_title } : null,
                days: {},
                totalSeconds: 0,
                billableSeconds: 0,
              },
        );
      const g = grid.get(key);
      g.days[x.date] = (g.days[x.date] ?? 0) + x.seconds;
      g.totalSeconds += x.seconds;
      g.billableSeconds += x.billable;
    }
    if (q.teamId) {
      // Include team members without time so the team grid is complete.
      const ids = await accessibleMemberIds(ctx, 'timesheets.view');
      const members = await db.many(
        `SELECT m.id, u.first_name, u.last_name FROM team_members tm JOIN organization_members m ON m.id = tm.member_id JOIN users u ON u.id = m.user_id
         WHERE tm.team_id = $1 AND m.organization_id = $2 AND m.status = 'active' AND m.deleted_at IS NULL`,
        [q.teamId, ctx.orgId],
      );
      for (const m of members)
        if ((!ids || ids.includes(m.id)) && !grid.has(m.id))
          grid.set(m.id, { key: m.id, type: 'member', member: { id: m.id, name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() }, days: {}, totalSeconds: 0, billableSeconds: 0 });
    }
    const list = [...grid.values()].sort((a, b) => (a.member?.name ?? a.project?.name ?? '').localeCompare(b.member?.name ?? b.project?.name ?? ''));
    const dayTotals = Object.fromEntries(days.map((d) => [d, list.reduce((s2, g) => s2 + (g.days[d] ?? 0), 0)]));
    let timesheet = null;
    if (memberId && q.period !== 'day') {
      const ts = await db.one(`${TS_SELECT} WHERE ts.member_id = $1 AND ts.period_start <= $2 AND ts.period_end >= $2 ORDER BY ts.period_start DESC LIMIT 1`, [memberId, p.start]);
      if (ts) timesheet = timesheetDto(ts, Number(s.approval_levels));
    }
    ok(res, {
      period: q.period,
      start: p.start,
      end: p.end,
      groupedBy: byMember ? 'member' : 'project_task',
      days,
      rows: list,
      dayTotals,
      totalSeconds: list.reduce((s2, g) => s2 + g.totalSeconds, 0),
      billableSeconds: list.reduce((s2, g) => s2 + g.billableSeconds, 0),
      timesheet,
    });
  },
);

r.post(
  '/bulk-approve',
  {
    summary: 'Approve several timesheets',
    ids: 'TS-12, TS-15',
    permission: 'timesheets.approve',
    body: z.object({ ids: z.array(z.uuid()).min(1).max(100), comment: z.string().trim().max(2000).optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const approved = [];
    const failed = [];
    for (const id of [...new Set(req.body.ids)]) {
      try {
        const ts = await approveTimesheet(ctx, id, req.body.comment);
        approved.push({ id, status: ts.status, currentLevel: ts.current_level });
      } catch (err) {
        failed.push({ id, code: err.code ?? 'ERROR', message: err.message });
      }
    }
    ok(res, { approved, failed });
  },
);

async function loadAccessible(ctx, id, perm = 'timesheets.view') {
  const ts = await loadTimesheet(ctx.orgId, id);
  await assertMemberAccess(ctx, perm, ts.member_id);
  return ts;
}

async function eventsOf(tsId) {
  const rows = await db.many(
    `SELECT ev.*, u.first_name, u.last_name FROM timesheet_events ev
     LEFT JOIN organization_members m ON m.id = ev.actor_member_id LEFT JOIN users u ON u.id = m.user_id
     WHERE ev.timesheet_id = $1 ORDER BY ev.created_at, ev.id`,
    [tsId],
  );
  return rows.map((e) => ({
    id: e.id,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    comment: e.comment,
    actor: e.actor_member_id ? { id: e.actor_member_id, name: `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim() } : null,
    createdAt: e.created_at,
  }));
}

async function commentsOf(tsId) {
  const rows = await db.many(
    `SELECT c.*, u.first_name, u.last_name FROM comments c
     LEFT JOIN organization_members m ON m.id = c.author_member_id LEFT JOIN users u ON u.id = m.user_id
     WHERE c.entity_type = 'timesheet' AND c.entity_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at`,
    [tsId],
  );
  return rows.map((c) => ({
    id: c.id,
    body: c.body,
    author: c.author_member_id ? { id: c.author_member_id, name: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() } : null,
    createdAt: c.created_at,
    editedAt: c.edited_at,
  }));
}

r.get(
  '/:id',
  { summary: 'Timesheet detail', ids: 'TS-05, TS-10, TS-15, TS-21', permission: 'timesheets.view', params: idParam },
  async (req, res) => {
    const ctx = req.ctx;
    let ts = await loadAccessible(ctx, req.v.params.id);
    if (!ts.locked_at && ['draft', 'rejected'].includes(ts.status)) {
      await refreshTotals(ts);
      ts = await loadTimesheet(ctx.orgId, ts.id);
    }
    const tz = await memberTimezone(ts.member_id);
    const entries = await db.many(
      `${ENTRY_SELECT} WHERE e.member_id = $1 AND e.organization_id = $2 AND ${entryInPeriodSql('$3', '$4', '$5')} ORDER BY e.started_at`,
      [ts.member_id, ctx.orgId, tz, ts.period_start, ts.period_end],
    );
    const approvals = await db.many(
      `SELECT a.*, u.first_name, u.last_name FROM timesheet_approvals a
       LEFT JOIN organization_members m ON m.id = a.approver_member_id LEFT JOIN users u ON u.id = m.user_id
       WHERE a.timesheet_id = $1 AND a.revision = $2 ORDER BY a.level, a.decided_at`,
      [ts.id, ts.revision],
    );
    ok(res, {
      ...timesheetDto(ts, await levels(ctx.orgId)),
      entries: entries.map(entryDto),
      approvals: approvals.map((a) => ({
        id: a.id,
        level: a.level,
        revision: a.revision,
        decision: a.decision,
        comment: a.comment,
        approver: a.approver_member_id ? { id: a.approver_member_id, name: `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() } : null,
        decidedAt: a.decided_at,
      })),
      events: await eventsOf(ts.id),
      comments: await commentsOf(ts.id),
    });
  },
);

r.post(
  '/:id/submit',
  { summary: 'Submit timesheet', ids: 'TS-11, TS-14', permission: 'timesheets.submit', params: idParam, body: z.object({}).optional() },
  async (req, res) => {
    const ts = await submitTimesheet(req.ctx, req.v.params.id);
    ok(res, timesheetDto(ts, await levels(req.ctx.orgId)));
  },
);

r.post(
  '/:id/approve',
  {
    summary: 'Approve timesheet (current level)',
    ids: 'TS-12, TS-15, TS-16',
    permission: 'timesheets.approve',
    params: idParam,
    body: z.object({ comment: z.string().trim().max(2000).optional() }).optional(),
  },
  async (req, res) => {
    const ts = await approveTimesheet(req.ctx, req.v.params.id, req.body?.comment);
    ok(res, timesheetDto(ts, await levels(req.ctx.orgId)));
  },
);

r.post(
  '/:id/reject',
  {
    summary: 'Reject timesheet',
    ids: 'TS-13, TS-14',
    permission: 'timesheets.approve',
    params: idParam,
    body: z.object({ comment: z.string().trim().min(1).max(2000) }),
  },
  async (req, res) => {
    const ts = await rejectTimesheet(req.ctx, req.v.params.id, req.body.comment);
    ok(res, timesheetDto(ts, await levels(req.ctx.orgId)));
  },
);

r.post(
  '/:id/lock',
  { summary: 'Lock timesheet', ids: 'TS-16', permission: 'timesheets.lock', params: idParam, body: z.object({}).optional() },
  async (req, res) => {
    const ctx = req.ctx;
    const ts = await loadAccessible(ctx, req.v.params.id, 'timesheets.lock');
    if (ts.locked_at) throw conflict('ALREADY_LOCKED', 'Timesheet is already locked');
    await lockTimesheet(ts, ctx.memberId);
    await audit(ctx, 'timesheet.locked', { entityType: 'timesheet', entityId: ts.id, before: { lockedAt: null }, after: { status: ts.status } });
    ok(res, timesheetDto(await loadTimesheet(ctx.orgId, ts.id), await levels(ctx.orgId)));
  },
);

r.post(
  '/:id/unlock',
  { summary: 'Unlock timesheet (back to draft)', ids: 'TS-16', permission: 'timesheets.lock', params: idParam, body: z.object({}).optional() },
  async (req, res) => {
    const ctx = req.ctx;
    const ts = await loadAccessible(ctx, req.v.params.id, 'timesheets.lock');
    if (!ts.locked_at && !['submitted', 'approved'].includes(ts.status)) throw conflict('NOT_LOCKED', 'Timesheet is not locked');
    await unlockTimesheet(ctx, ts);
    await audit(ctx, 'timesheet.unlocked', {
      entityType: 'timesheet',
      entityId: ts.id,
      before: { status: ts.status, lockedAt: ts.locked_at },
      after: { status: 'draft', lockedAt: null },
    });
    ok(res, timesheetDto(await loadTimesheet(ctx.orgId, ts.id), await levels(ctx.orgId)));
  },
);

r.get(
  '/:id/comments',
  { summary: 'Timesheet comments', ids: 'TS-17', permission: 'timesheets.view', params: idParam },
  async (req, res) => {
    const ts = await loadAccessible(req.ctx, req.v.params.id);
    ok(res, await commentsOf(ts.id));
  },
);

r.post(
  '/:id/comments',
  {
    summary: 'Add timesheet comment',
    ids: 'TS-17',
    permission: 'timesheets.view',
    params: idParam,
    body: z.object({ body: z.string().trim().min(1).max(5000) }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const ts = await loadAccessible(ctx, req.v.params.id);
    const c = await db.one(
      `INSERT INTO comments (organization_id, entity_type, entity_id, author_member_id, body) VALUES ($1,'timesheet',$2,$3,$4) RETURNING id`,
      [ctx.orgId, ts.id, ctx.memberId, req.body.body],
    );
    const all = await commentsOf(ts.id);
    created(res, all.find((x) => x.id === c.id));
  },
);

r.get(
  '/:id/history',
  { summary: 'Timesheet history', ids: 'TS-21', permission: 'timesheets.view', params: idParam },
  async (req, res) => {
    const ts = await loadAccessible(req.ctx, req.v.params.id);
    ok(res, await eventsOf(ts.id));
  },
);

r.get(
  '/:id/export',
  {
    summary: 'Export timesheet',
    ids: 'TS-18, TS-19, TS-20',
    permission: 'timesheets.export',
    params: idParam,
    query: z.object({ format: z.enum(['pdf', 'xlsx', 'csv']).default('pdf') }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const ts = await loadAccessible(ctx, req.v.params.id, 'timesheets.export');
    const out = await renderExport(ts, req.v.query.format);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Content-Length', out.buffer.length);
    res.status(200).end(out.buffer);
  },
);

export default r;
