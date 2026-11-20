import { registerCron } from '../../lib/jobs.js';
import { db } from '../../lib/db.js';
import { notify } from '../notifications/service.js';
import { getOrCreateTimesheet, lockTimesheet } from './service.js';

const DAY = 24 * 60 * 60_000;

/** TS-01: make sure every active (non-client) member has a timesheet for their current period. */
export async function generateTimesheets() {
  const members = await db.many(
    `SELECT m.id, m.organization_id FROM organization_members m
     JOIN organizations o ON o.id = m.organization_id AND o.status = 'active' AND o.deleted_at IS NULL
     JOIN roles r ON r.id = m.role_id
     WHERE m.status = 'active' AND m.deleted_at IS NULL AND r.base_role <> 'client'`,
  );
  let n = 0;
  for (const m of members) {
    await getOrCreateTimesheet(m.organization_id, m.id);
    n++;
  }
  return n;
}

/** Reminder once for ended periods still in draft (member-local). */
export async function sendTimesheetReminders() {
  const rows = await db.many(
    `SELECT ts.id, ts.organization_id, ts.member_id, ts.period_start, ts.period_end FROM timesheets ts
     JOIN organization_members m ON m.id = ts.member_id JOIN organizations o ON o.id = ts.organization_id
     WHERE ts.status = 'draft' AND ts.reminder_sent_at IS NULL AND ts.locked_at IS NULL AND m.status = 'active'
       AND ts.period_end < (now() AT TIME ZONE coalesce(m.timezone, o.timezone, 'UTC'))::date`,
  );
  for (const ts of rows) {
    const claimed = await db.one(`UPDATE timesheets SET reminder_sent_at = now() WHERE id = $1 AND reminder_sent_at IS NULL RETURNING id`, [ts.id]);
    if (!claimed) continue;
    await notify({
      orgId: ts.organization_id,
      memberIds: [ts.member_id],
      type: 'timesheet.reminder',
      title: 'Timesheet submission reminder',
      body: `Please submit your timesheet for ${ts.period_start} – ${ts.period_end}.`,
      link: `/timesheets/${ts.id}`,
      data: { timesheetId: ts.id },
    });
  }
  return rows.length;
}

/** TS-16: lock submitted/approved timesheets older than timesheet_lock_after_days after period end. */
export async function autoLockTimesheets() {
  const rows = await db.many(
    `SELECT ts.* FROM timesheets ts JOIN organization_settings s ON s.organization_id = ts.organization_id
     WHERE s.timesheet_lock_after_days IS NOT NULL AND ts.locked_at IS NULL AND ts.status IN ('submitted','approved')
       AND ts.period_end + s.timesheet_lock_after_days < current_date`,
  );
  for (const ts of rows) await lockTimesheet(ts, null, 'Auto-locked');
  return rows.length;
}

registerCron('timesheets.generate', DAY, generateTimesheets);
registerCron('timesheets.reminders', 60 * 60_000, sendTimesheetReminders);
registerCron('timesheets.autolock', 6 * 60 * 60_000, autoLockTimesheets);
