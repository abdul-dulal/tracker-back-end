import { z } from 'zod';
import { createRouter, zMoney, zBool, zColor, zCurrency } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta, where, pageClause, dateStr, uuidParam } from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { accessibleProjectIds } from '../../rbac/scope.js';
import { logActivity, audit, diff } from '../../lib/audit.js';
import { publish } from '../../lib/events.js';
import { notify } from '../notifications/service.js';
import { signedGetUrl } from '../../lib/storage.js';
import {
  seedColumns,
  getProjectFor,
  projectDto,
  progressOf,
  projectProgress,
  projectTotals,
  budgetUsage,
  projectMembers,
  projectAllMemberIds,
  assertOrgMembers,
  hours,
  r2,
  num,
  activityDto,
} from './service.js';

const r = createRouter('/projects', 'Projects');

const STATUS = z.enum(['planning', 'active', 'on_hold', 'completed', 'cancelled']);
const PRIORITY = z.enum(['low', 'medium', 'high', 'urgent']);
const memberItem = z.object({
  memberId: z.uuid(),
  role: z.enum(['manager', 'member', 'viewer']).default('member'),
  billableRate: zMoney.nullable().optional(),
});
const membersBody = z.union([z.array(memberItem), z.object({ members: z.array(memberItem) })]).transform((v) => (Array.isArray(v) ? v : v.members));

const projectFields = {
  name: z.string().trim().min(1).max(150),
  code: z.string().trim().max(20).nullable().optional(),
  description: z.string().max(20000).nullable().optional(),
  clientId: z.uuid().nullable().optional(),
  status: STATUS.optional(),
  priority: PRIORITY.optional(),
  startDate: dateStr.nullable().optional(),
  deadline: dateStr.nullable().optional(),
  budgetType: z.enum(['none', 'hours', 'amount']).optional(),
  budgetValue: zMoney.nullable().optional(),
  currency: zCurrency.nullable().optional(),
  hourlyRate: zMoney.nullable().optional(),
  isBillableDefault: z.boolean().optional(),
  progressMode: z.enum(['auto', 'manual']).optional(),
  progressManual: z.number().int().min(0).max(100).nullable().optional(),
  clientVisible: z.boolean().optional(),
  color: zColor.nullable().optional(),
};
const FIELD_MAP = {
  name: 'name',
  code: 'code',
  description: 'description',
  clientId: 'client_id',
  status: 'status',
  priority: 'priority',
  startDate: 'start_date',
  deadline: 'deadline',
  budgetType: 'budget_type',
  budgetValue: 'budget_value',
  currency: 'currency',
  hourlyRate: 'hourly_rate',
  isBillableDefault: 'is_billable_default',
  progressMode: 'progress_mode',
  progressManual: 'progress_manual',
  clientVisible: 'client_visible',
  color: 'color',
};

const canSeeMoney = (ctx) => !!(ctx.can('billing.view') || ctx.can('projects.update'));

