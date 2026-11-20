import { db } from '../../lib/db.js';
import { registerCron } from '../../lib/jobs.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../notifications/service.js';
import { projectManagerIds, projectAllMemberIds, adminMemberIds, projectTotals, budgetUsage } from './service.js';

const HOUR = 60 * 60_000;
const DEADLINE_DAYS_BEFORE = 3;

/**
 * PROJ-26: deadline notifications — once when the deadline is within 3 days and once when overdue.
 * Idempotent per (project, kind, deadline) by checking previously sent notifications, so changing
 * the deadline re-arms the alerts.
 */
export async function sendProjectDeadlineAlerts() {
  const rows = await db.many(
    `SELECT p.id, p.name, p.organization_id, p.deadline,
       CASE WHEN p.deadline < (now() AT TIME ZONE o.timezone)::date THEN 'overdue' ELSE 'upcoming' END AS kind
     FROM projects p JOIN organizations o ON o.id = p.organization_id AND o.deleted_at IS NULL
     WHERE p.deleted_at IS NULL AND p.archived_at IS NULL AND p.status NOT IN ('completed','cancelled') AND p.deadline IS NOT NULL
       AND p.deadline <= (now() AT TIME ZONE o.timezone)::date + ${DEADLINE_DAYS_BEFORE}`,
  );
  let sent = 0;
  for (const p of rows) {
    try {
      const already = await db.one(
        `SELECT 1 FROM notifications WHERE organization_id = $1 AND type = 'project.deadline'
           AND data->>'projectId' = $2 AND data->>'kind' = $3 AND data->>'deadline' = $4 LIMIT 1`,
        [p.organization_id, p.id, p.kind, p.deadline],
      );
      if (already) continue;
      const recipients = p.kind === 'overdue' ? [...new Set([...(await projectManagerIds(p.id)), ...(await adminMemberIds(p.organization_id))])] : await projectAllMemberIds(p.id);
      if (!recipients.length) continue;
      await notify({
        orgId: p.organization_id,
        memberIds: recipients,
        type: 'project.deadline',
        title: p.kind === 'overdue' ? `Project overdue: ${p.name}` : `Project deadline approaching: ${p.name}`,
        body: p.kind === 'overdue' ? `The deadline (${p.deadline}) has passed.` : `The project is due on ${p.deadline}.`,
        link: `/projects/${p.id}`,
        data: { projectId: p.id, kind: p.kind, deadline: p.deadline },
      });
      sent++;
    } catch (err) {
      logger.error({ err, projectId: p.id }, 'project deadline alert failed');
    }
  }
  return sent;
}

/** PROJ-10: budget alerts at organization_settings.budget_alert_percents (each threshold once). */
export async function sendProjectBudgetAlerts() {
  const rows = await db.many(
    `SELECT p.*, o.timezone AS org_timezone, coalesce(s.budget_alert_percents, '{80,100}') AS thresholds
     FROM projects p JOIN organizations o ON o.id = p.organization_id AND o.deleted_at IS NULL
     LEFT JOIN organization_settings s ON s.organization_id = p.organization_id
     WHERE p.deleted_at IS NULL AND p.archived_at IS NULL AND p.budget_type <> 'none' AND p.budget_value > 0`,
  );
  let sent = 0;
  for (const p of rows) {
    try {
      const totals = await projectTotals(p.organization_id, p.id, { tz: p.org_timezone });
      const usage = budgetUsage(p, totals);
      if (usage.percent === null) continue;
      const already = (p.budget_alerts_sent ?? []).map(Number);
      const crossed = (p.thresholds ?? []).map(Number).filter((t) => usage.percent >= t && !already.includes(t));
      if (!crossed.length) continue;
      const top = Math.max(...crossed);
      await db.query(`UPDATE projects SET budget_alerts_sent = $2::smallint[] WHERE id = $1`, [p.id, [...new Set([...already, ...crossed])].sort((a, b) => a - b)]);
      const recipients = [...new Set([...(await projectManagerIds(p.id)), ...(await adminMemberIds(p.organization_id))])];
      if (!recipients.length) continue;
      const unit = p.budget_type === 'hours' ? 'hours' : p.currency ?? '';
      await notify({
        orgId: p.organization_id,
        memberIds: recipients,
        type: 'project.budget',
        title: `${p.name} has used ${usage.percent}% of its budget`,
        body: `Budget: ${usage.value} ${unit}. Used: ${usage.used} ${unit} (threshold ${top}% reached).`,
        link: `/projects/${p.id}`,
        data: { projectId: p.id, percent: usage.percent, threshold: top, used: usage.used, budget: usage.value, budgetType: p.budget_type },
      });
      sent++;
    } catch (err) {
      logger.error({ err, projectId: p.id }, 'project budget alert failed');
    }
  }
  return sent;
}

registerCron('projects.deadline_alerts', HOUR, sendProjectDeadlineAlerts);
registerCron('projects.budget_alerts', 15 * 60_000, sendProjectBudgetAlerts);
