import { z } from 'zod';
import { http, importGroups } from './_util.js';
import { badRequest } from '../../../lib/errors.js';

/** Asana (INT-13): personal access token; projects → projects, tasks → tasks. */
const API = 'https://app.asana.com/api/1.0';
const h = (integ) => ({ Authorization: `Bearer ${integ.token}` });

const asana = {
  key: 'asana',
  name: 'Asana',
  category: 'project_management',
  authType: 'api_token',
  description: 'Import Asana projects and tasks.',
  settingsSchema: z.object({
    accessToken: z.string().trim().min(10).max(500).optional(),
    workspaceId: z.string().max(50).optional(),
    projectIds: z.array(z.string().max(50)).max(100).optional(),
  }),
  async connect(settings, { existingToken, existingSettings = {} } = {}) {
    const token = settings.accessToken ?? existingToken;
    if (!token) throw badRequest('accessToken is required', undefined, 'INVALID_SETTINGS');
    const me = await asana.test({ token });
    return {
      token,
      settings: {
        workspaceId: settings.workspaceId ?? existingSettings.workspaceId ?? null,
        projectIds: settings.projectIds ?? existingSettings.projectIds ?? [],
        account: me.account,
      },
    };
  },
  async test(integ) {
    const me = await http(`${API}/users/me`, { headers: h(integ) });
    return { ok: true, account: me?.data?.name ?? null };
  },
  async sync(ctx, integ) {
    const s = integ.settings;
    const workspaces = s.workspaceId ? [{ gid: s.workspaceId }] : ((await http(`${API}/workspaces`, { headers: h(integ) }))?.data ?? []);
    const groups = [];
    for (const w of workspaces) {
      let projects = (await http(`${API}/projects?workspace=${w.gid}&archived=false&opt_fields=name,notes`, { headers: h(integ) }))?.data ?? [];
      if (s.projectIds?.length) projects = projects.filter((p) => s.projectIds.includes(p.gid));
      for (const p of projects) {
        const tasks =
          (await http(`${API}/projects/${p.gid}/tasks?opt_fields=name,notes,due_on,completed,permalink_url`, { headers: h(integ) }))?.data ?? [];
        groups.push({
          project: { externalId: p.gid, name: p.name, description: p.notes || 'Imported from Asana' },
          tasks: tasks.map((t) => ({ externalId: t.gid, title: t.name, description: t.notes || null, dueDate: t.due_on, done: !!t.completed, url: t.permalink_url })),
        });
      }
    }
    return importGroups(ctx, integ.row, groups);
  },
  async disconnect() {},
};

export default asana;
