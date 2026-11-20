import { z } from 'zod';
import { createRouter, zColor, zCsvUuids, zBool } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, noContent, paginationQuery, pageMeta } from '../../lib/http.js';
import { badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { emitToOrg } from '../../lib/realtime.js';
import { accessibleProjectIds } from '../../rbac/scope.js';
import {
  managedTeamIds,
  getTeam,
  assertTeamManage,
  assertOrgMembers,
  assertOrgRows,
  resolveRange,
  summariesByMember,
  metrics,
  sumRows,
  visibleTeamMemberIds,
  realDate,
} from './service.js';

const r = createRouter('/teams', 'Teams');

const teamDto = (t) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  color: t.color,
  department: t.department_id ? { id: t.department_id, name: t.department_name ?? null } : null,
  workScheduleId: t.work_schedule_id,
  workScheduleName: t.work_schedule_name ?? null,
  memberCount: t.member_count ?? 0,
  leaders: t.leaders ?? [],
  managers: t.managers ?? [],
  createdAt: t.created_at,
  updatedAt: t.updated_at,
});

const TEAM_SELECT = `
  SELECT t.*, d.name AS department_name, ws.name AS work_schedule_name,
    (SELECT count(*)::int FROM team_members tm JOIN organization_members m ON m.id = tm.member_id
      WHERE tm.team_id = t.id AND m.deleted_at IS NULL) AS member_count,
    coalesce((SELECT json_agg(json_build_object('id', m.id, 'name', trim(u.first_name || ' ' || u.last_name)) ORDER BY u.first_name)
      FROM team_members tm JOIN organization_members m ON m.id = tm.member_id JOIN users u ON u.id = m.user_id
      WHERE tm.team_id = t.id AND tm.is_leader AND m.deleted_at IS NULL), '[]') AS leaders,
    coalesce((SELECT json_agg(json_build_object('id', m.id, 'name', trim(u.first_name || ' ' || u.last_name)) ORDER BY u.first_name)
      FROM team_managers tg JOIN organization_members m ON m.id = tg.member_id JOIN users u ON u.id = m.user_id
      WHERE tg.team_id = t.id AND m.deleted_at IS NULL), '[]') AS managers
  FROM teams t
  LEFT JOIN departments d ON d.id = t.department_id AND d.deleted_at IS NULL
  LEFT JOIN work_schedules ws ON ws.id = t.work_schedule_id`;

async function loadTeam(orgId, id) {
  await getTeam(orgId, id);
  return db.one(`${TEAM_SELECT} WHERE t.id = $1`, [id]);
}

const SORT = { name: 'lower(t.name)', createdAt: 't.created_at', memberCount: 'member_count' };

