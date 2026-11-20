import { z } from 'zod';
import { createRouter, zTimezone, zCurrency, zMoney, zBool } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { realDate } from '../teams/service.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit, diff } from '../../lib/audit.js';
import { publish } from '../../lib/events.js';
import { emitToUser } from '../../lib/realtime.js';
import { accessibleMemberIds, assertMemberAccess, getOrgMember } from '../../rbac/scope.js';
import { assertSeatsAvailable } from '../subscription/features.js';
import { assertAssignableRole, createInvitation } from '../invitations/routes.js';
import { stopTimer, getRunningEntry } from '../time/timer-service.js';
import {
  MEMBER_SELECT,
  memberDto,
  memberWithRates,
  currentRates,
  canSeeRates,
  loadMember,
  createMember,
  afterCreate,
  validateMemberRefs,
  assertTeamsInScope,
  setTeams,
  setManagers,
} from './service.js';

const r = createRouter('/members', 'Members');

const SORT = {
  name: 'lower(u.first_name || u.last_name)',
  email: 'u.email',
  employeeCode: 'm.employee_code',
  joinedOn: 'm.joined_on',
  createdAt: 'm.created_at',
  status: 'm.status',
  lastSeenAt: 'm.last_seen_at',
};

// ─── EMP-21 list / search ───────────────────────────────────────────────────
r.get(
  '/',
  {
    summary: 'List / search employees',
    ids: 'EMP-21, TEAM-12',
    permission: 'members.view',
    query: paginationQuery.extend({
      status: z.enum(['invited', 'active', 'inactive', 'suspended']).optional(),
      departmentId: z.uuid().optional(),
      teamId: z.uuid().optional(),
      managerId: z.uuid().optional(),
      employmentType: z.enum(['full_time', 'part_time', 'contract']).optional(),
      roleId: z.uuid().optional(),
      workMode: z.enum(['office', 'remote', 'hybrid']).optional(),
      includeClients: zBool.optional(),
    }),
  },
  async (req, res) => {
    const q = req.v.query;
    const ctx = req.ctx;
    const w = where([ctx.orgId]).raw('m.organization_id = $1 AND m.deleted_at IS NULL');
    const scoped = await accessibleMemberIds(ctx, 'members.view');
    if (scoped) w.add('m.id = ANY(?::uuid[])', scoped);
    w.add('m.status = ?', q.status);
    w.add('m.department_id = ?', q.departmentId);
    w.add('m.employment_type = ?', q.employmentType);
    w.add('m.role_id = ?', q.roleId);
    w.add('m.work_mode = ?', q.workMode);
    if (q.teamId) w.add('m.id IN (SELECT member_id FROM team_members WHERE team_id = ?)', q.teamId);
    if (q.managerId) w.add('m.id IN (SELECT member_id FROM member_managers WHERE manager_member_id = ?)', q.managerId);
    if (!q.includeClients && !q.roleId) w.raw(`r.base_role <> 'client'`);
    if (q.search)
      w.add(
        `(u.first_name || ' ' || u.last_name ILIKE ? OR u.email ILIKE ? OR m.employee_code ILIKE ? OR m.designation ILIKE ?)`,
        `%${q.search}%`,
        `%${q.search}%`,
        `%${q.search}%`,
        `%${q.search}%`,
      );
    const total = (await db.one(`SELECT count(*)::int AS n FROM organization_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id ${w.sql}`, w.params)).n;
    const sort = SORT[q.sort] ?? SORT.name;
    const dir = q.sort ? (q.order === 'asc' ? 'ASC' : 'DESC') : 'ASC';
    const rows = await db.many(`${MEMBER_SELECT} ${w.sql} ORDER BY ${sort} ${dir} NULLS LAST, m.id LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, w.params);
    let data;
    if (canSeeRates(ctx)) {
      const rates = await currentRates(rows.map((x) => x.id));
      data = rows.map((m) => memberDto(m, { rates: rates.get(m.id) ?? null }));
    } else data = rows.map((m) => memberDto(m));
    ok(res, data, pageMeta(q, total));
  },
);

// ─── EMP-01 add employee ────────────────────────────────────────────────────
const profileFields = {
  employeeCode: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, . _ - only'),
  designation: z.string().trim().max(120).nullable(),
  departmentId: z.uuid().nullable(),
  teamIds: z.array(z.uuid()).max(50),
  managerIds: z.array(z.uuid()).max(20),
  employmentType: z.enum(['full_time', 'part_time', 'contract']),
  joinedOn: realDate.nullable(),
  workScheduleId: z.uuid().nullable(),
  weeklyHours: z.number().min(0).max(168),
  weeklyLimitHours: z.number().min(1).max(168).nullable(),
  workMode: z.enum(['office', 'remote', 'hybrid']),
  timezone: zTimezone.nullable(),
  workEmail: z.email().max(254).nullable(),
  restrictions: z.record(z.string(), z.any()),
};

const createBody = z.object({
  email: z.email().max(254),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).default(''),
  roleId: z.uuid(),
  ...Object.fromEntries(Object.entries(profileFields).map(([k, v]) => [k, v.optional()])),
  hourlyRate: zMoney.optional(),
  currency: zCurrency.optional(),
});

r.post('/', { summary: 'Add employee (profile + invitation)', ids: 'EMP-01, EMP-05…EMP-16, SUB-17', permission: 'members.create', body: createBody }, async (req, res) => {
  const ctx = req.ctx;
  const b = req.body;
  if (ctx.can('members.create') !== 'org') {
    if (!b.teamIds?.length) throw forbidden('You can only add members into teams you manage');
    await assertTeamsInScope(ctx, 'members.create', b.teamIds);
  }
  if (b.hourlyRate !== undefined && !(ctx.can('payroll.manage') || ctx.can('billing.manage'))) throw forbidden('Setting a pay rate requires payroll.manage');
  const { member, invitation } = await createMember(ctx, b);
  await afterCreate(ctx, member);
  const full = await loadMember(ctx.orgId, member.id);
  created(res, { ...(await memberWithRates(ctx, full)), invitationId: invitation.id });
});

// ─── EMP-04 profile ─────────────────────────────────────────────────────────
r.get('/:id', { summary: 'Employee profile (assignments + summary stats)', ids: 'EMP-04, EMP-06', permission: 'members.view', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const ctx = req.ctx;
  const m = await loadMember(ctx.orgId, req.v.params.id);
  if (!m) throw notFound('Member');
  await assertMemberAccess(ctx, 'members.view', m.id);
  const tz = m.timezone || ctx.orgTimezone || 'UTC';
  const stats = await db.one(
    `SELECT
       coalesce(sum(tracked_seconds) FILTER (WHERE date = (now() AT TIME ZONE $2)::date), 0)::int AS today_seconds,
       coalesce(sum(tracked_seconds) FILTER (WHERE date >= date_trunc('week', (now() AT TIME ZONE $2))::date), 0)::int AS week_seconds,
       coalesce(sum(tracked_seconds) FILTER (WHERE date >= date_trunc('month', (now() AT TIME ZONE $2))::date), 0)::int AS month_seconds,
       coalesce(sum(tracked_seconds) FILTER (WHERE date > (now() AT TIME ZONE $2)::date - 30), 0)::int AS last30_tracked,
       coalesce(sum(active_seconds) FILTER (WHERE date > (now() AT TIME ZONE $2)::date - 30), 0)::int AS last30_active
     FROM daily_summaries WHERE member_id = $1`,
    [m.id, tz],
  );
  const projects = await db.many(
    `SELECT DISTINCT p.id, p.name, p.status FROM projects p
     WHERE p.deleted_at IS NULL AND p.organization_id = $2 AND (p.id IN (SELECT project_id FROM project_members WHERE member_id = $1)
       OR p.id IN (SELECT pt.project_id FROM project_teams pt JOIN team_members tm ON tm.team_id = pt.team_id WHERE tm.member_id = $1))
     ORDER BY p.name`,
    [m.id, ctx.orgId],
  );
  const invitation = await db.one(
    `SELECT id, status, expires_at, created_at FROM invitations WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [m.id],
  );
  const running = await getRunningEntry(m.id);
  ok(res, {
    ...(await memberWithRates(ctx, m)),
    projects,
    invitation: invitation ? { id: invitation.id, status: invitation.status, expiresAt: invitation.expires_at, createdAt: invitation.created_at } : null,
    stats: {
      todaySeconds: stats.today_seconds,
      weekSeconds: stats.week_seconds,
      monthSeconds: stats.month_seconds,
      last30DaysActivityPercent: stats.last30_tracked ? Math.round((stats.last30_active / stats.last30_tracked) * 100) : 0,
      timerRunning: !!running,
    },
  });
});

