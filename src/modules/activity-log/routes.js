import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';
import { accessibleProjectIds } from '../../rbac/scope.js';

/** Recent activities feed (ADM-17). Org-wide for org-scope project viewers; otherwise accessible projects/tasks + own actions. */
const r = createRouter('/activity-log', 'Dashboard');

r.get(
  '/',
  {
    summary: 'Recent activities (ADM-17), newest first, cursor via `before`',
    ids: 'ADM-17',
    permission: 'projects.view',
    query: z.object({
      entityType: z.string().max(40).optional(),
      entityId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      before: z.iso.datetime({ offset: true }).optional(),
    }),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const q = req.v.query;
    const pids = await accessibleProjectIds(ctx, 'projects.view');
    const rows = await db.many(
      `SELECT a.*, trim(u.first_name || ' ' || u.last_name) AS actor_name
       FROM activity_log a LEFT JOIN organization_members m ON m.id = a.actor_member_id LEFT JOIN users u ON u.id = m.user_id
       WHERE a.organization_id = $1 AND ($2::text IS NULL OR a.entity_type = $2) AND ($3::uuid IS NULL OR a.entity_id = $3)
         AND ($4::timestamptz IS NULL OR a.created_at < $4)
         AND ($5::uuid[] IS NULL
              OR (a.entity_type = 'project' AND a.entity_id = ANY($5::uuid[]))
              OR (a.entity_type = 'task' AND a.entity_id IN (SELECT id FROM tasks WHERE project_id = ANY($5::uuid[])))
              OR a.actor_member_id = $6)
       ORDER BY a.created_at DESC LIMIT $7`,
      [ctx.orgId, q.entityType ?? null, q.entityId ?? null, q.before ?? null, pids, ctx.memberId, q.limit],
    );
    ok(res, rows.map((a) => ({
      id: a.id,
      entityType: a.entity_type,
      entityId: a.entity_id,
      action: a.action,
      changes: a.changes,
      actor: a.actor_member_id ? { id: a.actor_member_id, name: a.actor_name } : null,
      createdAt: a.created_at,
    })), { nextBefore: rows.length === q.limit ? rows[rows.length - 1].created_at : null });
  },
);

export default r;
