import { z } from 'zod';
import { createRouter, zBool, zTimezone } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, paginationQuery, pageMeta, dateStr } from '../../lib/http.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { signedGetUrl } from '../../lib/storage.js';
import { notify } from '../notifications/service.js';
import { round2 } from '../currencies/service.js';
import { invoiceDto, loadInvoice, renderInvoicePdf } from '../invoices/service.js';
import {
  portalContext, VISIBLE_PROJECT, loadVisibleProject, memberLabels, projectProgress, projectTimeStats,
  emptyStats, budgetOverview, projectDto,
} from './service.js';

/**
 * Client portal (M17, CLI-01…18). Only client-role members; read-only except profile & comments (CLI-14).
 */
const r = createRouter('/client-portal', 'Client Portal');
const base = { roles: ['client'], feature: 'clientPortal' };
const projParam = z.object({ id: z.uuid() });

const WORKED = `e.deleted_at IS NULL AND e.status IN ('completed','approved')`;

// ───────────── Dashboard ─────────────
r.get('/dashboard', { ...base, summary: 'Client dashboard', ids: 'CLI-04, CLI-10, CLI-17' }, async (req, res) => {
  const pc = await portalContext(req.ctx);
  const projects = await db.many(`SELECT p.* FROM projects p WHERE ${VISIBLE_PROJECT} ORDER BY p.updated_at DESC`, [pc.orgId, pc.clientId]);
  const ids = projects.map((p) => p.id);
  const stats = await projectTimeStats(pc, ids);
  const month = await db.one(
    `SELECT to_char(date_trunc('month', now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS f, to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS t`,
    [pc.tz],
  );
  const monthStats = await projectTimeStats(pc, ids, { from: month.f, to: month.t });
  const sum = (m, k) => round2([...m.values()].reduce((s, x) => s + x[k], 0));
  const invoices = await db.many(
    `SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id
     WHERE i.organization_id = $1 AND i.client_id = $2 AND i.deleted_at IS NULL AND i.status <> 'draft'
     ORDER BY i.issue_date DESC, i.number DESC`,
    [pc.orgId, pc.clientId],
  );
  const open = invoices.filter((i) => ['sent', 'partially_paid', 'overdue'].includes(i.status));
  const outstanding = {};
  for (const i of open) outstanding[i.currency] = round2((outstanding[i.currency] ?? 0) + Number(i.total) - Number(i.amount_paid));
  const unread = await db.one(
    `SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND organization_id = $2 AND read_at IS NULL`,
    [req.ctx.userId, pc.orgId],
  );
  const recent = [];
  for (const p of projects.slice(0, 5)) recent.push({ ...projectDto(p, stats.get(p.id), pc.perms), progress: (await projectProgress(p)).percent });
  ok(res, {
    client: { id: pc.client.id, name: pc.client.name, company: pc.client.company },
    permissions: pc.perms,
    projects: {
      total: projects.length,
      active: projects.filter((p) => p.status === 'active').length,
      completed: projects.filter((p) => p.status === 'completed').length,
    },
    hours: { total: sum(stats, 'totalHours'), billable: sum(stats, 'billableHours'), thisMonth: sum(monthStats, 'totalHours'), billableThisMonth: sum(monthStats, 'billableHours') },
    invoices: {
      openCount: open.length,
      overdueCount: open.filter((i) => i.status === 'overdue' || (i.due_date && i.due_date < month.t)).length,
      outstanding: Object.entries(outstanding).map(([currency, amount]) => ({ currency, amount })),
      recent: invoices.slice(0, 5).map((i) => invoiceDto(i)),
    },
    unreadNotifications: unread.n,
    recentProjects: recent,
  });
});

// ───────────── Profile ─────────────
async function profile(req, pc) {
  const u = await db.one(`SELECT id, email, first_name, last_name, phone, timezone, locale, avatar_key FROM users WHERE id = $1`, [req.ctx.userId]);
  return {
    user: {
      id: u.id,
      email: u.email,
      firstName: u.first_name,
      lastName: u.last_name,
      phone: u.phone,
      timezone: u.timezone,
      locale: u.locale,
      avatarUrl: signedGetUrl(u.avatar_key, { ttl: 3600 }),
    },
    client: {
      id: pc.client.id,
      name: pc.client.name,
      company: pc.client.company,
      email: pc.client.email,
      phone: pc.client.phone,
      address: pc.client.address,
      currency: pc.client.currency,
    },
    permissions: pc.perms,
  };
}

