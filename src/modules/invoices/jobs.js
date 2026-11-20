import { registerCron } from '../../lib/jobs.js';
import { db } from '../../lib/db.js';

/** Mark sent/partially-paid invoices past their due date (org-local) as overdue (BILL-14). */
export async function markOverdueInvoices() {
  const r = await db.query(
    `UPDATE invoices i SET status = 'overdue', updated_at = now()
     FROM organizations o
     WHERE o.id = i.organization_id AND i.deleted_at IS NULL AND i.status IN ('sent','partially_paid')
       AND i.due_date IS NOT NULL AND i.due_date < (now() AT TIME ZONE o.timezone)::date`,
  );
  return r.rowCount;
}

registerCron('invoices.overdue', 60 * 60_000, markOverdueInvoices);
