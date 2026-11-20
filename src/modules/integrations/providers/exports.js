import { z } from 'zod';
import { AppError } from '../../../lib/errors.js';
import { hmac, safeEqual } from '../../../lib/crypto.js';
import { env } from '../../../config/env.js';

/**
 * Export-style providers: calendars (INT-19, iCalendar feed), accounting (INT-18, CSV) and payroll (INT-17, CSV).
 * OAuth push modes need provider client credentials (env); without them → 501 PROVIDER_NOT_CONFIGURED.
 */
function oauthGuard(name, envKeys) {
  const configured = envKeys.every((k) => process.env[k]);
  if (!configured)
    throw new AppError(501, 'PROVIDER_NOT_CONFIGURED', `${name} OAuth is not configured on this server (set ${envKeys.join(', ')}). Use the export mode instead.`);
  throw new AppError(501, 'PROVIDER_NOT_CONFIGURED', `${name} OAuth sync is not available yet. Use the export mode instead.`);
}

/** Per-member signed calendar feed token (no expiry; rotate by changing JWT_SECRET). */
export const calendarToken = (memberId) => `${memberId}.${hmac(`calfeed:${memberId}`)}`;
export function verifyCalendarToken(token) {
  const [memberId, sig] = String(token ?? '').split('.');
  if (!memberId || !sig || !/^[0-9a-f-]{36}$/i.test(memberId) || !safeEqual(sig, hmac(`calfeed:${memberId}`))) return null;
  return memberId;
}
export const calendarFeedUrl = (memberId) => `${env.APP_URL}/api/v1/integrations/calendar/feed.ics?token=${encodeURIComponent(calendarToken(memberId))}`;

function calendar(key, name, envKeys) {
  return {
    key,
    name,
    category: 'calendar',
    authType: 'oauth',
    description: `Subscribe ${name} to your Tracker tasks due dates and organization holidays (iCalendar feed).`,
    settingsSchema: z.object({
      mode: z.enum(['ics_feed', 'oauth']).optional(),
      calendarId: z.string().max(200).optional(),
    }),
    async connect(settings, { existingSettings = {} } = {}) {
      const mode = settings.mode ?? existingSettings.mode ?? 'ics_feed';
      if (mode === 'oauth') oauthGuard(name, envKeys);
      return { token: null, settings: { mode, calendarId: settings.calendarId ?? existingSettings.calendarId ?? null } };
    },
    async test() {
      return { ok: true };
    },
    async sync(ctx) {
      return { feedUrl: ctx.memberId ? calendarFeedUrl(ctx.memberId) : null, message: 'Add the feed URL to your calendar as a subscription.' };
    },
    async disconnect() {},
  };
}

function accounting(key, name, envKeys) {
  return {
    key,
    name,
    category: 'accounting',
    authType: 'oauth',
    description: `Export invoices as a ${name}-compatible CSV import file.`,
    settingsSchema: z.object({ mode: z.enum(['csv', 'oauth']).optional(), incomeAccount: z.string().max(100).optional(), taxType: z.string().max(60).optional() }),
    async connect(settings, { existingSettings = {} } = {}) {
      const mode = settings.mode ?? existingSettings.mode ?? 'csv';
      if (mode === 'oauth') oauthGuard(name, envKeys);
      return {
        token: null,
        settings: { mode, incomeAccount: settings.incomeAccount ?? existingSettings.incomeAccount ?? null, taxType: settings.taxType ?? existingSettings.taxType ?? null },
      };
    },
    async test() {
      return { ok: true };
    },
    async sync() {
      return { exportUrl: `/api/v1/integrations/accounting/invoices.csv?format=${key}`, message: 'Download the CSV and import it into your accounting software.' };
    },
    async disconnect() {},
  };
}

export const googleCalendar = calendar('google_calendar', 'Google Calendar', ['GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET']);
export const outlookCalendar = calendar('outlook_calendar', 'Outlook Calendar', ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET']);
export const quickbooks = accounting('quickbooks', 'QuickBooks', ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET']);
export const xero = accounting('xero', 'Xero', ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET']);

export const payrollCsv = {
  key: 'payroll_csv',
  name: 'Payroll CSV',
  category: 'payroll',
  authType: 'none',
  description: 'Export payroll runs as a generic CSV for any payroll provider.',
  settingsSchema: z.object({ delimiter: z.enum([',', ';', '\t']).optional(), hoursDecimals: z.number().int().min(0).max(4).optional() }),
  async connect(settings, { existingSettings = {} } = {}) {
    return { token: null, settings: { delimiter: settings.delimiter ?? existingSettings.delimiter ?? ',', hoursDecimals: settings.hoursDecimals ?? existingSettings.hoursDecimals ?? 2 } };
  },
  async test() {
    return { ok: true };
  },
  async sync() {
    return { message: 'Download a payroll run via GET /integrations/payroll/{runId}.csv' };
  },
  async disconnect() {},
};
