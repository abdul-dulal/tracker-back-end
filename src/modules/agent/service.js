import { z } from 'zod';
import { db } from '../../lib/db.js';
import { AppError, unprocessable } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { emitToUser, emitToLive } from '../../lib/realtime.js';
import { enqueue } from '../../lib/jobs.js';
import { assertUploaded } from '../../lib/storage.js';
import { getEffectiveSettings, consentStatus } from '../settings/effective.js';
import { recomputeRange } from '../time/summary-service.js';
import { finalizeEntry, getRunningEntry, pauseTimer } from '../time/timer-service.js';
import { notify, usersWithPermission } from '../notifications/service.js';
import { getThresholds } from '../activity/service.js';
import { bumpScreenshotCounter } from '../screenshots/service.js';

/**
 * Desktop agent ingestion (guide §M06/M07/M08/M13/M20). Used by the live /agent/* endpoints and by
 * the offline /agent/sync batch. Every ingest function returns per-item results
 * `{ type, clientUuid, status: ok|duplicate|conflict|error, id?, message? }` and never throws for a
 * single bad item.
 *
 * PRIVACY: payload schemas are strict (unknown fields → 400). There is no field for keystroke content,
 * key codes or pointer coordinates anywhere — only per-interval activity seconds.
 */

export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
export const MAX_OFFLINE_AGE_MS = 30 * 24 * 3600_000;

export const zTs = z.iso.datetime({ offset: true });
const zSec = z.number().int().min(0).max(3600);

// ─── Item schemas (strict) ──────────────────────────────────────────────────
export const activitySample = z.strictObject({
  clientUuid: z.uuid().optional(),
  intervalStart: zTs,
  intervalSeconds: z.number().int().min(1).max(3600),
  keyboardActiveSeconds: zSec,
  mouseActiveSeconds: zSec,
  activeSeconds: zSec,
});
export const appUsageItem = z.strictObject({
  clientUuid: z.uuid().optional(),
  appIdentifier: z.string().trim().min(1).max(200).optional(),
  appName: z.string().trim().min(1).max(200),
  windowTitle: z.string().max(500).nullable().optional(),
  startedAt: zTs,
  endedAt: zTs,
});
export const webUsageItem = z.strictObject({
  clientUuid: z.uuid().optional(),
  browser: z.enum(['chrome', 'firefox', 'edge', 'safari', 'other']).default('other'),
  domain: z.string().trim().min(1).max(255),
  url: z.string().max(4000).nullable().optional(),
  title: z.string().max(500).nullable().optional(),
  startedAt: zTs,
  endedAt: zTs,
});
export const idleItem = z.strictObject({
  clientUuid: z.uuid().optional(),
  startedAt: zTs,
  endedAt: zTs,
});
export const screenshotItem = z.strictObject({
  key: z.string().min(5).max(400),
  clientUuid: z.uuid(),
  captureGroupId: z.uuid().optional(),
  monitorIndex: z.number().int().min(0).max(31).default(0),
  capturedAt: zTs,
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
  activityPercent: z.number().int().min(0).max(100).optional(),
  appName: z.string().max(200).nullable().optional(),
  windowTitle: z.string().max(500).nullable().optional(),
});

/** Ingestion identity: { orgId, memberId, deviceId, userId }. */
export const ingestCtx = (ctx) => ({ orgId: ctx.orgId, memberId: ctx.memberId, deviceId: ctx.deviceId ?? null, userId: ctx.userId, ctx });

// ─── Generic helpers ────────────────────────────────────────────────────────
/** Validate a timestamp/range; returns an error message or null (SYNC-11). */
export function checkRange(start, end, { maxAgeMs = MAX_OFFLINE_AGE_MS } = {}) {
  const now = Date.now();
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : s;
  if (Number.isNaN(s) || Number.isNaN(e)) return 'Invalid timestamp';
  if (s > now + MAX_FUTURE_SKEW_MS || e > now + MAX_FUTURE_SKEW_MS) return 'Timestamp is in the future';
  if (s < now - maxAgeMs) return 'Timestamp is too old (older than the maximum offline age)';
  if (e < s) return 'End time is before start time';
  return null;
}

/** Semantic version comparison: -1 | 0 | 1. Pre-release suffixes are ignored. */
export function cmpVersion(a, b) {
  const pa = String(a ?? '0').split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b ?? '0').split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Newest release flagged min_supported for an OS (DESK-22). */
