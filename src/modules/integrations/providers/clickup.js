import { z } from 'zod';
import { http, importGroups } from './_util.js';
import { badRequest } from '../../../lib/errors.js';

/** ClickUp (INT-14): personal token; teams/spaces/lists → projects (one per list), tasks → tasks. */
const API = 'https://api.clickup.com/api/v2';
const h = (integ) => ({ Authorization: integ.token });

const clickup = {
  key: 'clickup',
  name: 'ClickUp',
  category: 'project_management',
  authType: 'api_token',
  description: 'Import ClickUp spaces, lists and tasks.',
  settingsSchema: z.object({
    apiToken: z.string().trim().min(10).max(500).optional(),
    listIds: z.array(z.string().max(50)).max(200).optional(),
  }),
  async connect(settings, { existingToken, existingSettings = {} } = {}) {
    const token = settings.apiToken ?? existingToken;
    if (!token) throw badRequest('apiToken is required', undefined, 'INVALID_SETTINGS');
    const me = await clickup.test({ token });
    return { token, settings: { listIds: settings.listIds ?? existingSettings.listIds ?? [], account: me.account } };
  },
  async test(integ) {
    const me = await http(`${API}/user`, { headers: h(integ) });
    return { ok: true, account: me?.user?.username ?? null };
  },
  async sync(ctx, integ) {
    const groups = [];
    const teams = (await http(`${API}/team`, { headers: h(integ) }))?.teams ?? [];
    for (const team of teams) {
      const spaces = (await http(`${API}/team/${team.id}/space?archived=false`, { headers: h(integ) }))?.spaces ?? [];
      for (const space of spaces) {
        let lists = (await http(`${API}/space/${space.id}/list?archived=false`, { headers: h(integ) }))?.lists ?? [];
        if (integ.settings.listIds?.length) lists = lists.filter((l) => integ.settings.listIds.includes(String(l.id)));
        for (const list of lists) {
          const tasks = (await http(`${API}/list/${list.id}/task?include_closed=true`, { headers: h(integ) }))?.tasks ?? [];
          groups.push({
            project: { externalId: list.id, externalType: 'list', name: `${space.name} / ${list.name}`, description: 'Imported from ClickUp' },
            tasks: tasks.map((t) => ({
              externalId: t.id,
              title: t.name,
              description: t.description || null,
              dueDate: t.due_date ? Number(t.due_date) : null,
              priority: t.priority?.priority,
              done: ['closed', 'done'].includes(t.status?.type),
              url: t.url,
            })),
          });
        }
      }
    }
    return importGroups(ctx, integ.row, groups);
  },
  async disconnect() {},
};

export default clickup;
