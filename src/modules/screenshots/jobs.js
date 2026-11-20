import sharp from 'sharp';
import { ZipArchive } from 'archiver';
import { db } from '../../lib/db.js';
import { registerJob, registerCron } from '../../lib/jobs.js';
import { getObject, putObject, buildKey, signedGetUrl } from '../../lib/storage.js';
import { logger } from '../../lib/logger.js';
import { getEffectiveSettings } from '../settings/effective.js';
import { recomputeRange } from '../time/summary-service.js';
import { notify } from '../notifications/service.js';
import { blurredThumbKey, deleteScreenshotObjects, bumpScreenshotCounter, visibleKeys, screenshotFilter } from './service.js';

const THUMB_WIDTH = 400;
const BLUR_SIGMA = 24;
const EXPORT_TTL_DAYS = 7;

/**
 * Screenshot post-processing (SS-12, SS-16): 400px webp thumbnail and, when the blur setting applies,
 * a blurred full-size image + blurred thumbnail. Originals are never modified.
 */
registerJob('screenshots.process', async ({ screenshotId }) => {
  const s = await db.one('SELECT * FROM screenshots WHERE id = $1 AND deleted_at IS NULL', [screenshotId]);
  if (!s) return;
  const original = await getObject(s.object_key);
  const meta = { orgId: s.organization_id, purpose: 'screenshot' };
  let thumbKey = s.thumb_key;
  if (!thumbKey) {
    const thumb = await sharp(original).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    thumbKey = buildKey({ ...meta, ext: '.webp' });
    await putObject(thumbKey, thumb, { ...meta, contentType: 'image/webp' });
  }
  let blurredKey = s.blurred_key;
  let isBlurred = s.is_blurred;
  if (!isBlurred) {
    const { settings } = await getEffectiveSettings(s.organization_id, { memberId: s.member_id, projectId: s.project_id });
    isBlurred = !!settings.screenshotBlur;
  }
  if (isBlurred && !blurredKey) {
    const blurred = await sharp(original).blur(BLUR_SIGMA).webp({ quality: 70 }).toBuffer();
    blurredKey = buildKey({ ...meta, ext: '.webp' });
    await putObject(blurredKey, blurred, { ...meta, contentType: 'image/webp' });
    const bthumb = await sharp(blurred).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 60 }).toBuffer();
    await putObject(blurredThumbKey(blurredKey), bthumb, { ...meta, contentType: 'image/webp' });
  }
  await db.query('UPDATE screenshots SET thumb_key = $2, blurred_key = $3, is_blurred = $4 WHERE id = $1', [s.id, thumbKey, blurredKey, isBlurred]);
});

/** ZIP export of screenshots (SS-25) → storage purpose 'export' → 'export.ready' notification. */
registerJob('screenshots.export', async ({ exportJobId }) => {
  const job = await db.one(`UPDATE export_jobs SET status = 'running' WHERE id = $1 AND status IN ('queued','running') RETURNING *`, [exportJobId]);
  if (!job) return;
  const p = job.params ?? {};
  try {
    const w = await screenshotFilter({ orgId: job.organization_id, timezone: p.timezone ?? 'UTC' }, p.filters ?? {}, { memberIds: p.memberIds ?? null });
    const rows = await db.many(
      `SELECT s.*, u.first_name, u.last_name FROM screenshots s JOIN organization_members m ON m.id = s.member_id JOIN users u ON u.id = m.user_id
       ${w.sql} ORDER BY s.captured_at LIMIT 5000`,
      w.params,
    );
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const chunks = [];
    const done = new Promise((resolve, reject) => {
      archive.on('data', (c) => chunks.push(c));
      archive.on('end', resolve);
      archive.on('error', reject);
      archive.on('warning', (e) => logger.warn({ err: e }, 'zip warning'));
    });
    const manifest = [];
    for (const s of rows) {
      const k = visibleKeys(s, p.viewerMemberId);
      if (!k.full) continue;
      let buf;
      try {
        buf = await getObject(k.full);
      } catch {
        continue;
      }
      const who = `${s.first_name}-${s.last_name}`.replace(/[^\w-]+/g, '_');
      const name = `${who}/${new Date(s.captured_at).toISOString().replace(/[:.]/g, '-')}-m${s.monitor_index}.${k.full.split('.').pop()}`;
      archive.append(buf, { name });
      manifest.push({ file: name, memberId: s.member_id, capturedAt: s.captured_at, activityPercent: s.activity_percent, appName: s.app_name, blurred: k.blurred });
    }
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    await archive.finalize();
    await done;
    const zip = Buffer.concat(chunks);
    const key = buildKey({ orgId: job.organization_id, purpose: 'export', ext: '.zip' });
    const fileName = `screenshots-${new Date().toISOString().slice(0, 10)}.zip`;
    await putObject(key, zip, { orgId: job.organization_id, purpose: 'export', contentType: 'application/zip', userId: p.viewerUserId });
    await db.query(
      `UPDATE export_jobs SET status = 'done', file_key = $2, file_name = $3, finished_at = now(), expires_at = now() + ($4 || ' days')::interval, error = NULL WHERE id = $1`,
      [job.id, key, fileName, String(EXPORT_TTL_DAYS)],
    );
    const url = signedGetUrl(key, { download: true, filename: fileName, ttl: 24 * 3600 });
    await notify({
      orgId: job.organization_id,
      memberIds: job.requested_by ? [job.requested_by] : [],
      type: 'export.ready',
      title: 'Your screenshot export is ready',
      body: `${manifest.length} screenshot${manifest.length === 1 ? '' : 's'} exported. The download link expires in 24 hours.`,
      link: url,
      data: { exportJobId: job.id, downloadUrl: url, count: manifest.length },
    });
  } catch (err) {
    await db.query(`UPDATE export_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [job.id, String(err?.message ?? err).slice(0, 1000)]);
    throw err;
  }
});

/**
 * Nightly retention (SS-24): delete screenshots older than the member's effective retention (bounded
 * by the plan, SUB-19), including stored objects; storage usage counters are updated.
 */
export async function runScreenshotRetention() {
  const members = await db.many(
    `SELECT DISTINCT s.organization_id, s.member_id FROM screenshots s WHERE s.deleted_at IS NULL AND s.captured_at < now() - interval '1 day'`,
  );
  let deleted = 0;
  for (const m of members) {
    const { settings } = await getEffectiveSettings(m.organization_id, { memberId: m.member_id });
    const days = settings.screenshotRetentionDays ?? 30;
    const rows = await db.many(
      `SELECT * FROM screenshots WHERE member_id = $1 AND deleted_at IS NULL AND captured_at < now() - ($2 || ' days')::interval LIMIT 5000`,
      [m.member_id, String(days)],
    );
    if (!rows.length) continue;
    for (const row of rows) {
      await deleteScreenshotObjects(row);
      await db.query('DELETE FROM screenshots WHERE id = $1', [row.id]);
    }
    await bumpScreenshotCounter(m.organization_id, -rows.length);
    const times = rows.map((x) => new Date(x.captured_at).getTime());
    await recomputeRange(m.member_id, new Date(Math.min(...times)), new Date(Math.max(...times)));
    deleted += rows.length;
  }
  // Objects of screenshots soft-deleted earlier are already gone; purge the rows after 30 days.
  await db.query(`DELETE FROM screenshots WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'`);
  return { deleted };
}

registerCron('screenshots.retention', 24 * 3600_000, runScreenshotRetention);