async function assertClient(orgId, clientId) {
  if (!clientId) return;
  const c = await db.one('SELECT 1 FROM clients WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [clientId, orgId]);
  if (!c) throw badRequest('Client not found', undefined, 'INVALID_REFERENCE');
}

async function assertTeams(orgId, teamIds) {
  const ids = [...new Set(teamIds)];
  if (!ids.length) return ids;
  const rows = await db.many('SELECT id FROM teams WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL', [orgId, ids]);
  if (rows.length !== ids.length) throw badRequest('One or more teams were not found', undefined, 'INVALID_REFERENCE');
  return ids;
}

function checkDates(b) {
  if (b.startDate && b.deadline && b.deadline < b.startDate) throw badRequest('Deadline must be on or after the start date', undefined, 'INVALID_DATES');
}

async function teamsOf(projectId) {
  return db.many(
    `SELECT t.id, t.name, t.color FROM project_teams pt JOIN teams t ON t.id = pt.team_id WHERE pt.project_id = $1 AND t.deleted_at IS NULL ORDER BY t.name`,
    [projectId],
  );
}

/** Replace project members; returns newly added member ids. */
async function replaceMembers(ctx, projectId, members) {
  await assertOrgMembers(ctx.orgId, members.map((m) => m.memberId));
  const before = (await db.many('SELECT member_id FROM project_members WHERE project_id = $1', [projectId])).map((x) => x.member_id);
  const seen = new Set();
  const list = members.filter((m) => !seen.has(m.memberId) && seen.add(m.memberId));
  await db.query('DELETE FROM project_members WHERE project_id = $1 AND NOT (member_id = ANY($2::uuid[]))', [projectId, list.map((m) => m.memberId)]);
  for (const m of list) {
    await db.query(
      `INSERT INTO project_members (project_id, member_id, role, billable_rate) VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, member_id) DO UPDATE SET role = EXCLUDED.role, billable_rate = EXCLUDED.billable_rate`,
      [projectId, m.memberId, m.role, m.billableRate ?? null],
    );
  }
  return list.map((m) => m.memberId).filter((id) => !before.includes(id));
}

async function notifyAdded(ctx, project, memberIds) {
  const ids = memberIds.filter((id) => id !== ctx.memberId);
  if (!ids.length) return;
  await notify({
    orgId: ctx.orgId,
    memberIds: ids,
    type: 'project.created',
    title: `You were added to project ${project.name}`,
    body: `You are now a member of "${project.name}".`,
    link: `/projects/${project.id}`,
    data: { projectId: project.id },
  });
}

// ───────────────────────── list / create ─────────────────────────
r.get(
  '/',
  {
    summary: 'List projects',
    ids: 'PROJ-28',
    permission: 'projects.view',
    query: paginationQuery.extend({
      status: STATUS.optional(),
      clientId: z.uuid().optional(),
      teamId: z.uuid().optional(),
      memberId: z.uuid().optional(),
      priority: PRIORITY.optional(),
      archived: zBool.optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const w = where();
    w.add('p.organization_id = ?', ctx.orgId).raw('p.deleted_at IS NULL');
    const ids = await accessibleProjectIds(ctx, 'projects.view');
    if (ids) w.add('p.id = ANY(?::uuid[])', ids);
    w.add('p.status = ?', q.status).add('p.client_id = ?', q.clientId).add('p.priority = ?', q.priority);
    w.add('EXISTS (SELECT 1 FROM project_teams pt WHERE pt.project_id = p.id AND pt.team_id = ?)', q.teamId);
    if (q.memberId)
      w.add(
        `(EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.member_id = ?)
          OR EXISTS (SELECT 1 FROM project_teams pt JOIN team_members tm ON tm.team_id = pt.team_id WHERE pt.project_id = p.id AND tm.member_id = ?))`,
        q.memberId,
        q.memberId,
      );
    w.raw(q.archived ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL');
    if (q.search) w.add('(p.name ILIKE ? OR p.code ILIKE ?)', `%${q.search}%`, `%${q.search}%`);
    const total = (await db.one(`SELECT count(*) AS n FROM projects p ${w.sql}`, w.params)).n;
    const pc = pageClause(q, { name: 'lower(p.name)', createdAt: 'p.created_at', deadline: 'p.deadline', priority: 'p.priority', status: 'p.status' }, 'createdAt');
    const rows = await db.many(
      `SELECT p.*, cl.name AS client_name,
         (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.parent_task_id IS NULL AND t.deleted_at IS NULL) AS task_total,
         (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.parent_task_id IS NULL AND t.deleted_at IS NULL AND t.completed_at IS NOT NULL) AS task_done,
         (SELECT coalesce(sum(e.duration_seconds), 0) FROM time_entries e WHERE e.project_id = p.id AND e.deleted_at IS NULL AND e.status <> 'rejected') AS tracked_seconds,
         (SELECT count(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count
       FROM projects p LEFT JOIN clients cl ON cl.id = p.client_id
       ${w.sql} ${pc.orderBy} LIMIT ${pc.limit} OFFSET ${pc.offset}`,
      w.params,
    );
    const money = canSeeMoney(ctx);
    ok(
      res,
      rows.map((p) => {
        const progress = progressOf(p, p.task_total, p.task_done);
        const dto = projectDto(p, {
          progress,
          completionPercent: progress,
          tasksTotal: p.task_total,
          tasksDone: p.task_done,
          totalHours: hours(p.tracked_seconds),
          memberCount: p.member_count,
        });
        if (!money) dto.hourlyRate = null;
        return dto;
      }),
      pageMeta(q, total),
    );
  },
);

r.post(
  '/',
  {
    summary: 'Create project',
    ids: 'PROJ-01,PROJ-05..15',
    permission: 'projects.create',
    body: z.object({
      ...projectFields,
      members: z.array(memberItem).optional(),
      teamIds: z.array(z.uuid()).optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    checkDates(b);
    await assertClient(ctx.orgId, b.clientId);
    const teamIds = await assertTeams(ctx.orgId, b.teamIds ?? []);
    const { project, added } = await db.tx(async () => {
      const cols = ['organization_id', 'created_by'];
      const vals = [ctx.orgId, ctx.memberId ?? null];
      for (const [f, col] of Object.entries(FIELD_MAP)) {
        if (b[f] === undefined) continue;
        cols.push(col);
        vals.push(b[f]);
      }
      const p = await db.one(
        `INSERT INTO projects (${cols.join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
        vals,
      );
      await seedColumns(ctx.orgId, p.id);
      const members = [...(b.members ?? [])];
      if (ctx.memberId) {
        const self = members.find((m) => m.memberId === ctx.memberId);
        if (self) self.role = 'manager';
        else members.unshift({ memberId: ctx.memberId, role: 'manager' });
      }
      const added = await replaceMembers(ctx, p.id, members);
      for (const t of teamIds) await db.query('INSERT INTO project_teams (project_id, team_id) VALUES ($1,$2)', [p.id, t]);
      await logActivity(ctx, 'project', p.id, 'created', { name: p.name });
      return { project: p, added };
    });
    ctx.cache?.clear();
    await notifyAdded(ctx, project, added);
    const dto = projectDto(project, { progress: 0, completionPercent: 0, members: await projectMembers(project.id), teams: await teamsOf(project.id) });
    await publish('project.created', { orgId: ctx.orgId, project: dto });
    created(res, dto);
  },
);

// ───────────────────────── detail / update / delete ─────────────────────────
r.get('/:id', { summary: 'Get project', ids: 'PROJ-16,PROJ-18,PROJ-25', permission: 'projects.view', params: uuidParam }, async (req, res) => {
  const ctx = req.ctx;
  const p = await getProjectFor(ctx, req.v.params.id);
  const tz = ctx.orgTimezone ?? 'UTC';
  const [prog, totals] = await Promise.all([projectProgress(p), projectTotals(ctx.orgId, p.id, { tz })]);
  const money = canSeeMoney(ctx);
  const budget = budgetUsage(p, totals);
  const dto = projectDto(p, {
    progress: prog.progress,
    completionPercent: prog.progress,
    tasksTotal: prog.tasksTotal,
    tasksDone: prog.tasksDone,
    totalHours: hours(totals.seconds),
    billableHours: hours(totals.billableSeconds),
    budget: money || p.budget_type === 'hours' ? budget : { ...budget, used: null, remaining: null },
    members: await projectMembers(p.id),
    teams: await teamsOf(p.id),
  });
  if (!money) {
    dto.hourlyRate = null;
    dto.members = dto.members.map((m) => ({ ...m, billableRate: null }));
  }
  ok(res, dto);
});

r.patch(
  '/:id',
  {
    summary: 'Update project',
    ids: 'PROJ-02,PROJ-27',
    permission: 'projects.update',
    params: uuidParam,
    body: z.object({ ...projectFields, name: projectFields.name.optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    const p = await getProjectFor(ctx, req.v.params.id, 'projects.update');
    checkDates({ startDate: b.startDate === undefined ? p.start_date : b.startDate, deadline: b.deadline === undefined ? p.deadline : b.deadline });
    if (b.clientId !== undefined) await assertClient(ctx.orgId, b.clientId);
    const sets = [];
    const vals = [];
    for (const [f, col] of Object.entries(FIELD_MAP)) {
      if (b[f] === undefined) continue;
      vals.push(b[f]);
      sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) throw badRequest('Nothing to update');
    const budgetChanged =
      (b.budgetType !== undefined && b.budgetType !== p.budget_type) ||
      (b.budgetValue !== undefined && Number(b.budgetValue ?? -1) !== Number(p.budget_value ?? -1));
    if (budgetChanged) sets.push(`budget_alerts_sent = '{}'`);
    vals.push(p.id, ctx.orgId);
    const updated = await db.one(
      `UPDATE projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length - 1} AND organization_id = $${vals.length} RETURNING *`,
      vals,
    );
    const before = Object.fromEntries(Object.entries(FIELD_MAP).map(([f, col]) => [f, p[col] === null ? null : String(p[col])]));
    const after = Object.fromEntries(Object.keys(b).filter((k) => FIELD_MAP[k]).map((k) => [k, b[k] === null ? null : String(b[k])]));
    const d = diff(before, after);
    if (b.status && b.status !== p.status) {
      await logActivity(ctx, 'project', p.id, 'status_changed', { from: p.status, to: b.status });
      const recipients = (await projectAllMemberIds(p.id)).filter((id) => id !== ctx.memberId);
      if (recipients.length)
        await notify({
          orgId: ctx.orgId,
          memberIds: recipients,
          type: 'project.status',
          title: `Project ${updated.name} is now ${b.status.replace('_', ' ')}`,
          body: `Status changed from ${p.status.replace('_', ' ')} to ${b.status.replace('_', ' ')}.`,
          link: `/projects/${p.id}`,
          data: { projectId: p.id, from: p.status, to: b.status },
        });
    }
    if (d.changed) {
      const { status: _s, ...rest } = d.after;
      if (Object.keys(rest).length) await logActivity(ctx, 'project', p.id, 'updated', { before: d.before, after: d.after });
    }
    updated.client_name = p.client_id === updated.client_id ? p.client_name : null;
    const prog = await projectProgress(updated);
    const dto = projectDto(updated, { progress: prog.progress, completionPercent: prog.progress });
    await publish('project.updated', { orgId: ctx.orgId, project: dto, changes: d.after });
    ok(res, dto);
  },
);

r.delete(
  '/:id',
  {
    summary: 'Delete project (soft)',
    ids: 'PROJ-03',
    permission: 'projects.delete',
    params: uuidParam,
    query: z.object({ force: zBool.optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const p = await getProjectFor(ctx, req.v.params.id, 'projects.delete');
    const billed = await db.one(
      `SELECT count(*) AS n FROM time_entries WHERE project_id = $1 AND deleted_at IS NULL AND (status = 'approved' OR invoice_id IS NOT NULL)`,
      [p.id],
    );
    if (billed.n > 0) {
      if (!req.v.query.force) throw conflict('PROJECT_HAS_BILLED_TIME', 'Project has approved or invoiced time entries', { entries: billed.n });
      if (!ctx.isOwner()) throw forbidden('Only the organization owner can force-delete a project with approved or invoiced time');
    }
    await db.query('UPDATE projects SET deleted_at = now(), updated_at = now() WHERE id = $1', [p.id]);
    await logActivity(ctx, 'project', p.id, 'deleted', { name: p.name, forced: !!req.v.query.force });
    await audit(ctx, 'project.deleted', { entityType: 'project', entityId: p.id, before: { name: p.name }, after: { forced: !!req.v.query.force } });
    await publish('project.deleted', { orgId: ctx.orgId, project: { id: p.id, name: p.name } });
    noContent(res);
  },
);

for (const action of ['archive', 'unarchive']) {
  r.post(`/:id/${action}`, { summary: `${action === 'archive' ? 'Archive' : 'Unarchive'} project`, ids: 'PROJ-04', permission: 'projects.archive', params: uuidParam }, async (req, res) => {
    const ctx = req.ctx;
    const p = await getProjectFor(ctx, req.v.params.id, 'projects.archive');
    const u = await db.one(
      `UPDATE projects SET archived_at = ${action === 'archive' ? 'coalesce(archived_at, now())' : 'NULL'}, updated_at = now() WHERE id = $1 RETURNING *`,
      [p.id],
    );
    u.client_name = p.client_name;
    await logActivity(ctx, 'project', p.id, action === 'archive' ? 'archived' : 'unarchived', null);
    const dto = projectDto(u);
    await publish(action === 'archive' ? 'project.archived' : 'project.updated', { orgId: ctx.orgId, project: dto });
    ok(res, dto);
  });
}

// ───────────────────────── members / teams ─────────────────────────
r.put('/:id/members', { summary: 'Replace project members', ids: 'PROJ-12,PROJ-14', permission: 'projects.update', params: uuidParam, body: membersBody }, async (req, res) => {
  const ctx = req.ctx;
  const p = await getProjectFor(ctx, req.v.params.id, 'projects.update');
  const added = await db.tx(() => replaceMembers(ctx, p.id, req.body));
  await logActivity(ctx, 'project', p.id, 'members_updated', { members: req.body.map((m) => ({ memberId: m.memberId, role: m.role })) });
  await notifyAdded(ctx, p, added);
  ctx.cache?.clear();
  await publish('project.updated', { orgId: ctx.orgId, project: projectDto(p), changes: { members: true } });
  ok(res, await projectMembers(p.id));
});

r.put(
  '/:id/teams',
  { summary: 'Replace project teams', ids: 'PROJ-13', permission: 'projects.update', params: uuidParam, body: z.object({ teamIds: z.array(z.uuid()) }) },
  async (req, res) => {
    const ctx = req.ctx;
    const p = await getProjectFor(ctx, req.v.params.id, 'projects.update');
    const ids = await assertTeams(ctx.orgId, req.body.teamIds);
    await db.tx(async () => {
      await db.query('DELETE FROM project_teams WHERE project_id = $1', [p.id]);
      for (const t of ids) await db.query('INSERT INTO project_teams (project_id, team_id) VALUES ($1,$2)', [p.id, t]);
    });
    await logActivity(ctx, 'project', p.id, 'teams_updated', { teamIds: ids });
    await publish('project.updated', { orgId: ctx.orgId, project: projectDto(p), changes: { teams: true } });
    ok(res, await teamsOf(p.id));
  },
);

// ───────────────────────── stats / performance / activity ─────────────────────────
r.get(
  '/:id/stats',
  { summary: 'Project statistics', ids: 'PROJ-17,PROJ-18,PROJ-10,PROJ-16', permission: 'projects.view', params: uuidParam, query: z.object({ from: dateStr.optional(), to: dateStr.optional() }) },
  async (req, res) => {
    const ctx = req.ctx;
    const { from, to } = req.v.query;
    if (from && to && to < from) throw badRequest('"to" must be on or after "from"', undefined, 'INVALID_DATES');
    const p = await getProjectFor(ctx, req.v.params.id);
    const tz = ctx.orgTimezone ?? 'UTC';
    const [range, allTime, prog] = await Promise.all([
      projectTotals(ctx.orgId, p.id, { from, to, tz }),
      from || to ? projectTotals(ctx.orgId, p.id, { tz }) : null,
      projectProgress(p),
    ]);
    const money = canSeeMoney(ctx);
    const memberIds = [...range.perMember.keys()];
    const taskIds = [...range.perTask.keys()];
    const names = memberIds.length
      ? await db.many(
          `SELECT m.id, u.first_name, u.last_name, u.avatar_key FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.id = ANY($1::uuid[])`,
          [memberIds],
        )
      : [];
    const titles = taskIds.length ? await db.many(`SELECT id, title, estimated_hours FROM tasks WHERE id = ANY($1::uuid[])`, [taskIds]) : [];
    const budget = budgetUsage(p, allTime ?? range);
    ok(res, {
      projectId: p.id,
      from: from ?? null,
      to: to ?? null,
      totalHours: hours(range.seconds),
      billableHours: hours(range.billableSeconds),
      nonBillableHours: hours(range.seconds - range.billableSeconds),
      cost: money ? range.cost : null,
      revenue: money ? range.revenue : null,
      profit: money ? r2(range.revenue - range.cost) : null,
      currency: p.currency ?? ctx.currency ?? null,
      budget: money || p.budget_type === 'hours' ? budget : { ...budget, used: null, remaining: null },
      progress: prog.progress,
      completionPercent: prog.progress,
      tasksTotal: prog.tasksTotal,
      tasksDone: prog.tasksDone,
      perMember: memberIds
        .map((id) => {
          const m = range.perMember.get(id);
          const n = names.find((x) => x.id === id);
          return {
            memberId: id,
            name: n ? `${n.first_name} ${n.last_name}`.trim() : null,
            avatarUrl: signedGetUrl(n?.avatar_key),
            hours: hours(m.seconds),
            billableHours: hours(m.billableSeconds),
            cost: money ? r2(m.cost) : null,
            revenue: money ? r2(m.revenue) : null,
          };
        })
        .sort((a, b) => b.hours - a.hours),
      perTask: taskIds
        .map((id) => {
          const t = range.perTask.get(id);
          const x = titles.find((y) => y.id === id);
          return { taskId: id, title: x?.title ?? null, hours: hours(t.seconds), billableHours: hours(t.billableSeconds), estimatedHours: num(x?.estimated_hours) };
        })
        .sort((a, b) => b.hours - a.hours),
    });
  },
);

r.get('/:id/members/performance', { summary: 'Project-wise employee performance', ids: 'PROJ-24', permission: 'projects.view', params: uuidParam, query: z.object({ from: dateStr.optional(), to: dateStr.optional() }) }, async (req, res) => {
  const ctx = req.ctx;
  const p = await getProjectFor(ctx, req.v.params.id);
  const { from, to } = req.v.query;
  const tz = ctx.orgTimezone ?? 'UTC';
  const totals = await projectTotals(ctx.orgId, p.id, { from, to, tz });
  const memberIds = [...new Set([...(await projectAllMemberIds(p.id)), ...totals.perMember.keys()])];
  if (!memberIds.length) return ok(res, []);
  const people = await db.many(
    `SELECT m.id, u.first_name, u.last_name, u.avatar_key, pm.role FROM organization_members m JOIN users u ON u.id = m.user_id
     LEFT JOIN project_members pm ON pm.project_id = $2 AND pm.member_id = m.id
     WHERE m.id = ANY($1::uuid[]) AND m.deleted_at IS NULL`,
    [memberIds, p.id],
  );
  const taskStats = await db.many(
    `SELECT ta.member_id,
       count(*) AS assigned,
       count(*) FILTER (WHERE t.completed_at IS NOT NULL) AS completed,
       count(*) FILTER (WHERE t.completed_at IS NOT NULL AND t.due_date IS NOT NULL) AS completed_with_due,
       count(*) FILTER (WHERE t.completed_at IS NOT NULL AND t.due_date IS NOT NULL AND (t.completed_at AT TIME ZONE $2::text)::date <= t.due_date) AS on_time
     FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
     WHERE t.project_id = $1 AND t.deleted_at IS NULL GROUP BY ta.member_id`,
    [p.id, tz],
  );
  ok(
    res,
    people
      .map((m) => {
        const t = totals.perMember.get(m.id) ?? { seconds: 0, activeSeconds: 0, billableSeconds: 0 };
        const s = taskStats.find((x) => x.member_id === m.id) ?? { assigned: 0, completed: 0, completed_with_due: 0, on_time: 0 };
        return {
          memberId: m.id,
          name: `${m.first_name} ${m.last_name}`.trim(),
          avatarUrl: signedGetUrl(m.avatar_key),
          projectRole: m.role ?? null,
          hours: hours(t.seconds),
          billableHours: hours(t.billableSeconds),
          tasksAssigned: s.assigned,
          tasksCompleted: s.completed,
          onTimeRate: s.completed_with_due ? Math.round((s.on_time / s.completed_with_due) * 100) : null,
          avgActivity: t.seconds ? Math.round((t.activeSeconds / t.seconds) * 100) : null,
        };
      })
      .sort((a, b) => b.hours - a.hours),
  );
});

r.get('/:id/activity', { summary: 'Project activity history', ids: 'PROJ-19', permission: 'projects.view', params: uuidParam, query: paginationQuery }, async (req, res) => {
  const ctx = req.ctx;
  const p = await getProjectFor(ctx, req.v.params.id);
  const q = req.v.query;
  const cond = `a.organization_id = $1 AND ((a.entity_type = 'project' AND a.entity_id = $2)
     OR (a.entity_type = 'task' AND a.entity_id IN (SELECT id FROM tasks WHERE project_id = $2)))`;
  const total = (await db.one(`SELECT count(*) AS n FROM activity_log a WHERE ${cond}`, [ctx.orgId, p.id])).n;
  const rows = await db.many(
    `SELECT a.*, u.first_name, u.last_name, u.avatar_key FROM activity_log a
     LEFT JOIN organization_members m ON m.id = a.actor_member_id LEFT JOIN users u ON u.id = m.user_id
     WHERE ${cond} ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`,
    [ctx.orgId, p.id, q.limit, (q.page - 1) * q.limit],
  );
  ok(res, rows.map(activityDto), pageMeta(q, total));
});

// ───────────────────────── notes (PROJ-22) ─────────────────────────
const noteDto = (n) => ({
  id: n.id,
  projectId: n.project_id,
  title: n.title,
  body: n.body,
  isPinned: n.is_pinned,
  author: n.author_member_id ? { memberId: n.author_member_id, name: `${n.first_name ?? ''} ${n.last_name ?? ''}`.trim() } : null,
  createdAt: n.created_at,
  updatedAt: n.updated_at,
});
const NOTE_SELECT = `SELECT n.*, u.first_name, u.last_name FROM project_notes n
  LEFT JOIN organization_members m ON m.id = n.author_member_id LEFT JOIN users u ON u.id = m.user_id`;
const noteParams = z.object({ id: z.uuid(), noteId: z.uuid() });

async function loadNote(ctx, projectId, noteId) {
  const n = await db.one(`${NOTE_SELECT} WHERE n.id = $1 AND n.project_id = $2 AND n.organization_id = $3`, [noteId, projectId, ctx.orgId]);
  if (!n) throw notFound('Note');
  return n;
}

r.get('/:id/notes', { summary: 'List project notes', ids: 'PROJ-22', permission: 'projects.view', params: uuidParam }, async (req, res) => {
  const p = await getProjectFor(req.ctx, req.v.params.id);
  const rows = await db.many(`${NOTE_SELECT} WHERE n.project_id = $1 AND n.organization_id = $2 ORDER BY n.is_pinned DESC, n.created_at DESC`, [p.id, req.ctx.orgId]);
  ok(res, rows.map(noteDto));
});

r.post(
  '/:id/notes',
  {
    summary: 'Create project note',
    ids: 'PROJ-22',
    permission: 'projects.update',
    params: uuidParam,
    body: z.object({ title: z.string().trim().max(200).nullable().optional(), body: z.string().trim().min(1).max(50000), isPinned: z.boolean().optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const p = await getProjectFor(ctx, req.v.params.id, 'projects.update');
    const n = await db.one(
      `INSERT INTO project_notes (organization_id, project_id, author_member_id, title, body, is_pinned) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ctx.orgId, p.id, ctx.memberId ?? null, req.body.title ?? null, req.body.body, req.body.isPinned ?? false],
    );
    await logActivity(ctx, 'project', p.id, 'note_added', { noteId: n.id });
    created(res, noteDto(await loadNote(ctx, p.id, n.id)));
  },
);

r.patch(
  '/:id/notes/:noteId',
  {
    summary: 'Update project note',
    ids: 'PROJ-22',
    permission: 'projects.update',
    params: noteParams,
    body: z.object({ title: z.string().trim().max(200).nullable().optional(), body: z.string().trim().min(1).max(50000).optional(), isPinned: z.boolean().optional() }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const p = await getProjectFor(ctx, req.v.params.id, 'projects.update');
    const n = await loadNote(ctx, p.id, req.v.params.noteId);
    const b = req.body;
    await db.query(
      `UPDATE project_notes SET title = $2, body = $3, is_pinned = $4, updated_at = now() WHERE id = $1`,
      [n.id, b.title === undefined ? n.title : b.title, b.body ?? n.body, b.isPinned ?? n.is_pinned],
    );
    ok(res, noteDto(await loadNote(ctx, p.id, n.id)));
  },
);

r.delete('/:id/notes/:noteId', { summary: 'Delete project note', ids: 'PROJ-22', permission: 'projects.update', params: noteParams }, async (req, res) => {
  const ctx = req.ctx;
  const p = await getProjectFor(ctx, req.v.params.id, 'projects.update');
  const n = await loadNote(ctx, p.id, req.v.params.noteId);
  await db.query('DELETE FROM project_notes WHERE id = $1', [n.id]);
  await logActivity(ctx, 'project', p.id, 'note_deleted', { noteId: n.id });
  noContent(res);
});

export default r;