r.get(
  '/',
  {
    summary: 'List teams',
    ids: 'TEAM-02, TEAM-12',
    permission: ['teams.view', 'teams.manage'],
    query: paginationQuery.extend({ departmentId: z.uuid().optional(), memberId: z.uuid().optional(), managed: zBool.optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    const params = [req.ctx.orgId];
    const conds = ['t.organization_id = $1', 't.deleted_at IS NULL'];
    const add = (sql, v) => {
      params.push(v);
      conds.push(sql.replace('?', `$${params.length}`));
    };
    if (q.search) add('t.name ILIKE ?', `%${q.search}%`);
    if (q.departmentId) add('t.department_id = ?', q.departmentId);
    if (q.memberId) add('t.id IN (SELECT team_id FROM team_members WHERE member_id = ?)', q.memberId);
    if (q.managed) add('t.id = ANY(?::uuid[])', await managedTeamIds(req.ctx));
    const whereSql = `WHERE ${conds.join(' AND ')}`;
    const total = (await db.one(`SELECT count(*)::int AS n FROM teams t ${whereSql}`, params)).n;
    const sort = SORT[q.sort] ?? SORT.name;
    const dir = q.sort ? (q.order === 'asc' ? 'ASC' : 'DESC') : 'ASC';
    const rows = await db.many(`${TEAM_SELECT} ${whereSql} ORDER BY ${sort} ${dir} LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, params);
    ok(res, rows.map(teamDto), pageMeta(q, total));
  },
);

const teamBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  departmentId: z.uuid().nullable().optional(),
  workScheduleId: z.uuid().nullable().optional(),
  color: zColor.nullable().optional(),
  memberIds: z.array(z.uuid()).max(500).optional(),
  leaderIds: z.array(z.uuid()).max(50).optional(),
  managerIds: z.array(z.uuid()).max(50).optional(),
});

async function validateRefs(ctx, b) {
  if (b.departmentId) await assertOrgRows('departments', ctx.orgId, [b.departmentId], 'departmentId');
  if (b.workScheduleId) await assertOrgRows('work_schedules', ctx.orgId, [b.workScheduleId], 'workScheduleId', { softDelete: false });
}

// Comparison must be registered before '/:id'.
r.get(
  '/compare',
  {
    summary: 'Compare teams (hours, activity, productivity)',
    ids: 'TEAM-10',
    permission: ['teams.view', 'teams.manage'],
    query: z.object({ teamIds: zCsvUuids, from: realDate.optional(), to: realDate.optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    if (q.teamIds.length < 1 || q.teamIds.length > 20) throw badRequest('Provide 1–20 teamIds', [{ path: 'query.teamIds', message: '1–20 ids' }], 'VALIDATION_ERROR');
    const range = resolveRange(q, req.ctx.timezone);
    const perm = req.ctx.can('reports.view') ? 'reports.view' : 'time.view';
    const out = [];
    for (const teamId of [...new Set(q.teamIds)]) {
      const team = await getTeam(req.ctx.orgId, teamId);
      const ids = await visibleTeamMemberIds(req.ctx, teamId, perm);
      const rows = await summariesByMember(req.ctx.orgId, ids, range.from, range.to);
      const totals = metrics(sumRows(rows));
      const n = ids.length || 1;
      out.push({
        team: { id: team.id, name: team.name, color: team.color },
        memberCount: ids.length,
        ...totals,
        avgTrackedSecondsPerMember: Math.round(totals.trackedSeconds / n),
      });
    }
    ok(res, { from: range.from, to: range.to, teams: out });
  },
);

r.post('/', { summary: 'Create team', ids: 'TEAM-02, TEAM-04, TEAM-05, TEAM-11', permission: 'teams.manage', body: teamBody }, async (req, res) => {
  req.ctx.require('teams.manage', 'org');
  const b = req.body;
  await validateRefs(req.ctx, b);
  const memberIds = await assertOrgMembers(req.ctx.orgId, [...(b.memberIds ?? []), ...(b.leaderIds ?? [])]);
  const managerIds = await assertOrgMembers(req.ctx.orgId, b.managerIds ?? [], 'managerIds');
  const leaders = new Set(b.leaderIds ?? []);
  const t = await db.tx(async () => {
    const team = await db.one(
      `INSERT INTO teams (organization_id, name, description, department_id, work_schedule_id, color) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.ctx.orgId, b.name, b.description ?? null, b.departmentId ?? null, b.workScheduleId ?? null, b.color ?? null],
    );
    for (const m of memberIds) await db.query('INSERT INTO team_members (team_id, member_id, is_leader) VALUES ($1,$2,$3)', [team.id, m, leaders.has(m)]);
    for (const m of managerIds) await db.query('INSERT INTO team_managers (team_id, member_id) VALUES ($1,$2)', [team.id, m]);
    return team;
  });
  await audit(req.ctx, 'team.created', { entityType: 'team', entityId: t.id, after: { name: b.name } });
  created(res, teamDto(await loadTeam(req.ctx.orgId, t.id)));
});

