import { z } from 'zod';
import { http, importGroups, externalIdFor, httpsUrl } from './_util.js';
import { badRequest } from '../../../lib/errors.js';

/** Jira Cloud (INT-11): site URL + email + API token; imports projects/issues, optionally pushes worklogs. */
const settingsSchema = z.object({
  siteUrl: z.string().trim().max(300).refine(httpsUrl, 'Expected https://<site>.atlassian.net').optional(),
  email: z.email().optional(),
  apiToken: z.string().trim().min(10).max(500).optional(),
  projectKeys: z.array(z.string().trim().max(50)).max(100).optional(),
  pushWorklogs: z.boolean().optional(),
});

const base = (s) => s.siteUrl.replace(/\/+$/, '');
const auth = (integ) => ({ Authorization: `Basic ${Buffer.from(`${integ.settings.email}:${integ.token}`).toString('base64')}` });

/** Flatten Atlassian Document Format to plain text. */
function adfText(node) {
  if (!node) return null;
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  const inner = (node.content ?? []).map(adfText).join('');
  return node.type === 'paragraph' ? `${inner}\n` : inner;
}

const jira = {
  key: 'jira',
  name: 'Jira',
  category: 'project_management',
  authType: 'api_token',
  description: 'Import Jira projects and issues as projects and tasks; optionally push worklogs.',
  settingsSchema,
  async connect(settings, { existingToken, existingSettings = {} } = {}) {
    const merged = { ...existingSettings, ...settings };
    const token = settings.apiToken ?? existingToken;
    if (!merged.siteUrl || !merged.email || !token) throw badRequest('siteUrl, email and apiToken are required', undefined, 'INVALID_SETTINGS');
    const me = await jira.test({ token, settings: merged });
    return {
      token,
      settings: { siteUrl: base(merged), email: merged.email, projectKeys: merged.projectKeys ?? [], pushWorklogs: !!merged.pushWorklogs, account: me.account },
    };
  },
  async test(integ) {
    const me = await http(`${base(integ.settings)}/rest/api/3/myself`, { headers: auth(integ) });
    return { ok: true, account: me?.displayName ?? me?.emailAddress ?? null };
  },
  async sync(ctx, integ) {
    const s = integ.settings;
    const res = await http(`${base(s)}/rest/api/3/project/search?maxResults=50`, { headers: auth(integ) });
    let projects = res?.values ?? [];
    if (s.projectKeys?.length) projects = projects.filter((p) => s.projectKeys.includes(p.key));
    const groups = [];
    for (const p of projects) {
      const search = await http(`${base(s)}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: auth(integ),
        body: { jql: `project = "${p.key}" ORDER BY updated DESC`, maxResults: 100, fields: ['summary', 'description', 'duedate', 'status', 'priority'] },
      });
      groups.push({
        project: { externalId: p.id, name: p.name, description: p.description || `Imported from Jira (${p.key})` },
        tasks: (search?.issues ?? []).map((i) => ({
          externalId: i.id,
          title: `${i.key} ${i.fields?.summary ?? ''}`.trim(),
          description: adfText(i.fields?.description)?.trim() || null,
          dueDate: i.fields?.duedate,
          priority: i.fields?.priority?.name,
          done: i.fields?.status?.statusCategory?.key === 'done',
          url: `${base(s)}/browse/${i.key}`,
        })),
      });
    }
    return importGroups(ctx, integ.row, groups);
  },
  async disconnect() {},
  wantsEvent: (integ, event) => !!integ.settings.pushWorklogs && ['timer.stopped', 'time_entry.created'].includes(event),
  /** Push a worklog for time tracked on a task linked to a Jira issue. */
  async handleEvent(integ, evt) {
    const entry = evt.entry;
    const taskId = entry?.task?.id ?? entry?.taskId;
    const seconds = entry?.durationSeconds ?? 0;
    if (!taskId || seconds < 60) return;
    const issueId = await externalIdFor(integ.row.id, 'task', taskId);
    if (!issueId) return;
    const started = new Date(entry.startedAt ?? Date.now()).toISOString().replace('Z', '+0000');
    const comment = entry.note
      ? { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: entry.note }] }] }
      : undefined;
    await http(`${base(integ.settings)}/rest/api/3/issue/${encodeURIComponent(issueId)}/worklog`, {
      method: 'POST',
      headers: auth(integ),
      body: { timeSpentSeconds: Math.max(60, seconds), started, comment },
    });
  },
};

export default jira;