r.get('/profile', { ...base, summary: 'Client profile', ids: 'CLI-03' }, async (req, res) => {
  const pc = await portalContext(req.ctx);
  ok(res, await profile(req, pc));
});

r.patch(
  '/profile',
  {
    ...base,
    summary: 'Update own client profile',
    ids: 'CLI-03, CLI-14',
    body: z
      .object({
        firstName: z.string().trim().min(1).max(100).optional(),
        lastName: z.string().trim().max(100).optional(),
        phone: z.string().trim().max(40).nullable().optional(),
        timezone: zTimezone.optional(),
        locale: z.string().trim().min(2).max(10).optional(),
        client: z
          .object({
            phone: z.string().trim().max(40).nullable().optional(),
            address: z.record(z.string(), z.string().max(200)).nullable().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  },
  async (req, res) => {
    const pc = await portalContext(req.ctx);
    const b = req.body;
    const map = { firstName: 'first_name', lastName: 'last_name', phone: 'phone', timezone: 'timezone', locale: 'locale' };
    const sets = [];
    const params = [req.ctx.userId];
    for (const [k, col] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      params.push(b[k]);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length) await db.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    if (b.client && (b.client.phone !== undefined || b.client.address !== undefined)) {
      const c = await db.one(
        `UPDATE clients SET phone = CASE WHEN $3 THEN $4 ELSE phone END, address = CASE WHEN $5 THEN $6::jsonb ELSE address END, updated_at = now()
         WHERE id = $1 AND organization_id = $2 RETURNING *`,
        [pc.clientId, pc.orgId, b.client.phone !== undefined, b.client.phone ?? null, b.client.address !== undefined, db.json(b.client.address)],
      );
      pc.client = c;
    }
    ok(res, await profile(req, pc));
  },
);

// ───────────── Projects ─────────────
r.get(
  '/projects',
  { ...base, summary: 'Projects visible to the client', ids: 'CLI-05, CLI-06, CLI-10, CLI-11', query: z.object({ status: z.enum(['planning', 'active', 'on_hold', 'completed', 'cancelled']).optional() }) },
  async (req, res) => {
    const pc = await portalContext(req.ctx);
    const params = [pc.orgId, pc.clientId];
    let extra = '';
    if (req.v.query.status) {
      params.push(req.v.query.status);
      extra = ` AND p.status = $3`;
    }
    const projects = await db.many(`SELECT p.* FROM projects p WHERE ${VISIBLE_PROJECT}${extra} ORDER BY p.name`, params);
    const stats = await projectTimeStats(pc, projects.map((p) => p.id));
    const out = [];
    for (const p of projects) {
      const s = stats.get(p.id) ?? emptyStats;
      out.push({ ...projectDto(p, s, pc.perms), progress: await projectProgress(p), budget: budgetOverview(p, s, pc.perms) });
    }
    ok(res, out);
  },
);

r.get('/projects/:id', { ...base, summary: 'Project overview: progress, budget, team', ids: 'CLI-05, CLI-06, CLI-07, CLI-10, CLI-11, CLI-18', params: projParam }, async (req, res) => {
  const pc = await portalContext(req.ctx);
  const p = await loadVisibleProject(pc, req.v.params.id);
  const stats = (await projectTimeStats(pc, [p.id])).get(p.id) ?? emptyStats;
  const labels = await memberLabels(pc);
  const team = await db.many(
    `SELECT pm.member_id, pm.role, m.designation, u.avatar_key FROM project_members pm
     JOIN organization_members m ON m.id = pm.member_id JOIN users u ON u.id = m.user_id
     WHERE pm.project_id = $1 AND m.deleted_at IS NULL AND m.status = 'active' ORDER BY m.created_at, m.id`,
    [p.id],
  );
  const milestones = await db.many(
    `SELECT t.id, t.title, t.due_date, t.completed_at FROM tasks t WHERE t.project_id = $1 AND t.deleted_at IS NULL AND t.parent_task_id IS NULL
       AND t.due_date IS NOT NULL ORDER BY t.due_date LIMIT 10`,
    [p.id],
  );
  const data = {
    ...projectDto(p, stats, pc.perms),
    progress: await projectProgress(p),
    budget: budgetOverview(p, stats, pc.perms),
    milestones: milestones.map((t) => ({ id: t.id, title: t.title, dueDate: t.due_date, completed: !!t.completed_at })),
    team: team.map((m) => ({
      ...(pc.perms.showMemberNames ? { memberId: m.member_id, avatarUrl: signedGetUrl(m.avatar_key, { ttl: 3600 }) } : {}),
      name: labels.get(m.member_id),
      designation: m.designation,
      projectRole: m.role,
    })),
  };
  if (pc.perms.showScreenshots) {
    const shots = await db.many(
      `SELECT id, member_id, captured_at, activity_percent, thumb_key, object_key, blurred_key, is_blurred FROM screenshots
       WHERE organization_id = $1 AND project_id = $2 AND deleted_at IS NULL ORDER BY captured_at DESC LIMIT 12`,
      [pc.orgId, p.id],
    );
    data.recentScreenshots = shots.map((s) => ({
      id: s.id,
      member: labels.get(s.member_id),
      capturedAt: s.captured_at,
      ...(pc.perms.showActivity ? { activityPercent: s.activity_percent } : {}),
      thumbnailUrl: signedGetUrl(s.is_blurred ? (s.blurred_key ?? s.thumb_key) : (s.thumb_key ?? s.object_key), { ttl: 900 }),
    }));
  }
  ok(res, data);
});

r.get(
  '/projects/:id/time',
  {
    ...base,
    summary: 'Project time report (by day, member or task)',
    ids: 'CLI-08, CLI-10, CLI-18',
    params: projParam,
    query: z.object({ from: dateStr.optional(), to: dateStr.optional(), groupBy: z.enum(['day', 'member', 'task']).default('day') }),
  },
  async (req, res) => {
    const pc = await portalContext(req.ctx);
    const p = await loadVisibleProject(pc, req.v.params.id);
    const q = req.v.query;
    const today = (await db.one(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [pc.tz])).d;
    const to = q.to ?? today;
    const from = q.from ?? (await db.one(`SELECT to_char($1::date - 29, 'YYYY-MM-DD') AS d`, [to])).d;
    if (from > to) throw badRequest('from must be on or before to');
    const groupSql = {
      day: `to_char((e.started_at AT TIME ZONE o.timezone)::date, 'YYYY-MM-DD')`,
      member: `e.member_id::text`,
      task: `coalesce(e.task_id::text, '')`,
    }[q.groupBy];
    const rows = await db.many(
      `SELECT ${groupSql} AS k, max(t.title) AS task_title,
              coalesce(sum(e.duration_seconds), 0)::bigint AS total,
              coalesce(sum(e.duration_seconds) FILTER (WHERE e.is_billable), 0)::bigint AS billable,
              coalesce(sum(e.active_seconds), 0)::bigint AS active,
              coalesce(sum(CASE WHEN e.is_billable THEN e.duration_seconds / 3600.0 * coalesce(pm.billable_rate, p.hourly_rate, c.hourly_rate, s.default_billable_rate, 0) END), 0) AS amount
       FROM time_entries e JOIN projects p ON p.id = e.project_id JOIN organizations o ON o.id = e.organization_id
       LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN organization_settings s ON s.organization_id = e.organization_id
       LEFT JOIN project_members pm ON pm.project_id = e.project_id AND pm.member_id = e.member_id
       LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.organization_id = $1 AND e.project_id = $2 AND ${WORKED}
         AND (e.started_at AT TIME ZONE o.timezone)::date BETWEEN $3::date AND $4::date
       GROUP BY 1 ORDER BY 1`,
      [pc.orgId, p.id, from, to],
    );
    const labels = q.groupBy === 'member' ? await memberLabels(pc) : null;
    const items = rows.map((x) => {
      const total = Number(x.total);
      const item = { totalHours: round2(total / 3600), billableHours: round2(Number(x.billable) / 3600) };
      if (q.groupBy === 'day') item.date = x.k;
      if (q.groupBy === 'member') item.member = labels.get(x.k);
      if (q.groupBy === 'task') Object.assign(item, { taskId: x.k || null, taskTitle: x.task_title ?? 'General work' });
      if (pc.perms.showActivity) item.activityPercent = total > 0 ? Math.min(100, Math.round((Number(x.active) / total) * 100)) : null;
      if (pc.perms.showRates) item.billableAmount = round2(x.amount);
      return item;
    });
    if (q.groupBy === 'member' && !pc.perms.showMemberNames) items.sort((a, b) => a.member.localeCompare(b.member, undefined, { numeric: true }));
    const totals = {
      totalHours: round2(items.reduce((s, x) => s + x.totalHours, 0)),
      billableHours: round2(items.reduce((s, x) => s + x.billableHours, 0)),
      ...(pc.perms.showRates ? { billableAmount: round2(items.reduce((s, x) => s + x.billableAmount, 0)), currency: p.currency ?? pc.client.currency ?? req.ctx.currency } : {}),
    };
    ok(res, { projectId: p.id, from, to, groupBy: q.groupBy, totals, items });
  },
);

r.get('/projects/:id/tasks', { ...base, summary: 'Project tasks (read-only)', ids: 'CLI-09', params: projParam, query: paginationQuery }, async (req, res) => {
  const pc = await portalContext(req.ctx);
  const p = await loadVisibleProject(pc, req.v.params.id);
  const q = req.v.query;
  const params = [p.id];
  let search = '';
  if (q.search) {
    params.push(`%${q.search}%`);
    search = ` AND t.title ILIKE $2`;
  }
  const total = (await db.one(`SELECT count(*)::int AS n FROM tasks t WHERE t.project_id = $1 AND t.deleted_at IS NULL${search}`, params)).n;
  const rows = await db.many(
    `SELECT t.id, t.parent_task_id, t.title, t.priority, t.start_date, t.due_date, t.progress, t.completed_at, t.estimated_hours,
            bc.name AS column_name, bc.category,
            (SELECT coalesce(sum(e.duration_seconds), 0) FROM time_entries e WHERE e.task_id = t.id AND ${WORKED})::bigint AS tracked,
            (SELECT array_agg(ta.member_id) FROM task_assignees ta WHERE ta.task_id = t.id) AS assignees
     FROM tasks t LEFT JOIN board_columns bc ON bc.id = t.column_id
     WHERE t.project_id = $1 AND t.deleted_at IS NULL${search}
     ORDER BY t.completed_at IS NOT NULL, t.due_date NULLS LAST, t.position LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    params,
  );
  const labels = await memberLabels(pc);
  ok(
    res,
    rows.map((t) => ({
      id: t.id,
      parentTaskId: t.parent_task_id,
      title: t.title,
      status: t.completed_at ? 'done' : (t.category ?? 'todo'),
      columnName: t.column_name,
      priority: t.priority,
      startDate: t.start_date,
      dueDate: t.due_date,
      progress: t.completed_at ? 100 : t.progress,
      completedAt: t.completed_at,
      estimatedHours: t.estimated_hours === null ? null : Number(t.estimated_hours),
      trackedHours: round2(Number(t.tracked) / 3600),
      assignees: (t.assignees ?? []).map((id) => labels.get(id) ?? 'Team member'),
    })),
    pageMeta(q, total),
  );
});

r.get('/projects/:id/timesheets', { ...base, summary: 'Approved timesheets (project hours only)', ids: 'CLI-12', params: projParam, query: paginationQuery }, async (req, res) => {
  const pc = await portalContext(req.ctx);
  const p = await loadVisibleProject(pc, req.v.params.id);
  const q = req.v.query;
  const rows = await db.many(
    `SELECT ts.id, ts.member_id, ts.period_type, ts.period_start, ts.period_end, ts.approved_at,
            sum(e.duration_seconds)::bigint AS total, coalesce(sum(e.duration_seconds) FILTER (WHERE e.is_billable), 0)::bigint AS billable,
            count(*) OVER () AS full_count
     FROM timesheets ts
     JOIN organization_members m ON m.id = ts.member_id
     JOIN organizations o ON o.id = ts.organization_id
     JOIN time_entries e ON e.member_id = ts.member_id AND e.project_id = $2 AND ${WORKED}
       AND (e.started_at AT TIME ZONE coalesce(m.timezone, o.timezone))::date BETWEEN ts.period_start AND ts.period_end
     WHERE ts.organization_id = $1 AND ts.status = 'approved'
     GROUP BY ts.id
     HAVING sum(e.duration_seconds) > 0
     ORDER BY ts.period_start DESC, ts.id LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    [pc.orgId, p.id],
  );
  const labels = await memberLabels(pc);
  ok(
    res,
    rows.map((x) => ({
      id: x.id,
      member: labels.get(x.member_id),
      periodType: x.period_type,
      periodStart: x.period_start,
      periodEnd: x.period_end,
      approvedAt: x.approved_at,
      projectHours: round2(Number(x.total) / 3600),
      billableHours: round2(Number(x.billable) / 3600),
    })),
    pageMeta(q, rows.length ? Number(rows[0].full_count) : 0),
  );
});

// ───────────── Shared reports ─────────────
r.get('/reports', { ...base, summary: 'Reports shared with this client', ids: 'CLI-13' }, async (req, res) => {
  const pc = await portalContext(req.ctx);
  const rows = await db.many(
    `SELECT id, name, definition_snapshot, expires_at, created_at, password_hash IS NOT NULL AS has_password FROM report_shares
     WHERE organization_id = $1 AND client_id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC`,
    [pc.orgId, pc.clientId],
  );
  ok(
    res,
    rows.map((x) => ({ id: x.id, name: x.name, definition: x.definition_snapshot, passwordProtected: x.has_password, expiresAt: x.expires_at, createdAt: x.created_at })),
  );
});

// ───────────── Comments ─────────────
async function projectTaskIds(projectId) {
  return (await db.many(`SELECT id FROM tasks WHERE project_id = $1 AND deleted_at IS NULL`, [projectId])).map((t) => t.id);
}

async function commentDto(pc, rows) {
  const labels = await memberLabels(pc);
  return rows.map((c) => ({
    id: c.id,
    entityType: c.entity_type,
    entityId: c.entity_id,
    body: c.body,
    author: c.author_is_client || pc.perms.showMemberNames ? c.author_name : (labels.get(c.author_member_id) ?? 'Team member'),
    authorIsClient: !!c.author_is_client,
    isMine: c.author_member_id === pc.ctx.memberId,
    createdAt: c.created_at,
    editedAt: c.edited_at,
  }));
}

const COMMENT_SELECT = `SELECT cm.*, trim(u.first_name || ' ' || u.last_name) AS author_name, (ro.base_role = 'client') AS author_is_client
  FROM comments cm LEFT JOIN organization_members m ON m.id = cm.author_member_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN roles ro ON ro.id = m.role_id`;

r.get(
  '/projects/:id/comments',
  { ...base, summary: 'Client-visible comments on a project and its tasks', ids: 'CLI-15', params: projParam, query: paginationQuery.extend({ taskId: z.uuid().optional() }) },
  async (req, res) => {
    const pc = await portalContext(req.ctx);
    const p = await loadVisibleProject(pc, req.v.params.id);
    const q = req.v.query;
    const taskIds = await projectTaskIds(p.id);
    if (q.taskId && !taskIds.includes(q.taskId)) throw notFound('Task');
    const cond = q.taskId
      ? `cm.entity_type = 'task' AND cm.entity_id = $2`
      : `((cm.entity_type = 'project' AND cm.entity_id = $2) OR (cm.entity_type = 'task' AND cm.entity_id = ANY($3::uuid[])))`;
    const params = q.taskId ? [pc.orgId, q.taskId] : [pc.orgId, p.id, taskIds];
    const w = `WHERE cm.organization_id = $1 AND cm.visibility = 'client' AND cm.deleted_at IS NULL AND ${cond}`;
    const total = (await db.one(`SELECT count(*)::int AS n FROM comments cm ${w}`, params)).n;
    const rows = await db.many(`${COMMENT_SELECT} ${w} ORDER BY cm.created_at ${q.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, params);
    ok(res, await commentDto(pc, rows), pageMeta(q, total));
  },
);

r.post(
  '/projects/:id/comments',
  { ...base, summary: 'Post a client comment on a project or task', ids: 'CLI-15, CLI-16', params: projParam, body: z.object({ body: z.string().trim().min(1).max(5000), taskId: z.uuid().optional() }) },
  async (req, res) => {
    const pc = await portalContext(req.ctx);
    const p = await loadVisibleProject(pc, req.v.params.id);
    let entityType = 'project';
    let entityId = p.id;
    let taskTitle = null;
    if (req.body.taskId) {
      const t = await db.one(`SELECT id, title FROM tasks WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`, [req.body.taskId, p.id]);
      if (!t) throw notFound('Task');
      entityType = 'task';
      entityId = t.id;
      taskTitle = t.title;
    }
    const c = await db.one(
      `INSERT INTO comments (organization_id, entity_type, entity_id, author_member_id, body, visibility) VALUES ($1,$2,$3,$4,$5,'client') RETURNING id`,
      [pc.orgId, entityType, entityId, req.ctx.memberId, req.body.body],
    );
    const managers = await db.many(
      `SELECT DISTINCT member_id FROM (
         SELECT member_id FROM project_members WHERE project_id = $1 AND role = 'manager'
         UNION SELECT created_by FROM projects WHERE id = $1 AND created_by IS NOT NULL) x WHERE member_id <> $2`,
      [p.id, req.ctx.memberId],
    );
    if (managers.length)
      await notify({
        orgId: pc.orgId,
        memberIds: managers.map((m) => m.member_id),
        type: 'task.comment',
        title: `New client comment on ${taskTitle ? `task "${taskTitle}"` : `project ${p.name}`}`,
        body: `${pc.client.name}: ${req.body.body.slice(0, 200)}`,
        link: entityType === 'task' ? `/projects/${p.id}/tasks/${entityId}` : `/projects/${p.id}`,
        data: { commentId: c.id, projectId: p.id, entityType, entityId, clientId: pc.clientId },
      });
    const row = await db.one(`${COMMENT_SELECT} WHERE cm.id = $1`, [c.id]);
    created(res, (await commentDto(pc, [row]))[0]);
  },
);

// ───────────── Invoices ─────────────
r.get(
  '/invoices',
  { ...base, summary: 'Client invoices (non-draft)', ids: 'CLI-17', query: paginationQuery.extend({ status: z.enum(['sent', 'partially_paid', 'paid', 'overdue', 'void']).optional() }) },
  async (req, res) => {
    const pc = await portalContext(req.ctx);
    const q = req.v.query;
    const params = [pc.orgId, pc.clientId];
    let st = '';
    if (q.status) {
      params.push(q.status);
      st = ' AND i.status = $3';
    }
    const w = `WHERE i.organization_id = $1 AND i.client_id = $2 AND i.deleted_at IS NULL AND i.status <> 'draft'${st}`;
    const total = (await db.one(`SELECT count(*)::int AS n FROM invoices i ${w}`, params)).n;
    const rows = await db.many(
      `SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id ${w}
       ORDER BY i.issue_date ${q.order === 'asc' ? 'ASC' : 'DESC'}, i.number DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      params,
    );
    ok(
      res,
      rows.map((i) => {
        const d = invoiceDto(i);
        return {
          id: d.id, number: d.number, status: d.status, issueDate: d.issueDate, dueDate: d.dueDate, currency: d.currency,
          total: d.total, amountPaid: d.amountPaid, balance: d.balance, isOverdue: d.isOverdue, periodFrom: d.periodFrom, periodTo: d.periodTo, sentAt: d.sentAt,
        };
      }),
      pageMeta(q, total),
    );
  },
);

r.get('/invoices/:id/pdf', { ...base, summary: 'Download invoice PDF', ids: 'CLI-17, BILL-12', params: projParam }, async (req, res) => {
  const pc = await portalContext(req.ctx);
  const inv = await loadInvoice(pc.orgId, req.v.params.id, { clientId: pc.clientId });
  if (inv.status === 'draft') throw notFound('Invoice');
  const { buffer } = await renderInvoicePdf(pc.orgId, inv.id, { clientId: pc.clientId });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${inv.number.replace(/[^\w.-]/g, '_')}.pdf"`);
  res.send(buffer);
});

// ───────────── Notifications ─────────────
r.get('/notifications', { ...base, summary: 'Client notifications', ids: 'CLI-16', query: paginationQuery.extend({ unread: zBool.optional() }) }, async (req, res) => {
  await portalContext(req.ctx);
  const q = req.v.query;
  const w = `WHERE recipient_user_id = $1 AND organization_id = $2${q.unread ? ' AND read_at IS NULL' : ''}`;
  const params = [req.ctx.userId, req.ctx.orgId];
  const total = (await db.one(`SELECT count(*)::int AS n FROM notifications ${w}`, params)).n;
  const rows = await db.many(`SELECT * FROM notifications ${w} ORDER BY created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, params);
  ok(
    res,
    rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, data: n.data, readAt: n.read_at, createdAt: n.created_at })),
    pageMeta(q, total),
  );
});

export default r;
