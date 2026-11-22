import { db } from '../../lib/db.js';
import { registerCron } from '../../lib/jobs.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../notifications/service.js';
import { projectManagerIds } from '../projects/service.js';

const HOUR = 60 * 60_000;

async function assignees(taskId) {
  return (await db.many('SELECT member_id FROM task_assignees WHERE task_id = $1', [taskId])).map((r) => r.member_id);
}

/** TASK-25: "due tomorrow" reminder (org-local date), sent once per due date. */
export async function sendDueReminders() {
  const rows = await db.many(
    `UPDATE tasks t SET due_reminder_sent_at = now()
     FROM projects p, organizations o
     WHERE p.id = t.project_id AND o.id = t.organization_id
       AND p.deleted_at IS NULL AND p.archived_at IS NULL AND o.deleted_at IS NULL
       AND t.deleted_at IS NULL AND t.completed_at IS NULL AND t.due_reminder_sent_at IS NULL
       AND t.due_date = (now() AT TIME ZONE o.timezone)::date + 1
     RETURNING t.id, t.title, t.project_id, t.organization_id, t.due_date, p.name AS project_name`,
  );
  for (const t of rows) {
    try {
      const ids = await assignees(t.id);
      if (!ids.length) continue;
      await notify({
        orgId: t.organization_id,
        memberIds: ids,
        type: 'task.deadline_reminder',
        title: `Task due tomorrow: ${t.title}`,
        body: `"${t.title}" in ${t.project_name} is due on ${t.due_date}.`,
        link: `/tasks/${t.id}`,
        data: { taskId: t.id, projectId: t.project_id, dueDate: t.due_date },
      });
    } catch (err) {
      logger.error({ err, taskId: t.id }, 'due reminder failed');
    }
  }
  return rows.length;
}

/** TASK-26: overdue alert to assignees + project managers, sent once per due date. */
export async function sendOverdueAlerts() {
  const rows = await db.many(
    `UPDATE tasks t SET overdue_alert_sent_at = now()
     FROM projects p, organizations o
     WHERE p.id = t.project_id AND o.id = t.organization_id
       AND p.deleted_at IS NULL AND p.archived_at IS NULL AND o.deleted_at IS NULL
       AND t.deleted_at IS NULL AND t.completed_at IS NULL AND t.overdue_alert_sent_at IS NULL
       AND t.due_date < (now() AT TIME ZONE o.timezone)::date
     RETURNING t.id, t.title, t.project_id, t.organization_id, t.due_date, p.name AS project_name`,
  );
  for (const t of rows) {
    try {
      const ids = [...new Set([...(await assignees(t.id)), ...(await projectManagerIds(t.project_id))])];
      if (!ids.length) continue;
      await notify({
        orgId: t.organization_id,
        memberIds: ids,
        type: 'task.overdue',
        title: `Task overdue: ${t.title}`,
        body: `"${t.title}" in ${t.project_name} was due on ${t.due_date}.`,
        link: `/tasks/${t.id}`,
        data: { taskId: t.id, projectId: t.project_id, dueDate: t.due_date },
      });
    } catch (err) {
      logger.error({ err, taskId: t.id }, 'overdue alert failed');
    }
  }
  return rows.length;
}

registerCron('tasks.due_reminders', HOUR, sendDueReminders);
registerCron('tasks.overdue_alerts', HOUR, sendOverdueAlerts);