r.get('/:id', { summary: 'Team detail with members, managers and projects', ids: 'TEAM-02', permission: ['teams.view', 'teams.manage'], params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const t = await loadTeam(req.ctx.orgId, req.v.params.id);
  const members = await db.many(
    `SELECT m.id, u.email, trim(u.first_name || ' ' || u.last_name) AS name, u.avatar_key, m.designation, m.status, m.employee_code,
            tm.is_leader, tm.joined_at, r.name AS role_name, r.slug AS role_slug
     FROM team_members tm JOIN organization_members m ON m.id = tm.member_id JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
     WHERE tm.team_id = $1 AND m.deleted_at IS NULL ORDER BY tm.is_leader DESC, lower(u.first_name)`,
    [t.id],
  );
  const projects = await db.many(
    `SELECT p.id, p.name, p.status, p.color FROM project_teams pt JOIN projects p ON p.id = pt.project_id
     WHERE pt.team_id = $1 AND p.deleted_at IS NULL ORDER BY lower(p.name)`,
    [t.id],
  );
  const canManage = req.ctx.can('teams.manage') === 'org' || (!!req.ctx.can('teams.manage') && (await managedTeamIds(req.ctx)).includes(t.id));
  ok(res, {
    ...teamDto(t),
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      designation: m.designation,
      status: m.status,
      employeeCode: m.employee_code,
      isLeader: m.is_leader,
      joinedAt: m.joined_at,
      role: { name: m.role_name, slug: m.role_slug },
    })),
    projects,
    canManage,
  });
});

r.patch('/:id', { summary: 'Edit team', ids: 'TEAM-03, TEAM-11', permission: 'teams.manage', params: z.object({ id: z.uuid() }), body: teamBody.omit({ memberIds: true, leaderIds: true, managerIds: true }).partial() }, async (req, res) => {
  const before = await assertTeamManage(req.ctx, req.v.params.id);
  const b = req.body;
  await validateRefs(req.ctx, b);
  await db.query(
    `UPDATE teams SET name = coalesce($2, name),
       description = CASE WHEN $3::boolean THEN $4 ELSE description END,
       department_id = CASE WHEN $5::boolean THEN $6::uuid ELSE department_id END,
       work_schedule_id = CASE WHEN $7::boolean THEN $8::uuid ELSE work_schedule_id END,
       color = CASE WHEN $9::boolean THEN $10 ELSE color END,
       updated_at = now()
     WHERE id = $1`,
    [before.id, b.name ?? null, b.description !== undefined, b.description ?? null, b.departmentId !== undefined, b.departmentId ?? null, b.workScheduleId !== undefined, b.workScheduleId ?? null, b.color !== undefined, b.color ?? null],
  );
  await audit(req.ctx, 'team.updated', { entityType: 'team', entityId: before.id, before: { name: before.name, departmentId: before.department_id, workScheduleId: before.work_schedule_id }, after: b });
  ok(res, teamDto(await loadTeam(req.ctx.orgId, before.id)));
});

r.delete('/:id', { summary: 'Delete team (soft)', ids: 'TEAM-03', permission: 'teams.manage', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const t = await assertTeamManage(req.ctx, req.v.params.id, 'org');
  await db.tx(async () => {
    await db.query('UPDATE teams SET deleted_at = now(), updated_at = now() WHERE id = $1', [t.id]);
    await db.query('DELETE FROM team_members WHERE team_id = $1', [t.id]);
    await db.query('DELETE FROM team_managers WHERE team_id = $1', [t.id]);
    await db.query('DELETE FROM project_teams WHERE team_id = $1', [t.id]);
  });
  await audit(req.ctx, 'team.deleted', { entityType: 'team', entityId: t.id, before: { name: t.name } });
  noContent(res);
});

// ─── Membership ────────────────────────────────────────────────────────────
r.post(
  '/:id/members',
  { summary: 'Add members to team (bulk)', ids: 'TEAM-05, EMP-09', permission: 'teams.manage', params: z.object({ id: z.uuid() }), body: z.object({ memberIds: z.array(z.uuid()).min(1).max(500), isLeader: z.boolean().optional() }) },
  async (req, res) => {
    const t = await assertTeamManage(req.ctx, req.v.params.id);
    const ids = await assertOrgMembers(req.ctx.orgId, req.body.memberIds);
    let added = 0;
    await db.tx(async () => {
      for (const m of ids) {
        const r0 = await db.query(
          `INSERT INTO team_members (team_id, member_id, is_leader) VALUES ($1,$2,$3)
           ON CONFLICT (team_id, member_id) DO ${req.body.isLeader === undefined ? 'NOTHING' : 'UPDATE SET is_leader = EXCLUDED.is_leader'}`,
          [t.id, m, req.body.isLeader ?? false],
        );
        added += r0.rowCount;
      }
    });
    await audit(req.ctx, 'team.members_added', { entityType: 'team', entityId: t.id, after: { memberIds: ids } });
    emitToOrg(req.ctx.orgId, 'team.updated', { teamId: t.id });
    ok(res, { added, team: teamDto(await loadTeam(req.ctx.orgId, t.id)) });
  },
);

