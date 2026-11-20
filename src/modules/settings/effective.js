import { db } from '../../lib/db.js';
import { maxScreenshotRetentionDays } from '../subscription/features.js';

export const TRACKING_FIELDS = {
  screenshotsEnabled: 'screenshots_enabled',
  screenshotIntervalMinutes: 'screenshot_interval_minutes',
  screenshotRandom: 'screenshot_random',
  screenshotBlur: 'screenshot_blur',
  screenshotRetentionDays: 'screenshot_retention_days',
  allowEmployeeScreenshotDelete: 'allow_employee_screenshot_delete',
  captureWindowTitles: 'capture_window_titles',
  notifyOnCapture: 'notify_on_capture',
  activityTrackingEnabled: 'activity_tracking_enabled',
  appTrackingEnabled: 'app_tracking_enabled',
  websiteTrackingEnabled: 'website_tracking_enabled',
  trackFullUrl: 'track_full_url',
  idleThresholdMinutes: 'idle_threshold_minutes',
  autoPauseMinutes: 'auto_pause_minutes',
  weeklyLimitHours: 'weekly_limit_hours',
  limitMode: 'limit_mode',
};

const HARD_DEFAULTS = {
  screenshotsEnabled: true,
  screenshotIntervalMinutes: 10,
  screenshotRandom: true,
  screenshotBlur: false,
  screenshotRetentionDays: 30,
  allowEmployeeScreenshotDelete: false,
  captureWindowTitles: true,
  notifyOnCapture: true,
  activityTrackingEnabled: true,
  appTrackingEnabled: true,
  websiteTrackingEnabled: true,
  trackFullUrl: false,
  idleThresholdMinutes: 5,
  autoPauseMinutes: 10,
  weeklyLimitHours: null,
  limitMode: 'warn',
};

/**
 * Effective tracking settings (SET-T11/T12, SS-05…07): member > project > team(s) > org > defaults.
 * Returns { settings, inheritedFrom: { field: 'member'|'project'|'team'|'org'|'default' }, version }.
 * Privacy invariants (SS-P2, SS-P4): showIndicator is always true; stealth is impossible.
 */
export async function getEffectiveSettings(orgId, { memberId, projectId } = {}) {
  const teamIds = memberId
    ? (await db.many('SELECT team_id FROM team_members WHERE member_id = $1', [memberId])).map((r) => r.team_id)
    : [];
  const rows = await db.many(
    `SELECT * FROM tracking_settings WHERE organization_id = $1 AND (
       scope_type = 'org'
       OR (scope_type = 'member' AND scope_id = $2)
       OR (scope_type = 'project' AND scope_id = $3)
       OR (scope_type = 'team' AND scope_id = ANY($4::uuid[])))`,
    [orgId, memberId ?? null, projectId ?? null, teamIds],
  );
  const byScope = { member: [], project: [], team: [], org: [] };
  for (const r of rows) byScope[r.scope_type].push(r);
  // Order: most specific first. Multiple teams: most recently updated wins.
  byScope.team.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const layers = [
    ...byScope.member.map((r) => ['member', r]),
    ...byScope.project.map((r) => ['project', r]),
    ...byScope.team.map((r) => ['team', r]),
    ...byScope.org.map((r) => ['org', r]),
  ];
  const settings = {};
  const inheritedFrom = {};
  for (const [field, col] of Object.entries(TRACKING_FIELDS)) {
    const hit = layers.find(([, r]) => r[col] !== null && r[col] !== undefined);
    settings[field] = hit ? hit[1][col] : HARD_DEFAULTS[field];
    inheritedFrom[field] = hit ? hit[0] : 'default';
  }
  if (settings.weeklyLimitHours !== null) settings.weeklyLimitHours = Number(settings.weeklyLimitHours);
  // Member-level weekly limit on the member record also applies (EMP-15).
  if (memberId) {
    const m = await db.one('SELECT weekly_limit_hours FROM organization_members WHERE id = $1', [memberId]);
    if (m?.weekly_limit_hours !== null && m?.weekly_limit_hours !== undefined && inheritedFrom.weeklyLimitHours !== 'member') {
      settings.weeklyLimitHours = Number(m.weekly_limit_hours);
      inheritedFrom.weeklyLimitHours = 'member';
    }
  }
  const planMax = await maxScreenshotRetentionDays(orgId);
  if (planMax && settings.screenshotRetentionDays > planMax) settings.screenshotRetentionDays = planMax;
  settings.showIndicator = true; // SS-P2: cannot be disabled
  settings.stealthMode = false; // SS-P4: never
  const version = rows.reduce((acc, r) => acc + r.version, 0);
  return { settings, inheritedFrom, version };
}

/** Consent status for a member (PRIV-01). */
export async function consentStatus(orgId, memberId) {
  const s = await db.one('SELECT consent_policy_version, consent_policy_text FROM organization_settings WHERE organization_id = $1', [orgId]);
  const c = await db.one('SELECT accepted_at, policy_version FROM consents WHERE member_id = $1 AND policy_version = $2', [
    memberId,
    s?.consent_policy_version ?? 1,
  ]);
  return {
    required: true,
    policyVersion: s?.consent_policy_version ?? 1,
    policyText: s?.consent_policy_text,
    accepted: !!c,
    acceptedAt: c?.accepted_at ?? null,
  };
}

/** Throw CONSENT_REQUIRED if the member has not accepted the current tracking policy. */
export async function assertConsent(orgId, memberId) {
  const st = await consentStatus(orgId, memberId);
  if (!st.accepted) {
    const { AppError } = await import('../../lib/errors.js');
    throw new AppError(403, 'CONSENT_REQUIRED', 'You must accept the tracking policy before tracking time', { policyVersion: st.policyVersion });
  }
}
