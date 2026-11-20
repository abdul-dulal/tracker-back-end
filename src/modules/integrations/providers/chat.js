import { z } from 'zod';
import { http, formatEvent } from './_util.js';
import { WEBHOOK_EVENTS } from '../../webhooks/service.js';
import { badRequest } from '../../../lib/errors.js';
import { isProd } from '../../../config/env.js';

/** Shared factory for incoming-webhook chat providers (Slack INT-09, Microsoft Teams INT-10). */
export function chatProvider({ key, name, description, hostCheck, buildBody }) {
  const urlOk = (v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && (!isProd || hostCheck(u.hostname));
    } catch {
      return false;
    }
  };
  const settingsSchema = z.object({
    webhookUrl: z.string().trim().max(1000).refine(urlOk, `Expected a ${name} incoming webhook URL (https)`).optional(),
    events: z.array(z.string().refine((e) => WEBHOOK_EVENTS.includes(e), 'Unknown event')).max(WEBHOOK_EVENTS.length).optional(),
    channel: z.string().trim().max(100).optional(),
  });
  const post = (url, text) => http(url, { method: 'POST', body: buildBody(text), json: true });
  return {
    key,
    name,
    category: 'communication',
    authType: 'webhook_url',
    description,
    settingsSchema,
    async connect(settings, { existingToken, existingSettings = {} } = {}) {
      const token = settings.webhookUrl ?? existingToken;
      if (!token) throw badRequest('webhookUrl is required', undefined, 'INVALID_SETTINGS');
      return {
        token,
        settings: { events: settings.events ?? existingSettings.events ?? [], channel: settings.channel ?? existingSettings.channel ?? null },
      };
    },
    async test(integ) {
      const events = (integ.settings.events ?? []).join(', ') || 'no events selected yet';
      await post(integ.token, `Tracker is connected to ${name}. Notifications: ${events}.`);
      return { ok: true };
    },
    async sync() {
      return { message: `${name} is notification-only; nothing to import.` };
    },
    async disconnect() {},
    wantsEvent: (integ, event) => (integ.settings.events ?? []).includes(event),
    async handleEvent(integ, evt, { orgName } = {}) {
      await post(integ.token, formatEvent(evt, orgName));
    },
  };
}

export const slack = chatProvider({
  key: 'slack',
  name: 'Slack',
  description: 'Post notifications to a Slack channel via an incoming webhook.',
  hostCheck: (h) => h === 'hooks.slack.com',
  buildBody: (text) => ({ text }),
});

export const msTeams = chatProvider({
  key: 'ms_teams',
  name: 'Microsoft Teams',
  description: 'Post notifications to a Teams channel via an incoming webhook / workflow URL.',
  hostCheck: (h) => /(\.webhook\.office\.com|\.logic\.azure\.com|\.powerautomate\.com|outlook\.office\.com)$/.test(h),
  buildBody: (text) => ({ '@type': 'MessageCard', '@context': 'https://schema.org/extensions', summary: text.slice(0, 80), text }),
});
