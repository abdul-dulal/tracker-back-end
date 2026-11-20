import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, paginationQuery, pageMeta } from '../../lib/http.js';
import { accessibleMemberIds, accessibleProjectIds } from '../../rbac/scope.js';
import { APPROVAL_TYPES, pendingApprovals, approvalCounts, canApproveAnything } from './service.js';

const APPROVE_PERMS = Object.values(APPROVAL_TYPES);

const approvals = createRouter('/approvals', 'Approvals');

approvals.get(
  '/pending',
  {
    summary: 'Pending approvals the caller can act on (ADM-13…15)',
    ids: 'ADM-13,ADM-14,ADM-15',
    permission: APPROVE_PERMS,
    query: paginationQuery.pick({ page: true, limit: true }).extend({ type: z.enum(Object.keys(APPROVAL_TYPES)).optional() }),
  },
  async (req, res) => {
    const q = req.v.query;
    const { items, total } = await pendingApprovals(req.ctx, { type: q.type, limit: q.limit, offset: (q.page - 1) * q.limit });
    ok(res, items, pageMeta(q, total));
  },
);

approvals.get(
  '/counts',
  { summary: 'Pending approval counts by type', ids: 'ADM-13', permission: APPROVE_PERMS },
  async (req, res) => ok(res, await approvalCounts(req.ctx)),
);

// ───────────────────────── Action center (ADM-16) ─────────────────────────
const actionCenter = createRouter('/action-center', 'Approvals');

actionCenter.get(
  '/',
  { summary: 'Action center: approvals + open system alerts + open sync conflicts + overdue tasks (ADM-16)', ids: 'ADM-16,ADM-18' },
  async (req, res) => {
    const ctx = req.ctx;
    const out = { approvals: null, systemAlerts: null, syncConflicts: null, overdueTasks: null };
    if (canApproveAnything(ctx)) {
      const { items, total } = await pendingApprovals(ctx, { limit: 10 });
      out.approvals = { counts: await approvalCounts(ctx), total, items };
    }
    if (ctx.can('organization.update')) {
      const alerts = await db.many(
        'SELECT * FROM system_alerts WHERE organization_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 50',
        [ctx.orgId],
      );
      out.systemAlerts = alerts.map((a) => ({ id: a.id, type: a.type, severity: a.severity, message: a.message, data: a.data, createdAt: a.created_at }));
    }
    if (ctx.can('time.view')) {
      const ids = await accessibleMemberIds(ctx, 'time.view');
      const rows = await db.many(
        `SELECT sc.id, sc.member_id, sc.entity_type, sc.created_at, trim(u.first_name || ' ' || u.last_name) AS member_name
         FROM sync_conflicts sc JOIN organization_members m ON m.id = sc.member_id JOIN users u ON u.id = m.user_id
         WHERE sc.organization_id = $1 AND sc.status = 'open' AND ($2::uuid[] IS NULL OR sc.member_id = ANY($2::uuid[]))
         ORDER BY sc.created_at DESC LIMIT 50`,
        [ctx.orgId, ids],
      );
      out.syncConflicts = {
        total: rows.length,
        items: rows.map((r) => ({ id: r.id, entityType: r.entity_type, member: { id: r.member_id, name: r.member_name }, createdAt: r.created_at })),
      };
    }
    if (ctx.can('tasks.view')) {
      const pids = await accessibleProjectIds(ctx, 'tasks.view');
      const own = ctx.can('tasks.view') === 'own';
      const r = await db.one(
        `SELECT count(*)::int AS n FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.organization_id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND t.completed_at IS NULL
           AND t.due_date < (now() AT TIME ZONE $4)::date AND ($2::uuid[] IS NULL OR t.project_id = ANY($2::uuid[]))
           AND (NOT $3 OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.member_id = $5))`,
        [ctx.orgId, pids, own, ctx.timezone ?? 'UTC', ctx.memberId],
      );
      out.overdueTasks = r.n;
    }
    ok(res, out);
  },
);

export default [approvals, actionCenter];
