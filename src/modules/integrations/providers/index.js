import { slack, msTeams } from './chat.js';
import jira from './jira.js';
import trello from './trello.js';
import asana from './asana.js';
import clickup from './clickup.js';
import { github, gitlab } from './git.js';
import { googleCalendar, outlookCalendar, quickbooks, xero, payrollCsv } from './exports.js';

/**
 * Provider registry (INT-08…19). Common interface:
 *   { key, name, category, authType: 'webhook_url'|'api_token'|'oauth'|'none', description, settingsSchema,
 *     connect(settings, {existingToken, existingSettings}) → {token, settings},
 *     test(integ), sync(ctx, integ), disconnect(integ),
 *     wantsEvent?(integ, event), handleEvent?(integ, evt, {orgName}) }
 * where integ = { row, token (decrypted), settings }.
 */
export const PROVIDERS = [slack, msTeams, jira, trello, asana, clickup, github, gitlab, googleCalendar, outlookCalendar, quickbooks, xero, payrollCsv];
export const providerMap = new Map(PROVIDERS.map((p) => [p.key, p]));
export const getProvider = (key) => providerMap.get(key) ?? null;
