import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';
import { AppError, notFound, unauthenticated } from '../../lib/errors.js';
import { sha256 } from '../../lib/crypto.js';
import { verifyPassword } from '../../lib/password.js';
import { publicLimiter } from '../../middleware/rateLimit.js';
import { memberContext } from '../reports/common.js';
import { runReport } from '../reports/engine.js';
import { definitionSchema } from '../reports/service.js';

/** Unauthenticated, rate-limited public endpoints. */
const r = createRouter('/public', 'Public');

r.get(
  '/reports/:token',
  {
    auth: 'public',
    summary: 'View a shared read-only report (password via X-Share-Password header)',
    ids: 'RPT-A16',
    middleware: publicLimiter,
    params: z.object({ token: z.string().min(10).max(200) }),
  },
  async (req, res) => {
    const share = await db.one(
      `SELECT s.*, o.name AS org_name, o.status AS org_status FROM report_shares s JOIN organizations o ON o.id = s.organization_id
       WHERE s.token_hash = $1 AND o.deleted_at IS NULL`,
      [sha256(req.v.params.token)],
    );
    if (!share) throw notFound('Shared report');
    if (share.revoked_at) throw new AppError(410, 'SHARE_REVOKED', 'This shared report link has been revoked');
    if (share.expires_at && new Date(share.expires_at) <= new Date()) throw new AppError(410, 'SHARE_EXPIRED', 'This shared report link has expired');
    if (share.org_status !== 'active') throw new AppError(410, 'SHARE_UNAVAILABLE', 'This shared report is no longer available');
    if (share.password_hash) {
      const pw = req.get('x-share-password');
      if (!pw) throw unauthenticated('This shared report is password protected', 'SHARE_PASSWORD_REQUIRED');
      if (!(await verifyPassword(share.password_hash, pw))) throw unauthenticated('Incorrect password', 'SHARE_PASSWORD_INVALID');
    }
    // Run with the creator's scope so a share can never expose more than its creator could see.
    const ctx = await memberContext(share.created_by);
    if (!ctx || !ctx.can('reports.view')) throw new AppError(410, 'SHARE_UNAVAILABLE', 'This shared report is no longer available');
    const def = definitionSchema.parse(share.definition_snapshot);
    if (share.client_id) def.filters = { ...(def.filters ?? {}), clientIds: [share.client_id] };
    const report = await runReport(ctx, def);
    await db.query('UPDATE report_shares SET view_count = view_count + 1 WHERE id = $1', [share.id]);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    ok(res, {
      name: share.name,
      organization: { name: share.org_name },
      expiresAt: share.expires_at,
      generatedAt: new Date().toISOString(),
      report,
    });
  },
);

export default r;