export async function minSupportedRelease(os) {
  if (!['windows', 'macos', 'linux'].includes(os)) return null;
  return db.one(`SELECT * FROM app_releases WHERE os = $1 AND min_supported ORDER BY published_at DESC LIMIT 1`, [os]);
}

export async function latestRelease(os, channel = 'stable') {
  return db.one(`SELECT * FROM app_releases WHERE os = $1 AND channel = $2 ORDER BY published_at DESC LIMIT 1`, [os, channel]);
}

/** Throw 426 AGENT_UPGRADE_REQUIRED when the agent version is below the minimum supported one. */
export async function assertVersionSupported(os, appVersion) {
  const min = await minSupportedRelease(os);
  if (min && cmpVersion(appVersion, min.version) < 0) {
    const latest = await latestRelease(os, 'stable');
    throw new AppError(426, 'AGENT_UPGRADE_REQUIRED', `Version ${appVersion} is no longer supported. Please update to ${min.version} or later.`, {
      minVersion: min.version,
      latestVersion: latest?.version ?? min.version,
      downloadUrl: latest?.url ?? min.url,
    });
  }
}

/** The member's time entry covering instant `at` (running entries extend to now). */
export async function findEntryAt(memberId, at) {
  return db.one(
    `SELECT id, project_id, task_id, status, ended_at, started_at FROM time_entries
     WHERE member_id = $1 AND deleted_at IS NULL AND started_at <= $2 AND coalesce(ended_at, now() + interval '5 minutes') > $2
     ORDER BY started_at DESC LIMIT 1`,
    [memberId, at],
  );
}

/** Effective tracking settings for the member, using the project of the running entry. */
export async function memberSettings(orgId, memberId, projectId) {
  if (projectId === undefined) {
    const run = await db.one('SELECT project_id FROM time_entries WHERE member_id = $1 AND ended_at IS NULL AND deleted_at IS NULL', [memberId]);
    projectId = run?.project_id ?? null;
  }
  return (await getEffectiveSettings(orgId, { memberId, projectId })).settings;
}

/** Agent configuration (DESK, SS-P1/P2): effective settings, consent, thresholds, indicator rules. */
export async function buildAgentConfig(orgId, memberId) {
  const run = await db.one('SELECT project_id FROM time_entries WHERE member_id = $1 AND ended_at IS NULL AND deleted_at IS NULL', [memberId]);
  const { settings, version } = await getEffectiveSettings(orgId, { memberId, projectId: run?.project_id ?? null });
  const consent = await consentStatus(orgId, memberId);
  const th = await getThresholds(orgId);
  return {
    configVersion: version,
    settings,
    screenshots: {
      enabled: settings.screenshotsEnabled,
      intervalMinutes: settings.screenshotIntervalMinutes,
      random: settings.screenshotRandom,
      blur: settings.screenshotBlur,
      notifyOnCapture: settings.notifyOnCapture,
      captureWindowTitles: settings.captureWindowTitles,
      captureOnlyWhileTimerRuns: true,
    },
    activity: { enabled: settings.activityTrackingEnabled, intervalSeconds: 60, thresholds: th },
    apps: { enabled: settings.appTrackingEnabled, captureWindowTitles: settings.captureWindowTitles },
    websites: { enabled: settings.websiteTrackingEnabled, trackFullUrl: settings.trackFullUrl },
    idle: { thresholdMinutes: settings.idleThresholdMinutes, autoPauseMinutes: settings.autoPauseMinutes },
    activityThresholds: th,
    consent,
    monitoringActive: consent.accepted,
    showIndicator: true,
    stealthMode: false,
    heartbeatIntervalSeconds: 60,
    maxOfflineDays: 30,
    serverTime: new Date().toISOString(),
  };
}

/** Normalize a domain: lowercase, no scheme/port/path, no leading "www.". */
export function normalizeDomain(d) {
  let x = String(d).trim().toLowerCase();
  x = x.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split('#')[0];
  x = x.replace(/:\d+$/, '').replace(/^www\./, '');
  return x;
}

export function patternMatches(pattern, value) {
  if (!value) return false;
  const p = String(pattern).trim().toLowerCase();
  const v = String(value).toLowerCase();
  if (p.includes('*')) {
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(v);
  }
  return v === p || v.endsWith(`.${p}`);
}

