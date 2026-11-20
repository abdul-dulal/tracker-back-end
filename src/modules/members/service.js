import { db } from '../../lib/db.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { publish } from '../../lib/events.js';
import { signedGetUrl } from '../../lib/storage.js';
import { assertSeatsAvailable } from '../subscription/features.js';
import { nextEmployeeCode } from '../organizations/provision.js';
import { createInvitation, assertAssignableRole } from '../invitations/routes.js';
import { managedTeamIds, assertOrgMembers, assertOrgRows } from '../teams/service.js';

export const MEMBER_SELECT = `
  SELECT m.*, u.email, u.first_name, u.last_name, u.avatar_key, u.email_verified_at,
         r.name AS role_name, r.slug AS role_slug, r.base_role, r.level AS role_level,
         d.name AS department_name, ws.name AS work_schedule_name,
         coalesce((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'isLeader', tm.is_leader) ORDER BY t.name)
            FROM team_members tm JOIN teams t ON t.id = tm.team_id AND t.deleted_at IS NULL WHERE tm.member_id = m.id), '[]') AS teams,
         coalesce((SELECT json_agg(json_build_object('id', mm.manager_member_id, 'name', trim(mu.first_name || ' ' || mu.last_name)) ORDER BY mu.first_name)
            FROM member_managers mm JOIN organization_members mgr ON mgr.id = mm.manager_member_id JOIN users mu ON mu.id = mgr.user_id
            WHERE mm.member_id = m.id), '[]') AS managers
  FROM organization_members m
  JOIN users u ON u.id = m.user_id
  JOIN roles r ON r.id = m.role_id
  LEFT JOIN departments d ON d.id = m.department_id AND d.deleted_at IS NULL
  LEFT JOIN work_schedules ws ON ws.id = m.work_schedule_id`;

/** Can ctx see rates (EMP-16): payroll.view or billing.view. */
export const canSeeRates = (ctx) => !!(ctx.can('payroll.view') || ctx.can('billing.view') || ctx.can('payroll.manage') || ctx.can('billing.manage'));

