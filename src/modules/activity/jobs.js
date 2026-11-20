import { db } from '../../lib/db.js';
import { registerCron } from '../../lib/jobs.js';
import { notify, usersWithPermission } from '../notifications/service.js';
import { ACTIVITY_NOTE } from './service.js';

const INTERVALS = 3;

/**
 * Low activity alerts (ACT-15): while a member is tracking (running, not paused), when the last 3
 * activity intervals are all at or below the org's `activity_low_max`, notify the member and their
 * approvers — at most once per hour per member.
 */
export async function runLowActivityAlerts() {
  const tracking = await db.many(
    `SELECT e.member_id, e.organization_id, e.started_at, s.activity_low_max
     FROM time_entries e
     JOIN organization_settings s ON s.organization_id = e.organization_id
     JOIN organizations o ON o.id = e.organization_id AND o.status = 'active'
     WHERE e.ended_at IS NULL AND e.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM time_entry_pauses p WHERE p.time_entry_id = e.id AND p.ended_at IS NULL)`,
  );
  let sent = 0;
  for (const t of tracking) {
    const last = await db.many(
      `SELECT activity_percent, interval_start FROM activity_samples
       WHERE member_id = $1 AND interval_start >= $2 AND interval_start > now() - interval '30 minutes'
       ORDER BY interval_start DESC LIMIT $3`,
      [t.member_id, t.started_at, INTERVALS],
    );
    if (last.length < INTERVALS || !last.every((x) => x.activity_percent <= t.activity_low_max)) continue;
    const recent = await db.one(
      `SELECT 1 FROM notifications WHERE organization_id = $1 AND type = 'activity.low' AND data->>'memberId' = $2 AND created_at > now() - interval '1 hour' LIMIT 1`,
      [t.organization_id, t.member_id],
    );
    if (recent) continue;
    const avg = Math.round(last.reduce((s, x) => s + x.activity_percent, 0) / last.length);
    const approvers = await usersWithPermission(t.organization_id, 'activity.view', { memberId: t.member_id });
    const name = await db.one(`SELECT u.first_name || ' ' || u.last_name AS n FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.id = $1`, [t.member_id]);
    await notify({
      orgId: t.organization_id,
      memberIds: [t.member_id],
      userIds: approvers,
      type: 'activity.low',
      title: 'Low activity detected',
      body: `Activity for ${name?.n ?? 'a member'} has been low (${avg}%) over the last ${INTERVALS} intervals. ${ACTIVITY_NOTE}`,
      link: `/activity?memberId=${t.member_id}`,
      data: { memberId: t.member_id, averageActivityPercent: avg, intervals: INTERVALS, threshold: t.activity_low_max },
      email: false,
    });
    sent++;
  }
  return { sent };
}

registerCron('alerts.low_activity', 30 * 60_000, runLowActivityAlerts);
