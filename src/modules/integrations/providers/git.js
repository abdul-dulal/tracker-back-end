import { z } from 'zod';
import { http, importGroups, httpsUrl } from './_util.js';
import { badRequest } from '../../../lib/errors.js';

const GH = 'https://api.github.com';
const ghHeaders = (integ) => ({ Authorization: `Bearer ${integ.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });

/** GitHub (INT-15): PAT; repositories → projects, issues (not PRs) → tasks. */
export const github = {
  key: 'github',
  name: 'GitHub',
  category: 'development',
  authType: 'api_token',
  description: 'Import GitHub repositories and issues as projects and tasks.',
  settingsSchema: z.object({
    accessToken: z.string().trim().min(10).max(500).optional(),
    repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Expected owner/repo')).max(100).optional(),
  }),
  async connect(settings, { existingToken, existingSettings = {} } = {}) {
    const token = settings.accessToken ?? existingToken;
    if (!token) throw badRequest('accessToken is required', undefined, 'INVALID_SETTINGS');
    const me = await github.test({ token });
    return { token, settings: { repos: settings.repos ?? existingSettings.repos ?? [], account: me.account } };
  },
  async test(integ) {
    const me = await http(`${GH}/user`, { headers: ghHeaders(integ) });
    return { ok: true, account: me?.login ?? null };
  },
  async sync(ctx, integ) {
    const repos = integ.settings.repos?.length
      ? await Promise.all(integ.settings.repos.map((r) => http(`${GH}/repos/${r}`, { headers: ghHeaders(integ) })))
      : ((await http(`${GH}/user/repos?per_page=50&sort=updated`, { headers: ghHeaders(integ) })) ?? []);
    const groups = [];
    for (const repo of repos) {
      const issues = (await http(`${GH}/repos/${repo.full_name}/issues?state=all&per_page=100`, { headers: ghHeaders(integ) })) ?? [];
      groups.push({
        project: { externalId: repo.id, externalType: 'repo', name: repo.full_name, description: repo.description || 'Imported from GitHub' },
        tasks: issues
          .filter((i) => !i.pull_request)
          .map((i) => ({ externalId: i.id, externalType: 'issue', title: `#${i.number} ${i.title}`, description: i.body || null, done: i.state === 'closed', url: i.html_url })),
      });
    }
    return importGroups(ctx, integ.row, groups);
  },
  async disconnect() {},
};

const glBase = (integ) => (integ.settings?.baseUrl ?? 'https://gitlab.com').replace(/\/+$/, '');
const glHeaders = (integ) => ({ 'PRIVATE-TOKEN': integ.token });

/** GitLab (INT-16): PAT (gitlab.com or self-hosted); projects → projects, issues → tasks. */
export const gitlab = {
  key: 'gitlab',
  name: 'GitLab',
  category: 'development',
  authType: 'api_token',
  description: 'Import GitLab projects and issues as projects and tasks.',
  settingsSchema: z.object({
    accessToken: z.string().trim().min(10).max(500).optional(),
    baseUrl: z.string().trim().max(300).refine(httpsUrl, 'Expected https URL').optional(),
    projectIds: z.array(z.union([z.string(), z.number()]).transform(String)).max(100).optional(),
  }),
  async connect(settings, { existingToken, existingSettings = {} } = {}) {
    const token = settings.accessToken ?? existingToken;
    if (!token) throw badRequest('accessToken is required', undefined, 'INVALID_SETTINGS');
    const s = {
      baseUrl: settings.baseUrl ?? existingSettings.baseUrl ?? 'https://gitlab.com',
      projectIds: settings.projectIds ?? existingSettings.projectIds ?? [],
    };
    const me = await gitlab.test({ token, settings: s });
    return { token, settings: { ...s, account: me.account } };
  },
  async test(integ) {
    const me = await http(`${glBase(integ)}/api/v4/user`, { headers: glHeaders(integ) });
    return { ok: true, account: me?.username ?? null };
  },
  async sync(ctx, integ) {
    const api = `${glBase(integ)}/api/v4`;
    const ids = integ.settings.projectIds ?? [];
    const projects = ids.length
      ? await Promise.all(ids.map((id) => http(`${api}/projects/${encodeURIComponent(id)}`, { headers: glHeaders(integ) })))
      : ((await http(`${api}/projects?membership=true&per_page=50&order_by=last_activity_at`, { headers: glHeaders(integ) })) ?? []);
    const groups = [];
    for (const p of projects) {
      const issues = (await http(`${api}/projects/${p.id}/issues?per_page=100`, { headers: glHeaders(integ) })) ?? [];
      groups.push({
        project: { externalId: p.id, externalType: 'repo', name: p.path_with_namespace ?? p.name, description: p.description || 'Imported from GitLab' },
        tasks: issues.map((i) => ({
          externalId: i.id,
          externalType: 'issue',
          title: `#${i.iid} ${i.title}`,
          description: i.description || null,
          dueDate: i.due_date,
          done: i.state === 'closed',
          url: i.web_url,
        })),
      });
    }
    return importGroups(ctx, integ.row, groups);
  },
  async disconnect() {},
};
