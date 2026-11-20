import { db } from '../../lib/db.js';
import { enqueue, registerJob } from '../../lib/jobs.js';
import { emitToUser } from '../../lib/realtime.js';
import { sendMail, layout, escapeHtml } from '../../lib/mailer.js';
import { env } from '../../config/env.js';
import { NOTIFICATION_EVENTS } from '../../rbac/catalog.js';
import { camel } from '../../lib/http.js';

/**
 * Notification dispatcher (guide §M19).
 *   await notify({ orgId, userIds | memberIds, type, title, body, link, data })
 * Resolves per-user preferences (user → org default → event default), writes in-app rows,
 * emits `notification.new` over WebSocket, and queues email delivery.
 * Desktop notifications are delivered to the agent via GET /agent/notifications (in-app rows
 * flagged with 'desktop' channel).
 */
export async function notify({ orgId, userIds = [], memberIds = [], type, title, body, link, data, email }) {
  const event = NOTIFICATION_EVENTS[type] ?? { label: type };
  let recipients = [...userIds];
  if (memberIds.length) {
    const rows = await db.many(
      `SELECT user_id FROM organization_members WHERE id = ANY($1::uuid[]) AND status = 'active' AND deleted_at IS NULL`,
      [memberIds],
    );
    recipients.push(...rows.map((r) => r.user_id));
  }
  recipients = [...new Set(recipients.filter(Boolean))];
  if (!recipients.length) return [];

  const prefs = await db.many(
    `SELECT user_id, organization_id, in_app, email, desktop FROM notification_preferences
     WHERE event_type = $1 AND (user_id = ANY($2::uuid[]) OR (user_id IS NULL AND organization_id = $3))`,
    [type, recipients, orgId ?? null],
  );
  const orgDefault = prefs.find((p) => !p.user_id);
  const created = [];
  for (const userId of recipients) {
    const p =
      prefs.find((x) => x.user_id === userId && x.organization_id === (orgId ?? null)) ??
      prefs.find((x) => x.user_id === userId && !x.organization_id) ??
      orgDefault;
    const inApp = event.mandatory ? true : (p?.in_app ?? true);
    // Mandatory events always reach the in-app inbox; email still follows the user's preference.
    const wantsEmail = email === false ? false : (p?.email ?? event.defaultEmail ?? true);
    const desktop = p?.desktop ?? true;
    const channels = [inApp && 'in_app', wantsEmail && 'email', desktop && 'desktop'].filter(Boolean);
    if (!channels.length) continue;
    const row = await db.one(
      `INSERT INTO notifications (organization_id, recipient_user_id, type, title, body, data, link, channels_sent, read_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9 THEN NULL ELSE now() END) RETURNING *`,
      [orgId ?? null, userId, type, title, body ?? null, db.json(data), link ?? null, channels, inApp],
    );
    created.push(row);
    if (inApp) emitToUser(userId, 'notification.new', camel(row));
    if (wantsEmail) await enqueue('notifications.email', { notificationId: row.id });
  }
  return created;
}

registerJob('notifications.email', async ({ notificationId }) => {
  const n = await db.one(
    `SELECT n.*, u.email, u.first_name FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE n.id = $1`,
    [notificationId],
  );
  if (!n) return;
  const actionUrl = n.link ? (n.link.startsWith('http') ? n.link : `${env.FRONTEND_URL}${n.link}`) : null;
  await sendMail({
    to: n.email,
    subject: n.title,
    html: layout({
      title: n.title,
      body: `<p>Hi ${escapeHtml(n.first_name)},</p><p>${escapeHtml(n.body ?? '')}</p>`,
      actionUrl,
      actionLabel: 'Open Tracker',
    }),
    text: `${n.title}\n\n${n.body ?? ''}${actionUrl ? `\n\n${actionUrl}` : ''}`,
  });
});

/** Users holding a permission (any scope) in an org — e.g. to alert approvers/admins. */
export async function usersWithPermission(orgId, permission, { memberId } = {}) {
  const rows = await db.many(
    `SELECT DISTINCT m.user_id, m.id AS member_id, rp.scope FROM organization_members m
     JOIN role_permissions rp ON rp.role_id = m.role_id
     JOIN permissions p ON p.id = rp.permission_id AND p.key = $2
     WHERE m.organization_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL`,
    [orgId, permission],
  );
  if (!memberId) return rows.map((r) => r.user_id);
  // Narrow to approvers whose scope covers memberId (org scope, or team/manager relationship).
  const out = [];
  for (const r of rows) {
    if (r.member_id === memberId) continue;
    if (r.scope === 'org') {
      out.push(r.user_id);
      continue;
    }
    if (r.scope === 'team') {
      const rel = await db.one(
        `SELECT 1 FROM member_managers WHERE member_id = $1 AND manager_member_id = $2
         UNION SELECT 1 FROM team_members tm WHERE tm.member_id = $1 AND tm.team_id IN (
           SELECT team_id FROM team_members WHERE member_id = $2 AND is_leader
           UNION SELECT team_id FROM team_managers WHERE member_id = $2) LIMIT 1`,
        [memberId, r.member_id],
      );
      if (rel) out.push(r.user_id);
    }
    if (r.scope === 'project') {
      // Approver manages a project the member belongs to (directly or via a team).
      const rel = await db.one(
        `SELECT 1 FROM project_members pm WHERE pm.member_id = $2 AND pm.role = 'manager' AND pm.project_id IN (
           SELECT project_id FROM project_members WHERE member_id = $1
           UNION SELECT pt.project_id FROM project_teams pt JOIN team_members tm ON tm.team_id = pt.team_id WHERE tm.member_id = $1)
         LIMIT 1`,
        [memberId, r.member_id],
      );
      if (rel) out.push(r.user_id);
    }
  }
  return [...new Set(out)];
}
