import { ZipArchive } from 'archiver';
import { PassThrough } from 'node:stream';
import { stringify } from 'csv-stringify/sync';
import { db } from '../../lib/db.js';
import { putObject, getObject, deleteObject, buildKey } from '../../lib/storage.js';
import { logger } from '../../lib/logger.js';

/**
 * PRIV-07/08 (SEC-19/20): member data export (ZIP of JSON/CSV + screenshot files) and erasure of
 * member-generated tracking data. Financial / approved time records are kept but notes are anonymized.
 */
export const DATASETS = {
  time_entries: `SELECT te.id, te.started_at, te.ended_at, te.duration_seconds, te.paused_seconds, te.idle_seconds, te.active_seconds,
      te.entry_type, te.source, te.is_offline, te.is_billable, te.status, te.note, p.name AS project, t.title AS task, te.created_at
    FROM time_entries te LEFT JOIN projects p ON p.id = te.project_id LEFT JOIN tasks t ON t.id = te.task_id
    WHERE te.member_id = $1 AND te.deleted_at IS NULL ORDER BY te.started_at`,
  activity_samples: `SELECT interval_start, interval_seconds, keyboard_active_seconds, mouse_active_seconds, active_seconds, activity_percent
    FROM activity_samples WHERE member_id = $1 ORDER BY interval_start`,
  app_usage: `SELECT app_identifier, app_name, window_title, started_at, ended_at, duration_seconds FROM app_usage WHERE member_id = $1 ORDER BY started_at`,
  web_usage: `SELECT browser, domain, url, title, started_at, ended_at, duration_seconds FROM web_usage WHERE member_id = $1 AND NOT is_excluded ORDER BY started_at`,
  idle_periods: `SELECT started_at, ended_at, duration_seconds, resolution, note FROM idle_periods WHERE member_id = $1 ORDER BY started_at`,
  attendance: `SELECT date, status, check_in_at, check_out_at, late_minutes, early_leave_minutes, worked_seconds, overtime_seconds, work_mode, note
    FROM attendance_records WHERE member_id = $1 ORDER BY date`,
  daily_summaries: `SELECT date, tracked_seconds, active_seconds, idle_seconds, break_seconds, productive_seconds, unproductive_seconds, neutral_seconds,
      billable_seconds, overtime_seconds, activity_percent, screenshot_count FROM daily_summaries WHERE member_id = $1 ORDER BY date`,
};

const csv = (rows) => (rows.length ? stringify(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))), { header: true }) : '');

/** Build the export ZIP in memory and store it (purpose 'export'). Returns the storage key. */
export async function buildExport(request) {
  const memberId = request.member_id;
  const profile = await db.one(
    `SELECT m.id AS member_id, m.employee_code, m.designation, m.employment_type, m.joined_on, m.work_mode, m.timezone, m.status,
            u.email, u.first_name, u.last_name, u.phone, u.timezone AS user_timezone, u.locale, o.name AS organization
     FROM organization_members m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id WHERE m.id = $1`,
    [memberId],
  );
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    sink.on('end', resolve);
    archive.on('error', reject);
    sink.on('error', reject);
  });
  archive.pipe(sink);

  const manifest = { generatedAt: new Date().toISOString(), requestId: request.id, memberId, files: [] };
  archive.append(JSON.stringify(profile, null, 2), { name: 'profile.json' });
  for (const [name, sql] of Object.entries(DATASETS)) {
    const rows = await db.many(sql, [memberId]);
    archive.append(JSON.stringify(rows, null, 2), { name: `${name}.json` });
    archive.append(csv(rows), { name: `${name}.csv` });
    manifest.files.push({ name, rows: rows.length });
  }
  const shots = await db.many(
    `SELECT id, captured_at, monitor_index, activity_percent, app_name, window_title, object_key, blurred_key, is_blurred, width, height
     FROM screenshots WHERE member_id = $1 AND deleted_at IS NULL ORDER BY captured_at`,
    [memberId],
  );
  let included = 0;
  for (const s of shots) {
    const key = s.is_blurred && s.blurred_key ? s.blurred_key : s.object_key;
    try {
      const buf = await getObject(key);
      const ext = (key.match(/\.[a-z0-9]+$/i)?.[0] ?? '.jpg').toLowerCase();
      archive.append(buf, { name: `screenshots/${new Date(s.captured_at).toISOString().replace(/[:.]/g, '-')}_${s.id}${ext}` });
      included++;
    } catch {
      /* object missing from storage — metadata still exported */
    }
  }
  archive.append(JSON.stringify(shots.map(({ object_key, blurred_key, ...rest }) => rest), null, 2), { name: 'screenshots.json' });
  manifest.files.push({ name: 'screenshots', rows: shots.length, filesIncluded: included });
  archive.append(JSON.stringify(manifest, null, 2), { name: 'README.json' });
  await archive.finalize();
  await done;
  const buffer = Buffer.concat(chunks);
  const key = buildKey({ orgId: request.organization_id, purpose: 'export', ext: '.zip' });
  await putObject(key, buffer, { contentType: 'application/zip', orgId: request.organization_id, purpose: 'export' });
  return { key, size: buffer.length, manifest };
}

/** Erase member-generated tracking data; keep time/financial records with notes anonymized. */
export async function eraseMemberData(request) {
  const memberId = request.member_id;
  const orgId = request.organization_id;
  const keys = [];
  const counts = await db.tx(async () => {
    const shots = await db.many(
      `DELETE FROM screenshots WHERE member_id = $1 AND organization_id = $2 RETURNING object_key, thumb_key, blurred_key`,
      [memberId, orgId],
    );
    for (const s of shots) keys.push(s.object_key, s.thumb_key, s.blurred_key);
    const del = async (table) => (await db.query(`DELETE FROM ${table} WHERE member_id = $1 AND organization_id = $2`, [memberId, orgId])).rowCount;
    const out = {
      screenshots: shots.length,
      activitySamples: await del('activity_samples'),
      appUsage: await del('app_usage'),
      webUsage: await del('web_usage'),
      idlePeriods: await del('idle_periods'),
    };
    out.timeEntriesAnonymized = (
      await db.query(
        `UPDATE time_entries SET note = NULL, edit_reason = NULL, approval_reason = NULL WHERE member_id = $1 AND organization_id = $2 AND (note IS NOT NULL OR edit_reason IS NOT NULL OR approval_reason IS NOT NULL)`,
        [memberId, orgId],
      )
    ).rowCount;
    await db.query(
      `UPDATE daily_summaries SET active_seconds = 0, idle_seconds = 0, productive_seconds = 0, unproductive_seconds = 0, neutral_seconds = 0,
         activity_percent = 0, screenshot_count = 0, updated_at = now() WHERE member_id = $1 AND organization_id = $2`,
      [memberId, orgId],
    );
    await db.query(`UPDATE attendance_records SET note = NULL WHERE member_id = $1 AND organization_id = $2`, [memberId, orgId]);
    return out;
  });
  for (const k of keys.filter(Boolean)) {
    try {
      await deleteObject(k);
    } catch (err) {
      logger.warn({ err, key: k }, 'failed to delete screenshot object during erasure');
    }
  }
  return counts;
}