r.delete(
  '/:id/members',
  { summary: 'Remove members from team (bulk)', ids: 'TEAM-06', permission: 'teams.manage', params: z.object({ id: z.uuid() }), body: z.object({ memberIds: z.array(z.uuid()).min(1).max(500) }) },
  async (req, res) => {
    const t = await assertTeamManage(req.ctx, req.v.params.id);
    const r0 = await db.query('DELETE FROM team_members WHERE team_id = $1 AND member_id = ANY($2::uuid[])', [t.id, req.body.memberIds]);
    await audit(req.ctx, 'team.members_removed', { entityType: 'team', entityId: t.id, before: { memberIds: req.body.memberIds } });
    ok(res, { removed: r0.rowCount });
  },
);

r.delete('/:id/members/:memberId', { summary: 'Remove a member from team', ids: 'TEAM-06', permission: 'teams.manage', params: z.object({ id: z.uuid(), memberId: z.uuid() }) }, async (req, res) => {
  const t = await assertTeamManage(req.ctx, req.v.params.id);
  const r0 = await db.query('DELETE FROM team_members WHERE team_id = $1 AND member_id = $2', [t.id, req.v.params.memberId]);
  if (!r0.rowCount) throw badRequest('Member is not in this team', undefined, 'NOT_A_TEAM_MEMBER');
  await audit(req.ctx, 'team.members_removed', { entityType: 'team', entityId: t.id, before: { memberIds: [req.v.params.memberId] } });
  noContent(res);
});

r.patch(
  '/:id/members/:memberId',
  { summary: 'Toggle team leader', ids: 'TEAM-04', permission: 'teams.manage', params: z.object({ id: z.uuid(), memberId: z.uuid() }), body: z.object({ isLeader: z.boolean() }) },
  async (req, res) => {
    const t = await assertTeamManage(req.ctx, req.v.params.id);
    const row = await db.one('UPDATE team_members SET is_leader = $3 WHERE team_id = $1 AND member_id = $2 RETURNING *', [t.id, req.v.params.memberId, req.body.isLeader]);
    if (!row) throw badRequest('Member is not in this team', undefined, 'NOT_A_TEAM_MEMBER');
    await audit(req.ctx, 'team.leader_changed', { entityType: 'team', entityId: t.id, after: { memberId: row.member_id, isLeader: row.is_leader } });
    ok(res, { teamId: t.id, memberId: row.member_id, isLeader: row.is_leader });
  },
);

r.put(
  '/:id/managers',
  { summary: 'Set team managers', ids: 'TEAM-04', permission: 'teams.manage', params: z.object({ id: z.uuid() }), body: z.object({ memberIds: z.array(z.uuid()).max(50) }) },
  async (req, res) => {
    const t = await assertTeamManage(req.ctx, req.v.params.id);
    const ids = await assertOrgMembers(req.ctx.orgId, req.body.memberIds);
    const before = (await db.many('SELECT member_id FROM team_managers WHERE team_id = $1', [t.id])).map((x) => x.member_id);
    await db.tx(async () => {
      await db.query('DELETE FROM team_managers WHERE team_id = $1', [t.id]);
      for (const m of ids) await db.query('INSERT INTO team_managers (team_id, member_id) VALUES ($1,$2)', [t.id, m]);
    });
    await audit(req.ctx, 'team.managers_set', { entityType: 'team', entityId: t.id, before: { memberIds: before }, after: { memberIds: ids } });
    ok(res, teamDto(await loadTeam(req.ctx.orgId, t.id)));
  },
);

