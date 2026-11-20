import { registerCron } from '../../lib/jobs.js';
import { subscribe } from '../../lib/events.js';
import { db } from '../../lib/db.js';
import { checkIn, checkOut, orgSettings, detectAbsences, autoCheckout } from './service.js';

/** Auto check-in on the first timer start of the member-local day (ATT-01, org setting). */
subscribe('timer.started', async ({ orgId, memberId, entry }) => {
  if (!orgId || !memberId) return;
  const s = await orgSettings(orgId);
  if (!s.attendance_auto_checkin) return;
  await checkIn(orgId, memberId, { at: entry?.startedAt ? new Date(entry.startedAt) : new Date(), source: 'timer' });
});

/** Timer stop extends the check-out and refreshes worked seconds (ATT-02). */
subscribe('timer.stopped', async ({ orgId, memberId, entry }) => {
  if (!orgId || !memberId) return;
  const at = entry?.endedAt ? new Date(entry.endedAt) : new Date();
  // Only records opened by the timer/agent follow timer stops; manual check-ins keep their manual check-out.
  const m = await db.one(
    `SELECT a.check_in_source, a.check_out_at FROM attendance_records a
     WHERE a.member_id = $1 AND a.check_in_at IS NOT NULL AND a.check_in_at <= $2 ORDER BY a.date DESC LIMIT 1`,
    [memberId, at],
  );
  if (!m) return;
  if (m.check_out_at && !['timer', 'agent'].includes(m.check_in_source)) return;
  await checkOut(orgId, memberId, { at, source: 'timer' });
});

registerCron('attendance.absent', 60 * 60_000, () => detectAbsences());
registerCron('attendance.auto_checkout', 60 * 60_000, () => autoCheckout());
