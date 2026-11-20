import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { env } from '../../config/env.js';
import { ok, created, noContent, camelAll, paginationQuery, pageMeta, where } from '../../lib/http.js';
import { randomToken, sha256, encrypt, decrypt } from '../../lib/crypto.js';
import { badRequest, forbidden, notFound, conflict, AppError } from '../../lib/errors.js';
import { hashPassword, passwordSchema } from '../../lib/password.js';
import { sendMail, layout, escapeHtml } from '../../lib/mailer.js';
import { audit } from '../../lib/audit.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { resolveAuth } from '../../middleware/authenticate.js';
import { assertSeatsAvailable } from '../subscription/features.js';
import { nextEmployeeCode } from '../organizations/provision.js';
import { managedMemberIds } from '../../rbac/scope.js';
import { createSession, setAuthCookies, recordLogin, userDto, switchSessionOrg, setAccessCookie } from '../auth/service.js';
import { notify } from '../notifications/service.js';

const r = createRouter('/invitations', 'Invitations');
const INVITE_TTL_DAYS = 7;

/** Role assignment guard (RBAC-09): cannot grant a role above your own level; only owners grant owner. */
export async function assertAssignableRole(ctx, roleId) {
  const role = await db.one('SELECT * FROM roles WHERE id = $1 AND organization_id = $2', [roleId, ctx.orgId]);
  if (!role) throw badRequest('Role not found in this organization', undefined, 'INVALID_ROLE');
  if (role.base_role === 'owner' && !ctx.isOwner()) throw forbidden('Only the owner can assign the owner role');
  if (ctx.role?.level !== undefined && role.level > ctx.role.level) throw forbidden('You cannot assign a role higher than your own');
  return role;
}

async function sendInviteEmail({ orgId, email, token, inviterName, roleName }) {
  const org = await db.one('SELECT name FROM organizations WHERE id = $1', [orgId]);
  const url = `${env.FRONTEND_URL}/invite/${token}`;
  await sendMail({
    to: email,
    subject: `You're invited to join ${org.name} on Tracker`,
    html: layout({
      title: `Join ${org.name}`,
      body: `<p>${escapeHtml(inviterName)} invited you to join <b>${escapeHtml(org.name)}</b> as <b>${escapeHtml(roleName)}</b>.</p><p>This invitation expires in ${INVITE_TTL_DAYS} days.</p>`,
      actionUrl: url,
      actionLabel: 'Accept invitation',
    }),
    text: `Accept your invitation: ${url}`,
  });
}

/**
 * Create one invitation (AUTH-14, EMP-03). `memberId` links to a pre-created member row
 * (EMP-01 "add employee" creates the profile first, status=invited).
 */