r.put(
  '/:id/projects',
  { summary: 'Team-wise project assignment', ids: 'TEAM-13', permission: 'projects.update', params: z.object({ id: z.uuid() }), body: z.object({ projectIds: z.array(z.uuid()).max(500) }) },
  async (req, res) => {
    const t = await getTeam(req.ctx.orgId, req.v.params.id);
    if (req.ctx.can('teams.manage') !== 'org' && req.ctx.can('projects.update') !== 'org') await assertTeamManage(req.ctx, t.id);
    const ids = await assertOrgRows('projects', req.ctx.orgId, req.body.projectIds, 'projectIds');
    const current = (await db.many('SELECT project_id FROM project_teams WHERE team_id = $1', [t.id])).map((x) => x.project_id);
    const allowed = await accessibleProjectIds(req.ctx, 'projects.update');
    if (allowed) {
      const touched = [...ids.filter((p) => !current.includes(p)), ...current.filter((p) => !ids.includes(p))];
      if (touched.some((p) => !allowed.includes(p))) throw badRequest('You can only assign projects you manage', undefined, 'FORBIDDEN_PROJECT');
    }
    await db.tx(async () => {
      await db.query('DELETE FROM project_teams WHERE team_id = $1 AND NOT (project_id = ANY($2::uuid[]))', [t.id, ids]);
      for (const p of ids) await db.query('INSERT INTO project_teams (project_id, team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p, t.id]);
    });
    await audit(req.ctx, 'team.projects_set', { entityType: 'team', entityId: t.id, before: { projectIds: current }, after: { projectIds: ids } });
    const projects = await db.many(
      `SELECT p.id, p.name, p.status FROM project_teams pt JOIN projects p ON p.id = pt.project_id WHERE pt.team_id = $1 AND p.deleted_at IS NULL ORDER BY lower(p.name)`,
      [t.id],
    );
    ok(res, { teamId: t.id, projects });
  },
);

// ─── Stats (TEAM-07, TEAM-08) ──────────────────────────────────────────────
async function teamStats(req, res) {
  const t = await getTeam(req.ctx.orgId, req.v.params.id);
  const range = resolveRange(req.v.query, req.ctx.timezone);
  const perm = req.ctx.can('reports.view') ? 'reports.view' : 'time.view';
  const ids = await visibleTeamMemberIds(req.ctx, t.id, perm);
  const rows = await summariesByMember(req.ctx.orgId, ids, range.from, range.to);
  const names = ids.length
    ? await db.many(
        `SELECT m.id, trim(u.first_name || ' ' || u.last_name) AS name, m.designation, tm.is_leader
         FROM organization_members m JOIN users u ON u.id = m.user_id JOIN team_members tm ON tm.member_id = m.id AND tm.team_id = $2
         WHERE m.id = ANY($1::uuid[])`,
        [ids, t.id],
      )
    : [];
  const byId = new Map(rows.map((x) => [x.member_id, x]));
  const members = names
    .map((n) => ({ member: { id: n.id, name: n.name, designation: n.designation, isLeader: n.is_leader }, ...metrics(byId.get(n.id) ?? {}) }))
    .sort((a, b) => b.trackedSeconds - a.trackedSeconds);
  const daily = ids.length
    ? await db.many(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, sum(tracked_seconds)::int AS tracked_seconds, sum(active_seconds)::int AS active_seconds,
                sum(productive_seconds)::int AS productive_seconds, sum(unproductive_seconds)::int AS unproductive_seconds, sum(neutral_seconds)::int AS neutral_seconds
         FROM daily_summaries WHERE organization_id = $1 AND member_id = ANY($2::uuid[]) AND date BETWEEN $3::date AND $4::date
         GROUP BY date ORDER BY date`,
        [req.ctx.orgId, ids, range.from, range.to],
      )
    : [];
  ok(res, {
    team: { id: t.id, name: t.name },
    from: range.from,
    to: range.to,
    memberCount: ids.length,
    totals: metrics(sumRows(rows)),
    members,
    daily: daily.map((d) => ({ date: d.date, ...metrics(d) })),
  });
}

const statsOpts = (summary, ids) => ({
  summary,
  ids,
  permission: ['teams.view', 'teams.manage'],
  params: z.object({ id: z.uuid() }),
  query: z.object({ from: realDate.optional(), to: realDate.optional() }),
});
r.get('/:id/stats', statsOpts('Team stats: hours, activity, productivity, per-member rows', 'TEAM-07, TEAM-08, TEAM-09'), teamStats);
r.get('/:id/stats/hours', statsOpts('Team working hours', 'TEAM-07'), teamStats);
r.get('/:id/stats/productivity', statsOpts('Team productivity overview', 'TEAM-08'), teamStats);

export default r;
