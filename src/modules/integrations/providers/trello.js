import { z } from 'zod';
import { http, importGroups } from './_util.js';
import { badRequest } from '../../../lib/errors.js';

/** Trello (INT-12): API key + token; boards → projects, cards → tasks. */
const API = 'https://api.trello.com/1';
const creds = (integ) => {
  const { key, token } = JSON.parse(integ.token);
  return `key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
};

const trello = {
  key: 'trello',
  name: 'Trello',
  category: 'project_management',
  authType: 'api_token',
  description: 'Import Trello boards and cards as projects and tasks.',
  settingsSchema: z.object({
    apiKey: z.string().trim().min(8).max(200).optional(),
    token: z.string().trim().min(8).max(500).optional(),
    boardIds: z.array(z.string().max(50)).max(100).optional(),
  }),
  async connect(settings, { existingToken, existingSettings = {} } = {}) {
    const prev = existingToken ? JSON.parse(existingToken) : {};
    const key = settings.apiKey ?? prev.key;
    const token = settings.token ?? prev.token;
    if (!key || !token) throw badRequest('apiKey and token are required', undefined, 'INVALID_SETTINGS');
    const packed = JSON.stringify({ key, token });
    const me = await trello.test({ token: packed });
    return { token: packed, settings: { boardIds: settings.boardIds ?? existingSettings.boardIds ?? [], account: me.account } };
  },
  async test(integ) {
    const me = await http(`${API}/members/me?${creds(integ)}`);
    return { ok: true, account: me?.username ?? me?.fullName ?? null };
  },
  async sync(ctx, integ) {
    let boards = (await http(`${API}/members/me/boards?filter=open&${creds(integ)}`)) ?? [];
    if (integ.settings.boardIds?.length) boards = boards.filter((b) => integ.settings.boardIds.includes(b.id));
    const groups = [];
    for (const b of boards) {
      const cards = (await http(`${API}/boards/${b.id}/cards?filter=all&${creds(integ)}`)) ?? [];
      groups.push({
        project: { externalId: b.id, externalType: 'board', name: b.name, description: b.desc || 'Imported from Trello' },
        tasks: cards.map((c) => ({
          externalId: c.id,
          externalType: 'card',
          title: c.name,
          description: c.desc || null,
          dueDate: c.due,
          done: !!(c.closed || c.dueComplete),
          url: c.url,
        })),
      });
    }
    return importGroups(ctx, integ.row, groups);
  },
  async disconnect() {},
};

export default trello;
