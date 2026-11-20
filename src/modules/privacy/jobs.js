import { db } from '../../lib/db.js';
import { registerJob } from '../../lib/jobs.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../notifications/service.js';
import { buildExport, eraseMemberData } from './service.js';

/** Process an approved data request: export → ZIP + 'export.ready'; deletion → erase tracking data. */
export async function processDataRequest(requestId) {
  const reqRow = await db.one(
    `UPDATE data_requests SET status = 'processing' WHERE id = $1 AND status IN ('approved','processing') RETURNING *`,
    [requestId],
  );
  if (!reqRow) return null;
  const sys = { orgId: reqRow.organization_id, actorType: 'system' };
  try {
    if (reqRow.type === 'export') {
      const { key, size, manifest } = await buildExport(reqRow);
      await db.query(`UPDATE data_requests SET status = 'completed', processed_at = now(), file_key = $2 WHERE id = $1`, [reqRow.id, key]);
      await audit(sys, 'data_request.export_completed', { entityType: 'data_request', entityId: reqRow.id, after: { size, files: manifest.files } });
      await notify({
        orgId: reqRow.organization_id,
        memberIds: [reqRow.member_id],
        type: 'export.ready',
        title: 'Your data export is ready',
        body: 'Download your data export from your privacy settings. The link is valid for a limited time.',
        link: '/me/privacy',
        data: { dataRequestId: reqRow.id },
      });
    } else {
      const counts = await eraseMemberData(reqRow);
      await db.query(
        `UPDATE data_requests SET status = 'completed', processed_at = now(), notes = trim(coalesce(notes || E'\\n', '') || $2) WHERE id = $1`,
        [reqRow.id, `Erased: ${JSON.stringify(counts)}`],
      );
      await audit(sys, 'data_request.deletion_completed', { entityType: 'data_request', entityId: reqRow.id, after: counts });
      await notify({
        orgId: reqRow.organization_id,
        memberIds: [reqRow.member_id],
        type: 'approval.resolved',
        title: 'Your data deletion request was completed',
        body: 'Your tracking data (activity, app/web usage, screenshots, idle periods) has been deleted.',
        link: '/me/privacy',
        data: { dataRequestId: reqRow.id },
      });
    }
  } catch (err) {
    await db.query(`UPDATE data_requests SET status = 'approved' WHERE id = $1`, [reqRow.id]);
    throw err;
  }
  return db.one('SELECT * FROM data_requests WHERE id = $1', [reqRow.id]);
}

registerJob('privacy.process', async ({ requestId }) => {
  await processDataRequest(requestId);
});