// ─── EMP-02 edit ────────────────────────────────────────────────────────────
const patchBody = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  ...Object.fromEntries(Object.entries(profileFields).map(([k, v]) => [k, v.optional()])),
});

const COLS = {
  employeeCode: 'employee_code',
  designation: 'designation',
  departmentId: 'department_id',
  employmentType: 'employment_type',
  joinedOn: 'joined_on',
  workScheduleId: 'work_schedule_id',
  weeklyHours: 'weekly_hours',
  weeklyLimitHours: 'weekly_limit_hours',
  workMode: 'work_mode',
  timezone: 'timezone',
  workEmail: 'work_email',
  restrictions: 'restrictions',
};

r.patch('/:id', { summary: 'Edit employee information', ids: 'EMP-02, EMP-05…EMP-15', permission: 'members.update', params: z.object({ id: z.uuid() }), body: patchBody }, async (req, res) => {
  const ctx = req.ctx;
  const before = await loadMember(ctx.orgId, req.v.params.id);
  if (!before) throw notFound('Member');
  await assertMemberAccess(ctx, 'members.update', before.id);
  if (before.role_level > (ctx.role?.level ?? 0) && before.id !== ctx.memberId) throw forbidden('You cannot edit a member with a higher role');
  const b = req.body;
  if (b.employeeCode === null) throw badRequest('employeeCode cannot be empty');
  await validateMemberRefs(ctx, b, before.id);
  if (b.teamIds) {
    const current = (before.teams ?? []).map((t) => t.id);
    const touched = [...b.teamIds.filter((t) => !current.includes(t)), ...current.filter((t) => !b.teamIds.includes(t))];
    await assertTeamsInScope(ctx, 'members.update', touched);
  }
  if (b.employeeCode && b.employeeCode !== before.employee_code) {
    const dup = await db.one('SELECT 1 FROM organization_members WHERE organization_id = $1 AND employee_code = $2 AND id <> $3', [ctx.orgId, b.employeeCode, before.id]);
    if (dup) throw conflict('EMPLOYEE_CODE_TAKEN', `Employee code ${b.employeeCode} is already in use`);
  }
  await db.tx(async () => {
    const sets = [];
    const params = [before.id];
    for (const [k, col] of Object.entries(COLS)) {
      if (b[k] === undefined) continue;
      params.push(k === 'restrictions' ? db.json(b[k]) : b[k]);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length) await db.query(`UPDATE organization_members SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    if (b.firstName !== undefined || b.lastName !== undefined) {
      // Only adjust the name of users who have not activated their account yet (profile owned by the org).
      await db.query(
        `UPDATE users SET first_name = coalesce($2, first_name), last_name = coalesce($3, last_name), updated_at = now() WHERE id = $1 AND password_hash IS NULL`,
        [before.user_id, b.firstName ?? null, b.lastName ?? null],
      );
    }
    if (b.teamIds) await setTeams(before.id, [...new Set(b.teamIds)]);
    if (b.managerIds) await setManagers(ctx.orgId, before.id, b.managerIds);
  });
  const after = await loadMember(ctx.orgId, before.id);
  const d = diff(memberDto(before), memberDto(after));
  if (d.changed) await audit(ctx, 'member.updated', { entityType: 'member', entityId: before.id, before: d.before, after: d.after });
  await publish('member.updated', { orgId: ctx.orgId, memberId: before.id, changes: Object.keys(d.after) });
  ok(res, await memberWithRates(ctx, after));
});

// ─── RBAC-09 role assignment ────────────────────────────────────────────────
async function activeOwnerCount(orgId, exceptId) {
  return (
    await db.one(
      `SELECT count(*)::int AS n FROM organization_members m JOIN roles r ON r.id = m.role_id
       WHERE m.organization_id = $1 AND r.base_role = 'owner' AND m.status = 'active' AND m.deleted_at IS NULL AND m.id <> $2`,
      [orgId, exceptId],
    )
  ).n;
}

r.patch('/:id/role', { summary: 'Assign role', ids: 'RBAC-09, EMP-02', permission: 'roles.manage', params: z.object({ id: z.uuid() }), body: z.object({ roleId: z.uuid() }) }, async (req, res) => {
  const ctx = req.ctx;
  const m = await loadMember(ctx.orgId, req.v.params.id);
  if (!m) throw notFound('Member');
  const role = await assertAssignableRole(ctx, req.body.roleId);
  if (m.role_level > (ctx.role?.level ?? 0)) throw forbidden('You cannot change the role of a member above your level');
  if (m.base_role === 'owner' && role.base_role !== 'owner' && (await activeOwnerCount(ctx.orgId, m.id)) === 0)
    throw conflict('LAST_OWNER', 'The organization must keep at least one owner. Transfer ownership first.');
  if ((m.base_role === 'client') !== (role.base_role === 'client')) {
    if (role.base_role !== 'client' && ['active', 'invited'].includes(m.status)) await assertSeatsAvailable(ctx.orgId, 1);
  }
  await db.query('UPDATE organization_members SET role_id = $2, updated_at = now() WHERE id = $1', [m.id, role.id]);
  await audit(ctx, 'member.role_changed', { entityType: 'member', entityId: m.id, before: { roleId: m.role_id, role: m.role_slug }, after: { roleId: role.id, role: role.slug } });
  await publish('member.updated', { orgId: ctx.orgId, memberId: m.id, changes: ['role'] });
  emitToUser(m.user_id, 'permissions.updated', { organizationId: ctx.orgId });
  ok(res, await memberWithRates(ctx, await loadMember(ctx.orgId, m.id)));
});

// ─── EMP-10 managers ────────────────────────────────────────────────────────
r.put('/:id/managers', { summary: 'Set managers (multiple)', ids: 'EMP-10', permission: 'members.update', params: z.object({ id: z.uuid() }), body: z.object({ managerIds: z.array(z.uuid()).max(20) }) }, async (req, res) => {
  const ctx = req.ctx;
  const m = await getOrgMember(ctx.orgId, req.v.params.id);
  await assertMemberAccess(ctx, 'members.update', m.id);
  await validateMemberRefs(ctx, { managerIds: req.body.managerIds }, m.id);
  const before = (await db.many('SELECT manager_member_id FROM member_managers WHERE member_id = $1', [m.id])).map((x) => x.manager_member_id);
  await db.tx(() => setManagers(ctx.orgId, m.id, req.body.managerIds));
  await audit(ctx, 'member.managers_set', { entityType: 'member', entityId: m.id, before: { managerIds: before }, after: { managerIds: req.body.managerIds } });
  const full = await loadMember(ctx.orgId, m.id);
  ok(res, { memberId: m.id, managers: full.managers });
});

// ─── EMP-16 rates ───────────────────────────────────────────────────────────
const rateDto = (x) => ({
  id: x.id,
  rateType: x.rate_type,
  amount: Number(x.amount),
  currency: x.currency.trim(),
  payType: x.pay_type,
  effectiveFrom: x.effective_from,
  effectiveTo: x.effective_to,
  createdAt: x.created_at,
});

async function assertRateScope(ctx, memberId, perms) {
  const perm = perms.find((p) => ctx.can(p));
  if (!perm) throw forbidden(`Missing permission: ${perms.join(' or ')}`);
  await assertMemberAccess(ctx, perm, memberId);
}

r.get(
  '/:id/rates',
  { summary: 'Rate history (effective-dated)', ids: 'EMP-16, PAY-01', permission: ['payroll.view', 'billing.view', 'payroll.manage', 'billing.manage'], params: z.object({ id: z.uuid() }), query: z.object({ rateType: z.enum(['pay', 'cost', 'billable']).optional() }) },
  async (req, res) => {
    const m = await getOrgMember(req.ctx.orgId, req.v.params.id);
    await assertRateScope(req.ctx, m.id, ['payroll.view', 'billing.view', 'payroll.manage', 'billing.manage']);
    const rows = await db.many(
      `SELECT * FROM member_rates WHERE member_id = $1 AND organization_id = $2 AND ($3::text IS NULL OR rate_type = $3) ORDER BY rate_type, effective_from DESC`,
      [m.id, req.ctx.orgId, req.v.query.rateType ?? null],
    );
    const current = {};
    const today = new Date().toISOString().slice(0, 10);
    for (const x of rows) if (!current[x.rate_type] && x.effective_from <= today && (!x.effective_to || x.effective_to > today)) current[x.rate_type] = rateDto(x);
    ok(res, { current, history: rows.map(rateDto) });
  },
);

r.post(
  '/:id/rates',
  {
    summary: 'Add rate (closes the previous open rate)',
    ids: 'EMP-16, PAY-01',
    permission: ['payroll.manage', 'billing.manage'],
    params: z.object({ id: z.uuid() }),
    body: z.object({
      rateType: z.enum(['pay', 'cost', 'billable']).default('pay'),
      amount: zMoney,
      currency: zCurrency.optional(),
      payType: z.enum(['hourly', 'monthly_salary']).default('hourly'),
      effectiveFrom: realDate,
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const b = req.body;
    const m = await getOrgMember(ctx.orgId, req.v.params.id);
    await assertRateScope(ctx, m.id, b.rateType === 'billable' ? ['billing.manage', 'payroll.manage'] : ['payroll.manage']);
    const currency = b.currency ?? (await db.one('SELECT default_currency FROM organizations WHERE id = $1', [ctx.orgId])).default_currency;
    const row = await db.tx(async () => {
      const later = await db.one(`SELECT id FROM member_rates WHERE member_id = $1 AND rate_type = $2 AND effective_from >= $3::date LIMIT 1`, [m.id, b.rateType, b.effectiveFrom]);
      if (later) throw conflict('RATE_OVERLAP', 'A rate already starts on or after this date. Choose a later effective date.');
      const closed = await db.one(
        `UPDATE member_rates SET effective_to = $3::date
         WHERE member_id = $1 AND rate_type = $2 AND effective_from < $3::date AND (effective_to IS NULL OR effective_to > $3::date)
         RETURNING *`,
        [m.id, b.rateType, b.effectiveFrom],
      );
      const ins = await db.one(
        `INSERT INTO member_rates (organization_id, member_id, rate_type, amount, currency, pay_type, effective_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ctx.orgId, m.id, b.rateType, b.amount, currency, b.payType, b.effectiveFrom],
      );
      return { ins, closed };
    });
    await audit(ctx, 'member.rate_added', {
      entityType: 'member',
      entityId: m.id,
      before: row.closed ? rateDto(row.closed) : null,
      after: rateDto(row.ins),
    });
    created(res, rateDto(row.ins));
  },
);

