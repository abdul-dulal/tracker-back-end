import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, request } from './helpers.js';

let t;
beforeAll(async () => {
  t = await setupApp();
});

describe('public site metadata & integration form fields', () => {
  it('GET /public/meta works without auth and is backend-derived', async () => {
    const r = await request(t.app).get('/api/v1/public/meta').expect(200);
    const d = r.body.data;
    expect(d.currencies.length).toBeGreaterThan(5);
    expect(d.plans.map((p) => p.code)).toEqual(['free', 'starter', 'professional', 'enterprise']);
    expect(d.facts.integrations).toBe(13);
    expect(d.facts.screenshotIntervals).toEqual([3, 5, 10, 15]);
    expect(d.facts.platforms).toEqual(expect.arrayContaining(['windows', 'macos', 'linux']));
  });

  it('integration catalog includes connect-form fields and brand colors', async () => {
    const o = await registerOrg(t);
    const r = await o.api.get('/api/v1/integrations').expect(200);
    const jira = r.body.data.find((p) => p.provider === 'jira');
    expect(jira.fields.map((f) => f.key)).toEqual(['siteUrl', 'email', 'apiToken', 'projectKeys', 'pushWorklogs']);
    expect(jira.brandColor).toMatch(/^#/);
    expect(jira.categoryLabel).toBe('Project management');
  });
});