export function memberDto(m, { rates } = {}) {
  const dto = {
    id: m.id,
    userId: m.user_id,
    email: m.email,
    firstName: m.first_name,
    lastName: m.last_name,
    name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(),
    avatarUrl: signedGetUrl(m.avatar_key, { ttl: 3600 }),
    role: { id: m.role_id, name: m.role_name, slug: m.role_slug, baseRole: m.base_role },
    status: m.status,
    statusReason: m.status_reason,
    employeeCode: m.employee_code,
    designation: m.designation,
    department: m.department_id ? { id: m.department_id, name: m.department_name ?? null } : null,
    teams: m.teams ?? [],
    managers: m.managers ?? [],
    employmentType: m.employment_type,
    joinedOn: m.joined_on,
    workScheduleId: m.work_schedule_id,
    workScheduleName: m.work_schedule_name ?? null,
    weeklyHours: m.weekly_hours === null || m.weekly_hours === undefined ? null : Number(m.weekly_hours),
    weeklyLimitHours: m.weekly_limit_hours === null || m.weekly_limit_hours === undefined ? null : Number(m.weekly_limit_hours),
    workMode: m.work_mode,
    timezone: m.timezone,
    workEmail: m.work_email,
    clientId: m.client_id,
    restrictions: m.restrictions ?? {},
    lastSeenAt: m.last_seen_at,
    deactivatedAt: m.deactivated_at,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
  if (rates !== undefined) dto.hourlyRate = rates;
  return dto;
}

/** Current pay rate per member (for DTOs). Returns Map memberId → {amount,currency,payType}. */
export async function currentRates(memberIds, rateType = 'pay') {
  if (!memberIds.length) return new Map();
  const rows = await db.many(
    `SELECT DISTINCT ON (member_id) member_id, amount, currency, pay_type FROM member_rates
     WHERE member_id = ANY($1::uuid[]) AND rate_type = $2 AND effective_from <= current_date AND (effective_to IS NULL OR effective_to > current_date)
     ORDER BY member_id, effective_from DESC`,
    [memberIds, rateType],
  );
  return new Map(rows.map((r) => [r.member_id, { amount: Number(r.amount), currency: r.currency.trim(), payType: r.pay_type }]));
}

export async function loadMember(orgId, id) {
  return db.one(`${MEMBER_SELECT} WHERE m.id = $1 AND m.organization_id = $2 AND m.deleted_at IS NULL`, [id, orgId]);
}

export async function memberWithRates(ctx, m) {
  if (!canSeeRates(ctx)) return memberDto(m);
  const rates = await currentRates([m.id]);
  return memberDto(m, { rates: rates.get(m.id) ?? null });
}

/** For 'team'-scoped grants: all teamIds must be teams the caller manages. */
export async function assertTeamsInScope(ctx, perm, teamIds) {
  if (!teamIds?.length || ctx.can(perm) === 'org') return;
  const managed = await managedTeamIds(ctx);
  if (teamIds.some((t) => !managed.includes(t))) throw forbidden('You can only assign members to teams you manage');
}

/** Validate org references used by create/update. */
export async function validateMemberRefs(ctx, b, selfId) {
  if (b.departmentId) await assertOrgRows('departments', ctx.orgId, [b.departmentId], 'departmentId');
  if (b.workScheduleId) await assertOrgRows('work_schedules', ctx.orgId, [b.workScheduleId], 'workScheduleId', { softDelete: false });
  if (b.teamIds) await assertOrgRows('teams', ctx.orgId, b.teamIds, 'teamIds');
  if (b.managerIds) {
    if (selfId && b.managerIds.includes(selfId)) throw badRequest('A member cannot be their own manager', [{ path: 'body.managerIds', message: 'Self reference' }], 'INVALID_MANAGER');
    await assertOrgMembers(ctx.orgId, b.managerIds, 'managerIds');
  }
}

export async function setTeams(memberId, teamIds) {
  await db.query('DELETE FROM team_members WHERE member_id = $1 AND NOT (team_id = ANY($2::uuid[]))', [memberId, teamIds]);
  for (const t of teamIds) await db.query('INSERT INTO team_members (team_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [t, memberId]);
}

export async function setManagers(orgId, memberId, managerIds) {
  await db.query('DELETE FROM member_managers WHERE member_id = $1', [memberId]);
  for (const mgr of [...new Set(managerIds)])
    await db.query('INSERT INTO member_managers (organization_id, member_id, manager_member_id) VALUES ($1,$2,$3)', [orgId, memberId, mgr]);
}

/**
 * Add an employee (EMP-01): creates the users row when the email is unknown (no password, unverified),
 * the member profile (status 'invited') and a linked invitation. Returns { member, invitation }.
 * @param {object} b validated body
 * @param {{skipSeatCheck?: boolean}} opts
 */
export async function createMember(ctx, b, { skipSeatCheck = false } = {}) {
  const email = b.email.trim().toLowerCase();
  const role = await assertAssignableRole(ctx, b.roleId);
  if (role.base_role === 'owner') throw badRequest('Use ownership transfer to add an owner', undefined, 'INVALID_ROLE');
  await validateMemberRefs(ctx, b);
  return db.tx(async () => {
    const existing = await db.one(
      `SELECT m.id, m.status, m.deleted_at FROM organization_members m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1 AND u.email = $2`,
      [ctx.orgId, email],
    );
    if (existing && !existing.deleted_at) throw conflict('ALREADY_MEMBER', `${email} is already a member of this organization`);
    if (role.base_role !== 'client' && !skipSeatCheck) await assertSeatsAvailable(ctx.orgId, 1);
    let user = await db.one('SELECT id FROM users WHERE email = $1', [email]);
    if (!user)
      user = await db.one(`INSERT INTO users (email, first_name, last_name) VALUES ($1,$2,$3) RETURNING id`, [email, b.firstName, b.lastName ?? '']);
    let code = b.employeeCode ?? null;
    if (code) {
      const dup = await db.one('SELECT 1 FROM organization_members WHERE organization_id = $1 AND employee_code = $2 AND id IS DISTINCT FROM $3', [ctx.orgId, code, existing?.id ?? null]);
      if (dup) throw conflict('EMPLOYEE_CODE_TAKEN', `Employee code ${code} is already in use`);
    } else if (role.base_role !== 'client') code = await nextEmployeeCode(ctx.orgId);
    const values = [
      ctx.orgId, user.id, b.roleId, code, b.designation ?? null, b.departmentId ?? null, b.employmentType ?? 'full_time', b.joinedOn ?? null,
      b.workScheduleId ?? null, b.weeklyHours ?? 40, b.weeklyLimitHours ?? null, b.workMode ?? 'office', b.timezone ?? null,
      b.workEmail ?? null, db.json(b.restrictions ?? {}), b.clientId ?? null,
    ];
    let member;
    if (existing) {
      // Re-adding a previously removed member: revive the row (UNIQUE(org,user)).
      member = await db.one(
        `UPDATE organization_members SET role_id = $3, status = 'invited', employee_code = $4, designation = $5, department_id = $6, employment_type = $7,
           joined_on = $8, work_schedule_id = coalesce($9, (SELECT id FROM work_schedules WHERE organization_id = $1 AND is_default)),
           weekly_hours = $10, weekly_limit_hours = $11, work_mode = $12, timezone = $13, work_email = $14, restrictions = $15, client_id = $16,
           deleted_at = NULL, deactivated_at = NULL, status_reason = NULL, updated_at = now()
         WHERE id = $17 RETURNING *`,
        [...values, existing.id],
      );
    } else {
      member = await db.one(
        `INSERT INTO organization_members (organization_id, user_id, role_id, status, employee_code, designation, department_id, employment_type,
           joined_on, work_schedule_id, weekly_hours, weekly_limit_hours, work_mode, timezone, work_email, restrictions, client_id)
         VALUES ($1,$2,$3,'invited',$4,$5,$6,$7,$8, coalesce($9, (SELECT id FROM work_schedules WHERE organization_id = $1 AND is_default)),
           $10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        values,
      );
    }
    if (b.teamIds?.length) await setTeams(member.id, [...new Set(b.teamIds)]);
    if (b.managerIds?.length) await setManagers(ctx.orgId, member.id, b.managerIds);
    if (b.hourlyRate !== undefined && b.hourlyRate !== null) {
      const cur = b.currency ?? (await db.one('SELECT default_currency FROM organizations WHERE id = $1', [ctx.orgId])).default_currency;
      await db.query(
        `INSERT INTO member_rates (organization_id, member_id, rate_type, amount, currency, pay_type, effective_from)
         VALUES ($1,$2,'pay',$3,$4,'hourly', coalesce($5::date, current_date))`,
        [ctx.orgId, member.id, b.hourlyRate, cur, b.joinedOn ?? null],
      );
      await audit(ctx, 'member.rate_added', { entityType: 'member', entityId: member.id, after: { rateType: 'pay', amount: b.hourlyRate, currency: cur } });
    }
    const { invitation } = await createInvitation(ctx, { email, roleId: b.roleId, memberId: member.id, clientId: b.clientId, skipSeatCheck: true });
    await audit(ctx, 'member.created', { entityType: 'member', entityId: member.id, after: { email, roleId: b.roleId, employeeCode: code } });
    return { member, invitation };
  });
}

export async function afterCreate(ctx, member) {
  await publish('member.created', { orgId: ctx.orgId, memberId: member.id, member: { id: member.id, status: member.status } });
}