// ─── EMP-13 / EMP-24 status transitions ─────────────────────────────────────
const statusBody = z.object({ reason: z.string().trim().max(500).optional() });

async function loadForStatus(ctx, id) {
  const m = await loadMember(ctx.orgId, id);
  if (!m) throw notFound('Member');
  await assertMemberAccess(ctx, 'members.deactivate', m.id);
  if (m.id === ctx.memberId) throw badRequest('You cannot change your own status', undefined, 'SELF_ACTION');
  if (m.role_level > (ctx.role?.level ?? 0)) throw forbidden('You cannot change the status of a member above your level');
  return m;
}

/** Stop timer, revoke device tokens and org sessions of a member. */
async function cutAccess(ctx, m, reason) {
  if (await getRunningEntry(m.id)) {
    try {
      await stopTimer(ctx, { memberId: m.id, note: undefined });
    } catch (err) {
      if (err.code !== 'NO_RUNNING_TIMER') throw err;
    }
  }
  await db.query(
    `UPDATE device_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND device_id IN (SELECT id FROM devices WHERE member_id = $1)`,
    [m.id],
  );
  await db.query(`UPDATE devices SET online = false WHERE member_id = $1`, [m.id]);
  await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $3 WHERE user_id = $1 AND organization_id = $2 AND revoked_at IS NULL`,
    [m.user_id, ctx.orgId, reason],
  );
  emitToUser(m.user_id, 'member.deactivated', { organizationId: ctx.orgId });
}

async function lastOwnerGuard(ctx, m) {
  if (m.base_role === 'owner' && (await activeOwnerCount(ctx.orgId, m.id)) === 0) throw conflict('LAST_OWNER', 'The last owner cannot be deactivated');
}

r.post('/:id/deactivate', { summary: 'Deactivate employee (stops timer, revokes sessions/devices, frees seat)', ids: 'EMP-24, EMP-13', permission: 'members.deactivate', params: z.object({ id: z.uuid() }), body: statusBody }, async (req, res) => {
  const ctx = req.ctx;
  const m = await loadForStatus(ctx, req.v.params.id);
  if (m.status === 'inactive') throw conflict('INVALID_STATUS', 'Member is already inactive');
  await lastOwnerGuard(ctx, m);
  await cutAccess(ctx, m, 'member_deactivated');
  await db.tx(async () => {
    await db.query(`UPDATE organization_members SET status = 'inactive', deactivated_at = now(), status_reason = $2, updated_at = now() WHERE id = $1`, [m.id, req.body.reason ?? null]);
    await db.query(`UPDATE invitations SET status = 'revoked' WHERE member_id = $1 AND status = 'pending'`, [m.id]);
  });
  await audit(ctx, 'member.deactivated', { entityType: 'member', entityId: m.id, before: { status: m.status }, after: { status: 'inactive', reason: req.body.reason ?? null } });
  await publish('member.deactivated', { orgId: ctx.orgId, memberId: m.id, reason: req.body.reason ?? null });
  ok(res, memberDto(await loadMember(ctx.orgId, m.id)));
});

r.post('/:id/suspend', { summary: 'Suspend employee', ids: 'EMP-13', permission: 'members.deactivate', params: z.object({ id: z.uuid() }), body: statusBody }, async (req, res) => {
  const ctx = req.ctx;
  const m = await loadForStatus(ctx, req.v.params.id);
  if (m.status !== 'active') throw conflict('INVALID_STATUS', `Only active members can be suspended (status: ${m.status})`);
  await lastOwnerGuard(ctx, m);
  await cutAccess(ctx, m, 'member_suspended');
  await db.query(`UPDATE organization_members SET status = 'suspended', status_reason = $2, updated_at = now() WHERE id = $1`, [m.id, req.body.reason ?? null]);
  await audit(ctx, 'member.suspended', { entityType: 'member', entityId: m.id, before: { status: m.status }, after: { status: 'suspended', reason: req.body.reason ?? null } });
  await publish('member.updated', { orgId: ctx.orgId, memberId: m.id, changes: ['status'], status: 'suspended' });
  ok(res, memberDto(await loadMember(ctx.orgId, m.id)));
});

r.post('/:id/reactivate', { summary: 'Reactivate employee (seat check)', ids: 'EMP-24, EMP-13, SUB-17', permission: 'members.deactivate', params: z.object({ id: z.uuid() }), body: statusBody }, async (req, res) => {
  const ctx = req.ctx;
  const m = await loadForStatus(ctx, req.v.params.id);
  if (!['inactive', 'suspended'].includes(m.status)) throw conflict('INVALID_STATUS', `Member is ${m.status}`);
  if (m.status === 'inactive' && m.base_role !== 'client') await assertSeatsAvailable(ctx.orgId, 1);
  // A member created via "Add employee" who never accepted the invitation goes back to 'invited' with a fresh invitation.
  const inv = await db.one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'accepted')::int AS accepted FROM invitations WHERE member_id = $1`,
    [m.id],
  );
  const next = m.status === 'suspended' || inv.total === 0 || inv.accepted > 0 ? 'active' : 'invited';
  await db.query(`UPDATE organization_members SET status = $2, deactivated_at = NULL, status_reason = $3, updated_at = now() WHERE id = $1`, [m.id, next, req.body.reason ?? null]);
  if (next === 'invited') await createInvitation(ctx, { email: m.email, roleId: m.role_id, memberId: m.id, clientId: m.client_id, skipSeatCheck: true });
  await audit(ctx, 'member.reactivated', { entityType: 'member', entityId: m.id, before: { status: m.status }, after: { status: next } });
  await publish('member.updated', { orgId: ctx.orgId, memberId: m.id, changes: ['status'], status: next });
  ok(res, memberDto(await loadMember(ctx.orgId, m.id)));
});

export default r;