export async function createInvitation(ctx, { email, roleId, teamId, projectIds = [], clientId, memberId, skipSeatCheck }) {
  const role = await assertAssignableRole(ctx, roleId);
  email = email.trim().toLowerCase();
  const existingMember = await db.one(
    `SELECT m.id, m.status FROM organization_members m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND u.email = $2 AND m.deleted_at IS NULL`,
    [ctx.orgId, email],
  );
  if (existingMember && existingMember.status !== 'invited' && existingMember.id !== memberId)
    throw conflict('ALREADY_MEMBER', `${email} is already a member of this organization`);
  if (role.base_role !== 'client' && !skipSeatCheck && !memberId) await assertSeatsAvailable(ctx.orgId, 1);
  if (clientId && role.base_role !== 'client') throw badRequest('clientId can only be used with the client role', undefined, 'INVALID_ROLE');
  if (clientId && !(await db.one('SELECT 1 FROM clients WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [clientId, ctx.orgId])))
    throw badRequest('Client not found', undefined, 'INVALID_REFERENCE');
  if (teamId && !(await db.one('SELECT 1 FROM teams WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [teamId, ctx.orgId])))
    throw badRequest('Team not found', undefined, 'INVALID_REFERENCE');
  await db.query(`UPDATE invitations SET status = 'revoked' WHERE organization_id = $1 AND email = $2 AND status = 'pending'`, [ctx.orgId, email]);
  const token = `inv_${randomToken(24)}`;
  const inv = await db.one(
    `INSERT INTO invitations (organization_id, email, role_id, team_id, project_ids, client_id, member_id, token_hash, invited_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + interval '${INVITE_TTL_DAYS} days') RETURNING *`,
    [ctx.orgId, email, roleId, teamId ?? null, projectIds, clientId ?? null, memberId ?? null, sha256(token), ctx.memberId ?? null],
  );
  const inviter = ctx.user ? `${ctx.user.firstName} ${ctx.user.lastName}`.trim() : 'Your administrator';
  await sendInviteEmail({ orgId: ctx.orgId, email, token, inviterName: inviter, roleName: role.name });
  // In-app notification if the invitee already has an account (NOTIF-01).
  const u = await db.one('SELECT id FROM users WHERE email = $1', [email]);
  if (u) {
    const org = await db.one('SELECT name FROM organizations WHERE id = $1', [ctx.orgId]);
    await notify({ orgId: null, userIds: [u.id], type: 'invitation.received', title: `Invitation to join ${org.name}`, body: `${inviter} invited you as ${role.name}.`, link: `/invite/${token}`, email: false });
  }
  await audit(ctx, 'invitation.created', { entityType: 'invitation', entityId: inv.id, after: { email, role: role.slug } });
  return { invitation: inv, token };
}

const invDto = (i) => ({
  id: i.id,
  email: i.email,
  status: i.status === 'pending' && new Date(i.expires_at) < new Date() ? 'expired' : i.status,
  role: { id: i.role_id, name: i.role_name, slug: i.role_slug },
  teamId: i.team_id,
  projectIds: i.project_ids,
  clientId: i.client_id,
  memberId: i.member_id,
  invitedBy: i.inviter_name ?? null,
  expiresAt: i.expires_at,
  createdAt: i.created_at,
  respondedAt: i.responded_at,
});

r.get(
  '/',
  { summary: 'List invitations', ids: 'AUTH-14, EMP-03', permission: 'members.invite', query: paginationQuery.extend({ status: z.enum(['pending', 'accepted', 'rejected', 'expired', 'revoked']).optional() }) },
  async (req, res) => {
    const q = req.v.query;
    const w = where([req.ctx.orgId]).raw('i.organization_id = $1');
    if (q.status === 'expired') w.raw(`i.status = 'pending' AND i.expires_at < now()`);
    else if (q.status === 'pending') w.raw(`i.status = 'pending' AND i.expires_at >= now()`);
    else w.add('i.status = ?', q.status);
    if (q.search) w.add('i.email ILIKE ?', `%${q.search}%`);
    const total = (await db.one(`SELECT count(*)::int AS n FROM invitations i ${w.sql}`, w.params)).n;
    const rows = await db.many(
      `SELECT i.*, r.name AS role_name, r.slug AS role_slug, trim(u.first_name || ' ' || u.last_name) AS inviter_name
       FROM invitations i JOIN roles r ON r.id = i.role_id
       LEFT JOIN organization_members im ON im.id = i.invited_by LEFT JOIN users u ON u.id = im.user_id
       ${w.sql} ORDER BY i.created_at DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      w.params,
    );
    ok(res, rows.map(invDto), pageMeta(q, total));
  },
);

const inviteBody = z.object({
  email: z.email().max(254),
  roleId: z.uuid(),
  teamId: z.uuid().optional(),
  projectIds: z.array(z.uuid()).max(100).default([]),
  clientId: z.uuid().optional(),
});

r.post('/', { summary: 'Invite a member by email', ids: 'AUTH-14, EMP-03, NOTIF-01, SUB-17', permission: 'members.invite', body: inviteBody }, async (req, res) => {
  if (req.ctx.can('members.invite') === 'team' && req.body.teamId) {
    const managed = await db.one(
      `SELECT 1 FROM team_managers WHERE team_id = $1 AND member_id = $2 UNION SELECT 1 FROM team_members WHERE team_id = $1 AND member_id = $2 AND is_leader`,
      [req.body.teamId, req.ctx.memberId],
    );
    if (!managed) throw forbidden('You can only invite members into teams you manage');
  }
  const { invitation } = await createInvitation(req.ctx, req.body);
  created(res, { id: invitation.id, email: invitation.email, status: invitation.status, expiresAt: invitation.expires_at });
});

r.post(
  '/bulk',
  {
    summary: 'Bulk invite (up to 200 emails)',
    ids: 'EMP-23',
    permission: 'members.invite',
    body: z.object({ emails: z.array(z.email().max(254)).min(1).max(200), roleId: z.uuid(), teamId: z.uuid().optional(), projectIds: z.array(z.uuid()).default([]) }),
  },
  async (req, res) => {
    const emails = [...new Set(req.body.emails.map((e) => e.toLowerCase()))];
    const role = await assertAssignableRole(req.ctx, req.body.roleId);
    if (role.base_role !== 'client') await assertSeatsAvailable(req.ctx.orgId, emails.length);
    const results = [];
    for (const email of emails) {
      try {
        const { invitation } = await createInvitation(req.ctx, { ...req.body, email, skipSeatCheck: true });
        results.push({ email, status: 'invited', id: invitation.id });
      } catch (err) {
        results.push({ email, status: 'failed', code: err.code ?? 'ERROR', message: err.message });
      }
    }
    ok(res, { invited: results.filter((x) => x.status === 'invited').length, failed: results.filter((x) => x.status === 'failed').length, results });
  },
);

r.post('/:id/resend', { summary: 'Resend an invitation (new token, new expiry)', ids: 'EMP-03', permission: 'members.invite', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const inv = await db.one(`SELECT * FROM invitations WHERE id = $1 AND organization_id = $2 AND status = 'pending'`, [req.v.params.id, req.ctx.orgId]);
  if (!inv) throw notFound('Pending invitation');
  const token = `inv_${randomToken(24)}`;
  await db.query(`UPDATE invitations SET token_hash = $2, expires_at = now() + interval '${INVITE_TTL_DAYS} days' WHERE id = $1`, [inv.id, sha256(token)]);
  const role = await db.one('SELECT name FROM roles WHERE id = $1', [inv.role_id]);
  await sendInviteEmail({ orgId: req.ctx.orgId, email: inv.email, token, inviterName: `${req.ctx.user?.firstName ?? ''} ${req.ctx.user?.lastName ?? ''}`.trim() || 'Your administrator', roleName: role.name });
  noContent(res);
});

r.delete('/:id', { summary: 'Revoke an invitation', ids: 'AUTH-14', permission: 'members.invite', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const inv = await db.one(`UPDATE invitations SET status = 'revoked' WHERE id = $1 AND organization_id = $2 AND status = 'pending' RETURNING *`, [req.v.params.id, req.ctx.orgId]);
  if (!inv) throw notFound('Pending invitation');
  if (inv.member_id) await db.query(`UPDATE organization_members SET deleted_at = now() WHERE id = $1 AND status = 'invited'`, [inv.member_id]);
  await audit(req.ctx, 'invitation.revoked', { entityType: 'invitation', entityId: inv.id });
  noContent(res);
});

// ─── AUTH-15 Invite links ────────────────────────────────────────────────────
r.get('/links', { summary: 'List invite links', ids: 'AUTH-15', permission: 'members.invite' }, async (req, res) => {
  const rows = await db.many(
    `SELECT l.*, r.name AS role_name FROM invitation_links l JOIN roles r ON r.id = l.role_id WHERE l.organization_id = $1 ORDER BY l.created_at DESC`,
    [req.ctx.orgId],
  );
  ok(
    res,
    rows.map((l) => ({
      id: l.id,
      url: `${env.FRONTEND_URL}/invite/${decrypt(l.token_enc)}`,
      role: { id: l.role_id, name: l.role_name },
      teamId: l.team_id,
      maxUses: l.max_uses,
      uses: l.uses,
      expiresAt: l.expires_at,
      revokedAt: l.revoked_at,
      active: !l.revoked_at && (!l.expires_at || new Date(l.expires_at) > new Date()) && (l.max_uses === null || l.uses < l.max_uses),
      createdAt: l.created_at,
    })),
  );
});

r.post(
  '/links',
  {
    summary: 'Generate an invite link',
    ids: 'AUTH-15',
    permission: 'members.invite',
    body: z.object({ roleId: z.uuid(), teamId: z.uuid().optional(), maxUses: z.number().int().min(1).max(1000).optional(), expiresInDays: z.number().int().min(1).max(90).default(7) }),
  },
  async (req, res) => {
    const role = await assertAssignableRole(req.ctx, req.body.roleId);
    if (['owner', 'admin'].includes(role.base_role)) throw badRequest('Invite links cannot grant owner/admin roles', undefined, 'INVALID_ROLE');
    const token = `lnk_${randomToken(24)}`;
    const l = await db.one(
      `INSERT INTO invitation_links (organization_id, token_hash, token_enc, role_id, team_id, max_uses, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval, $8) RETURNING *`,
      [req.ctx.orgId, sha256(token), encrypt(token), req.body.roleId, req.body.teamId ?? null, req.body.maxUses ?? null, String(req.body.expiresInDays), req.ctx.memberId],
    );
    await audit(req.ctx, 'invitation_link.created', { entityType: 'invitation_link', entityId: l.id });
    created(res, { id: l.id, url: `${env.FRONTEND_URL}/invite/${token}`, token, expiresAt: l.expires_at, maxUses: l.max_uses });
  },
);

r.delete('/links/:id', { summary: 'Revoke invite link', ids: 'AUTH-15', permission: 'members.invite', params: z.object({ id: z.uuid() }) }, async (req, res) => {
  const l = await db.one('UPDATE invitation_links SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL RETURNING id', [req.v.params.id, req.ctx.orgId]);
  if (!l) throw notFound('Invite link');
  noContent(res);
});

// ─── AUTH-16 Public preview / accept / reject ───────────────────────────────
async function findInvite(token) {
  if (token.startsWith('lnk_')) {
    const l = await db.one(
      `SELECT l.*, r.name AS role_name, r.base_role, o.name AS org_name, o.logo_key FROM invitation_links l
       JOIN roles r ON r.id = l.role_id JOIN organizations o ON o.id = l.organization_id
       WHERE l.token_hash = $1 AND o.deleted_at IS NULL`,
      [sha256(token)],
    );
    if (!l) return null;
    const expired = l.revoked_at || (l.expires_at && new Date(l.expires_at) < new Date()) || (l.max_uses !== null && l.uses >= l.max_uses);
    return { kind: 'link', row: l, status: expired ? 'expired' : 'pending', email: null };
  }
  const i = await db.one(
    `SELECT i.*, r.name AS role_name, r.base_role, o.name AS org_name, o.logo_key, trim(u.first_name || ' ' || u.last_name) AS inviter_name
     FROM invitations i JOIN roles r ON r.id = i.role_id JOIN organizations o ON o.id = i.organization_id
     LEFT JOIN organization_members im ON im.id = i.invited_by LEFT JOIN users u ON u.id = im.user_id
     WHERE i.token_hash = $1 AND o.deleted_at IS NULL`,
    [sha256(token)],
  );
  if (!i) return null;
  const status = i.status === 'pending' && new Date(i.expires_at) < new Date() ? 'expired' : i.status;
  return { kind: 'invite', row: i, status, email: i.email };
}

r.get('/token/:token', { auth: 'public', summary: 'Preview an invitation (public)', ids: 'AUTH-16', middleware: authLimiter, params: z.object({ token: z.string().min(10).max(100) }) }, async (req, res) => {
  const inv = await findInvite(req.v.params.token);
  if (!inv) throw notFound('Invitation');
  const existing = inv.email ? await db.one('SELECT 1 FROM users WHERE email = $1', [inv.email]) : null;
  ok(res, {
    organization: { name: inv.row.org_name },
    role: inv.row.role_name,
    email: inv.email,
    invitedBy: inv.row.inviter_name ?? null,
    status: inv.status,
    expiresAt: inv.row.expires_at,
    accountExists: !!existing,
    kind: inv.kind,
  });
});

/** Create membership for user from an invitation/link. */
async function joinOrganization(inv, userId) {
  const r0 = inv.row;
  const orgId = r0.organization_id;
  const existing = await db.one('SELECT * FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
  if (existing && existing.status !== 'invited' && !existing.deleted_at) throw conflict('ALREADY_MEMBER', 'You are already a member of this organization');
  if (r0.base_role !== 'client' && !(inv.kind === 'invite' && r0.member_id)) {
    // Seats: a pending invitation already reserved a seat; a link did not.
    if (inv.kind === 'link') await assertSeatsAvailable(orgId, 1);
  }
  let member;
  if (inv.kind === 'invite' && r0.member_id) {
    member = await db.one(
      `UPDATE organization_members SET user_id = $2, status = 'active', role_id = $3, deleted_at = NULL, updated_at = now(), joined_on = coalesce(joined_on, current_date)
       WHERE id = $1 RETURNING *`,
      [r0.member_id, userId, r0.role_id],
    );
  } else if (existing) {
    member = await db.one(
      `UPDATE organization_members SET status = 'active', role_id = $2, deleted_at = NULL, client_id = coalesce($3, client_id), updated_at = now() WHERE id = $1 RETURNING *`,
      [existing.id, r0.role_id, r0.client_id ?? null],
    );
  } else {
    member = await db.one(
      `INSERT INTO organization_members (organization_id, user_id, role_id, status, employee_code, joined_on, client_id, work_schedule_id)
       VALUES ($1,$2,$3,'active',$4, current_date, $5, (SELECT id FROM work_schedules WHERE organization_id = $1 AND is_default))
       RETURNING *`,
      [orgId, userId, r0.role_id, r0.base_role === 'client' ? null : await nextEmployeeCode(orgId), r0.client_id ?? null],
    );
  }
  if (r0.team_id) await db.query('INSERT INTO team_members (team_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r0.team_id, member.id]);
  for (const pid of r0.project_ids ?? [])
    await db.query(
      `INSERT INTO project_members (project_id, member_id) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM projects WHERE id = $1 AND organization_id = $3) ON CONFLICT DO NOTHING`,
      [pid, member.id, orgId],
    );
  if (inv.kind === 'invite')
    await db.query(`UPDATE invitations SET status = 'accepted', accepted_user_id = $2, responded_at = now() WHERE id = $1`, [r0.id, userId]);
  else await db.query('UPDATE invitation_links SET uses = uses + 1 WHERE id = $1', [r0.id]);
  await audit({ orgId, userId }, 'invitation.accepted', { entityType: 'member', entityId: member.id });
  return member;
}

r.post(
  '/token/:token/accept',
  {
    auth: 'optional',
    summary: 'Accept an invitation (logged-in user, or create an account)',
    ids: 'AUTH-16, CLI-01',
    middleware: authLimiter,
    params: z.object({ token: z.string().min(10).max(100) }),
    body: z.object({
      firstName: z.string().trim().min(1).max(100).optional(),
      lastName: z.string().trim().max(100).optional(),
      email: z.email().optional(),
      password: passwordSchema.optional(),
    }),
  },
  async (req, res) => {
    const inv = await findInvite(req.v.params.token);
    if (!inv) throw notFound('Invitation');
    if (inv.status !== 'pending') throw new AppError(410, 'INVITATION_EXPIRED', `This invitation is ${inv.status}`);
    await resolveAuth(req).catch(() => null);
    const ctx = req.ctx;
    const member = await db.tx(async () => {
      let userId = ctx.userId;
      if (userId) {
        if (inv.email) {
          const u = await db.one('SELECT email FROM users WHERE id = $1', [userId]);
          if (u.email.toLowerCase() !== inv.email.toLowerCase()) throw forbidden('This invitation was sent to a different email address', 'INVITATION_EMAIL_MISMATCH');
        }
      } else {
        const email = (inv.email ?? req.body.email ?? '').toLowerCase();
        if (!email) throw badRequest('Email is required', [{ path: 'body.email', message: 'Required' }]);
        const existingUser = await db.one('SELECT id, password_hash FROM users WHERE email = $1', [email]);
        // A passwordless user (created by "Add employee") may be claimed through an email-bound invitation:
        // the invitation token proves ownership of the email address.
        const claimable = existingUser && !existingUser.password_hash && !!inv.email;
        if (existingUser && !claimable) throw new AppError(409, 'LOGIN_REQUIRED', 'An account with this email exists. Log in to accept the invitation.');
        if (!req.body.password || (!claimable && !req.body.firstName)) throw badRequest('firstName and password are required to create an account', [{ path: 'body.password', message: 'Required' }]);
        const u = claimable
          ? await db.one(
              `UPDATE users SET password_hash = $2, first_name = coalesce($3, first_name), last_name = coalesce($4, last_name),
                 email_verified_at = coalesce(email_verified_at, now()), updated_at = now() WHERE id = $1 RETURNING id`,
              [existingUser.id, await hashPassword(req.body.password), req.body.firstName ?? null, req.body.lastName ?? null],
            )
          : await db.one(
          `INSERT INTO users (email, password_hash, first_name, last_name, email_verified_at) VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN now() END) RETURNING id`,
              [email, await hashPassword(req.body.password), req.body.firstName, req.body.lastName ?? '', !!inv.email],
            );
        userId = u.id;
      }
      const m = await joinOrganization(inv, userId);
      return { ...m, userId };
    });
    let tokens = null;
    if (ctx.sessionId) {
      const accessToken = await switchSessionOrg(ctx.sessionId, member.userId, member.organization_id);
      setAccessCookie(res, accessToken);
      tokens = { accessToken };
    } else {
      const s = await createSession({ userId: member.userId, orgId: member.organization_id, ip: ctx.ip, userAgent: ctx.userAgent });
      await recordLogin({ userId: member.userId, method: 'password', success: true, ip: ctx.ip, userAgent: ctx.userAgent });
      setAuthCookies(res, { ...s, rememberMe: false });
      tokens = { accessToken: s.accessToken };
    }
    const user = await db.one('SELECT * FROM users WHERE id = $1', [member.userId]);
    ok(res, { user: userDto(user), organizationId: member.organization_id, memberId: member.id, ...tokens });
  },
);

r.post('/token/:token/reject', { auth: 'public', summary: 'Reject an invitation', ids: 'AUTH-16', middleware: authLimiter, params: z.object({ token: z.string().min(10).max(100) }) }, async (req, res) => {
  const inv = await findInvite(req.v.params.token);
  if (!inv || inv.kind !== 'invite') throw notFound('Invitation');
  if (inv.status !== 'pending') throw new AppError(410, 'INVITATION_EXPIRED', `This invitation is ${inv.status}`);
  await db.query(`UPDATE invitations SET status = 'rejected', responded_at = now() WHERE id = $1`, [inv.row.id]);
  if (inv.row.member_id) await db.query(`UPDATE organization_members SET deleted_at = now() WHERE id = $1 AND status = 'invited'`, [inv.row.member_id]);
  noContent(res);
});

export default r;
export { managedMemberIds };