export async function loadExclusions(orgId) {
  return (await db.many('SELECT domain_pattern FROM sensitive_exclusions WHERE organization_id = $1', [orgId])).map((r) => r.domain_pattern);
}

/** Strip query string and fragment from a URL; null if invalid. */
export function stripQuery(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function result(type, item, status, extra = {}) {
  return { type, clientUuid: item?.clientUuid ?? null, status, ...extra };
}

/** Track the [min, max] window touched by an ingest call to recompute summaries once. */
function rangeTracker() {
  let min = null;
  let max = null;
  const entries = new Set();
  return {
    add(s, e, entry) {
      const a = new Date(s);
      const b = new Date(e ?? s);
      if (!min || a < min) min = a;
      if (!max || b > max) max = b;
      if (entry?.ended_at) entries.add(entry.id);
    },
    async flush(memberId) {
      for (const id of entries) await finalizeEntry(id);
      if (min) await recomputeRange(memberId, min, max);
    },
  };
}

// ─── Activity (ACT-01…05) ───────────────────────────────────────────────────
export async function ingestActivity(ic, samples, { settings } = {}) {
  settings = settings ?? (await memberSettings(ic.orgId, ic.memberId));
  const results = [];
  const range = rangeTracker();
  for (const s of samples) {
    if (!settings.activityTrackingEnabled) {
      results.push(result('activity', s, 'error', { message: 'Activity tracking is disabled' }));
      continue;
    }
    const err = checkRange(s.intervalStart);
    if (err) {
      results.push(result('activity', s, 'error', { message: err }));
      continue;
    }
    if (s.activeSeconds > s.intervalSeconds || s.keyboardActiveSeconds > s.intervalSeconds || s.mouseActiveSeconds > s.intervalSeconds) {
      results.push(result('activity', s, 'error', { message: 'Active seconds cannot exceed the interval length' }));
      continue;
    }
    const entry = await findEntryAt(ic.memberId, s.intervalStart);
    const percent = Math.min(100, Math.round((s.activeSeconds / s.intervalSeconds) * 100));
    const row = await db.one(
      `INSERT INTO activity_samples (organization_id, member_id, time_entry_id, device_id, project_id, task_id, client_uuid,
         interval_start, interval_seconds, keyboard_active_seconds, mouse_active_seconds, active_seconds, activity_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id`,
      [ic.orgId, ic.memberId, entry?.id ?? null, ic.deviceId, entry?.project_id ?? null, entry?.task_id ?? null, s.clientUuid ?? null,
        s.intervalStart, s.intervalSeconds, s.keyboardActiveSeconds, s.mouseActiveSeconds, s.activeSeconds, percent],
    );
    if (!row) {
      results.push(result('activity', s, 'duplicate'));
      continue;
    }
    range.add(s.intervalStart, new Date(new Date(s.intervalStart).getTime() + s.intervalSeconds * 1000), entry);
    results.push(result('activity', s, 'ok', { id: row.id }));
  }
  await range.flush(ic.memberId);
  return results;
}

// ─── Applications (APP-01, APP-03, APP-24) ──────────────────────────────────
export async function ingestAppUsage(ic, items, { settings } = {}) {
  settings = settings ?? (await memberSettings(ic.orgId, ic.memberId));
  const results = [];
  const range = rangeTracker();
  const catalog = new Map(
    (await db.many(`SELECT lower(identifier) AS identifier, display_name FROM applications WHERE kind = 'app'`)).map((r) => [r.identifier, r.display_name]),
  );
  for (const a of items) {
    if (!settings.appTrackingEnabled) {
      results.push(result('appUsage', a, 'error', { message: 'Application tracking is disabled' }));
      continue;
    }
    const err = checkRange(a.startedAt, a.endedAt);
    if (err) {
      results.push(result('appUsage', a, 'error', { message: err }));
      continue;
    }
    if (a.clientUuid && ic.deviceId) {
      const dup = await db.one('SELECT id FROM app_usage WHERE device_id = $1 AND client_uuid = $2', [ic.deviceId, a.clientUuid]);
      if (dup) {
        results.push(result('appUsage', a, 'duplicate', { id: dup.id }));
        continue;
      }
    }
    const identifier = (a.appIdentifier ?? a.appName).slice(0, 200);
    const name = catalog.get(identifier.toLowerCase()) ?? catalog.get(a.appName.toLowerCase()) ?? a.appName;
    const entry = await findEntryAt(ic.memberId, a.startedAt);
    const duration = Math.max(0, Math.round((new Date(a.endedAt) - new Date(a.startedAt)) / 1000));
    const row = await db.one(
      `INSERT INTO app_usage (organization_id, member_id, time_entry_id, device_id, client_uuid, app_identifier, app_name, window_title,
         started_at, ended_at, duration_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (device_id, client_uuid) WHERE client_uuid IS NOT NULL DO NOTHING RETURNING id`,
      [ic.orgId, ic.memberId, entry?.id ?? null, ic.deviceId, a.clientUuid ?? null, identifier, name.slice(0, 200),
        settings.captureWindowTitles ? (a.windowTitle ?? null) : null, a.startedAt, a.endedAt, duration],
    );
    if (!row) {
      results.push(result('appUsage', a, 'duplicate'));
      continue;
    }
    range.add(a.startedAt, a.endedAt);
    results.push(result('appUsage', a, 'ok', { id: row.id }));
  }
  await range.flush(ic.memberId);
  return results;
}

// ─── Websites (APP-02, APP-04…08, APP-25, PRIV-05) ──────────────────────────
export async function ingestWebUsage(ic, items, { settings } = {}) {
  settings = settings ?? (await memberSettings(ic.orgId, ic.memberId));
  const exclusions = await loadExclusions(ic.orgId);
  const results = [];
  const range = rangeTracker();
  for (const w of items) {
    if (!settings.websiteTrackingEnabled) {
      results.push(result('webUsage', w, 'error', { message: 'Website tracking is disabled' }));
      continue;
    }
    const err = checkRange(w.startedAt, w.endedAt);
    if (err) {
      results.push(result('webUsage', w, 'error', { message: err }));
      continue;
    }
    if (w.clientUuid && ic.deviceId) {
      const dup = await db.one('SELECT id FROM web_usage WHERE device_id = $1 AND client_uuid = $2', [ic.deviceId, w.clientUuid]);
      if (dup) {
        results.push(result('webUsage', w, 'duplicate', { id: dup.id }));
        continue;
      }
    }
    let domain = normalizeDomain(w.domain);
    if (!domain) {
      results.push(result('webUsage', w, 'error', { message: 'Invalid domain' }));
      continue;
    }
    let url = w.url ? (settings.trackFullUrl ? w.url : stripQuery(w.url)) : null;
    let title = settings.captureWindowTitles ? (w.title ?? null) : null;
    const excluded = exclusions.some((p) => patternMatches(p, domain));
    if (excluded) {
      domain = '(excluded)';
      url = null;
      title = null;
    }
    const entry = await findEntryAt(ic.memberId, w.startedAt);
    const duration = Math.max(0, Math.round((new Date(w.endedAt) - new Date(w.startedAt)) / 1000));
    const row = await db.one(
      `INSERT INTO web_usage (organization_id, member_id, time_entry_id, device_id, client_uuid, browser, domain, url, title,
         started_at, ended_at, duration_seconds, is_excluded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (device_id, client_uuid) WHERE client_uuid IS NOT NULL DO NOTHING RETURNING id`,
      [ic.orgId, ic.memberId, entry?.id ?? null, ic.deviceId, w.clientUuid ?? null, w.browser ?? 'other', domain, url, title,
        w.startedAt, w.endedAt, duration, excluded],
    );
    if (!row) {
      results.push(result('webUsage', w, 'duplicate'));
      continue;
    }
    range.add(w.startedAt, w.endedAt);
    results.push(result('webUsage', w, 'ok', { id: row.id, excluded }));
  }
  await range.flush(ic.memberId);
  return results;
}

// ─── Idle (TIME-21, ACT-16, DESK-12) ────────────────────────────────────────
/**
 * Store idle periods. With `live` (the /agent/idle endpoint) an idle period at least
 * autoPauseMinutes long pauses the running timer at the idle start, and periods above
 * idleThresholdMinutes alert the member and their approvers once.
 * The agent may re-send the same clientUuid with a later endedAt while the idle continues.
 */
export async function ingestIdle(ic, items, { live = false } = {}) {
  const results = [];
  const range = rangeTracker();
  const settings = await memberSettings(ic.orgId, ic.memberId);
  for (const p of items) {
    const err = checkRange(p.startedAt, p.endedAt);
    if (err) {
      results.push(result('idlePeriods', p, 'error', { message: err }));
      continue;
    }
    const entry = await findEntryAt(ic.memberId, p.startedAt);
    let row;
    let duplicate = false;
    const existing = p.clientUuid && ic.deviceId
      ? await db.one('SELECT * FROM idle_periods WHERE device_id = $1 AND client_uuid = $2', [ic.deviceId, p.clientUuid])
      : null;
    if (existing) {
      if (new Date(p.endedAt) > new Date(existing.ended_at)) {
        row = await db.one('UPDATE idle_periods SET ended_at = $2 WHERE id = $1 RETURNING *', [existing.id, p.endedAt]);
      } else {
        row = existing;
        duplicate = true;
      }
    } else {
      row = await db.one(
        `INSERT INTO idle_periods (organization_id, member_id, time_entry_id, device_id, client_uuid, started_at, ended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ic.orgId, ic.memberId, entry?.id ?? null, ic.deviceId, p.clientUuid ?? null, p.startedAt, p.endedAt],
      );
    }
    range.add(row.started_at, row.ended_at, entry);
    const seconds = row.duration_seconds;
    let paused = false;
    if (live) {
      // TIME-21: auto-pause the running timer at the idle start.
      if (seconds >= settings.autoPauseMinutes * 60) {
        const running = await getRunningEntry(ic.memberId);
        if (running && !running.open_pause && new Date(running.started_at) <= new Date(row.ended_at)) {
          const at = new Date(Math.max(new Date(row.started_at).getTime(), new Date(running.started_at).getTime()));
          try {
            await pauseTimer(ic.ctx, { memberId: ic.memberId, reason: 'idle', at });
            paused = true;
          } catch (e) {
            if (!(e instanceof AppError)) throw e;
          }
        }
      }
      if (seconds >= settings.idleThresholdMinutes * 60 && !row.alert_sent) {
        await db.query('UPDATE idle_periods SET alert_sent = true WHERE id = $1', [row.id]);
        const payload = { memberId: ic.memberId, idlePeriodId: row.id, startedAt: row.started_at, endedAt: row.ended_at, durationSeconds: seconds, timerPaused: paused };
        emitToUser(ic.userId, 'idle.detected', payload);
        emitToLive(ic.orgId, 'idle.detected', payload);
        await publish('idle.detected', { orgId: ic.orgId, ...payload });
        const approvers = await usersWithPermission(ic.orgId, 'idle.approve', { memberId: ic.memberId });
        const minutes = Math.round(seconds / 60);
        await notify({
          orgId: ic.orgId,
          memberIds: [ic.memberId],
          userIds: approvers,
          type: 'idle.alert',
          title: 'Idle time detected',
          body: `${minutes} minute${minutes === 1 ? '' : 's'} of idle time was detected${paused ? ' and the timer was paused' : ''}.`,
          link: '/time/idle',
          data: payload,
          email: false,
        });
      }
    }
    results.push(result('idlePeriods', p, duplicate ? 'duplicate' : 'ok', { id: row.id, ...(live ? { timerPaused: paused } : {}) }));
  }
  await range.flush(ic.memberId);
  return results;
}

// ─── Screenshots (SS-01, SS-08, SS-18…22, SS-27, SS-P4) ─────────────────────
/** Throws unless screenshots may be captured now (timer running, enabled, consent given). */
export async function assertScreenshotAllowed(ic, { capturedAt } = {}) {
  const consent = await consentStatus(ic.orgId, ic.memberId);
  if (!consent.accepted) throw new AppError(403, 'CONSENT_REQUIRED', 'Tracking consent has not been given', { policyVersion: consent.policyVersion });
  let entry;
  if (capturedAt && new Date(capturedAt).getTime() < Date.now() - MAX_FUTURE_SKEW_MS) {
    entry = await findEntryAt(ic.memberId, capturedAt); // late (offline) upload
    if (!entry) throw unprocessable('NO_ACTIVE_TIMER', 'No time entry covers the capture time');
  } else {
    entry = await getRunningEntry(ic.memberId);
    if (!entry || entry.open_pause) throw unprocessable('NO_ACTIVE_TIMER', 'Screenshots are only captured while the timer is running');
  }
  const settings = await memberSettings(ic.orgId, ic.memberId, entry.project_id ?? null);
  if (!settings.screenshotsEnabled) throw unprocessable('SCREENSHOTS_DISABLED', 'Screenshots are disabled for you');
  return { entry, settings };
}

export async function ingestScreenshots(ic, items) {
  const results = [];
  const range = rangeTracker();
  const consent = await consentStatus(ic.orgId, ic.memberId);
  for (const s of items) {
    try {
      if (!consent.accepted) throw unprocessable('CONSENT_REQUIRED', 'Tracking consent has not been given');
      const dup = await db.one('SELECT id FROM screenshots WHERE device_id = $1 AND client_uuid = $2', [ic.deviceId, s.clientUuid]);
      if (dup) {
        results.push(result('screenshots', s, 'duplicate', { id: dup.id }));
        continue;
      }
      const err = checkRange(s.capturedAt);
      if (err) throw unprocessable('INVALID_TIME', err);
      const file = await assertUploaded(s.key, { orgId: ic.orgId, purpose: 'screenshot' });
      if (file.uploaded_by && file.uploaded_by !== ic.userId) throw unprocessable('FILE_NOT_UPLOADED', 'File was uploaded by another user');
      if (await db.one('SELECT id FROM screenshots WHERE object_key = $1', [s.key])) throw unprocessable('KEY_IN_USE', 'This file is already attached to a screenshot');
      const entry = await findEntryAt(ic.memberId, s.capturedAt);
      if (!entry) throw unprocessable('NO_ACTIVE_TIMER', 'Screenshots are only accepted while a time entry is running');
      const settings = await memberSettings(ic.orgId, ic.memberId, entry.project_id ?? null);
      if (!settings.screenshotsEnabled) throw unprocessable('SCREENSHOTS_DISABLED', 'Screenshots are disabled');
      if (new Date(s.capturedAt).getTime() < Date.now() - settings.screenshotRetentionDays * 86400_000)
        throw unprocessable('OUTSIDE_RETENTION', 'Screenshot is older than the retention window');
      const row = await db.one(
        `INSERT INTO screenshots (organization_id, member_id, time_entry_id, project_id, task_id, device_id, client_uuid, capture_group_id,
           monitor_index, captured_at, object_key, is_blurred, width, height, size_bytes, activity_percent, app_name, window_title)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (device_id, client_uuid) WHERE client_uuid IS NOT NULL DO NOTHING RETURNING *`,
        [ic.orgId, ic.memberId, entry.id, entry.project_id, entry.task_id, ic.deviceId, s.clientUuid, s.captureGroupId ?? null,
          s.monitorIndex ?? 0, s.capturedAt, s.key, !!settings.screenshotBlur, s.width, s.height, Number(file.size_bytes) || 0,
          s.activityPercent ?? null, s.appName ?? null, settings.captureWindowTitles ? (s.windowTitle ?? null) : null],
      );
      if (!row) {
        results.push(result('screenshots', s, 'duplicate'));
        continue;
      }
      await bumpScreenshotCounter(ic.orgId, 1);
      await enqueue('screenshots.process', { screenshotId: row.id });
      const payload = { memberId: ic.memberId, screenshotId: row.id, capturedAt: row.captured_at, projectId: row.project_id, taskId: row.task_id, isBlurred: row.is_blurred };
      await publish('screenshot.captured', { orgId: ic.orgId, ...payload });
      emitToLive(ic.orgId, 'screenshot.captured', payload);
      if (settings.notifyOnCapture) emitToUser(ic.userId, 'screenshot.captured', payload);
      range.add(s.capturedAt, s.capturedAt);
      results.push(result('screenshots', s, 'ok', { id: row.id, notify: !!settings.notifyOnCapture }));
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      results.push(result('screenshots', s, 'error', { message: e.message, code: e.code }));
    }
  }
  await range.flush(ic.memberId);
  return results;
}

export function summarize(results) {
  const out = { accepted: 0, duplicates: 0, conflicts: 0, rejected: 0 };
  for (const r of results) {
    if (r.status === 'ok') out.accepted++;
    else if (r.status === 'duplicate') out.duplicates++;
    else if (r.status === 'conflict') out.conflicts++;
    else out.rejected++;
  }
  return out;
}
