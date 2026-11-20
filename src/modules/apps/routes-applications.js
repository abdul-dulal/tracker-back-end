import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';
import { buildCategorizer, loadRules, loadCatalog } from './categorize.js';
import { patternMatches } from '../agent/service.js';

/** Apps & domains seen in the organization in the last 30 days, with their current category (APP-03, APP-16). */
const r = createRouter('/applications', 'Apps & websites');

function ruleMatches(rule, values) {
  return values.filter(Boolean).some((v) => {
    const x = v.toLowerCase();
    if (rule.match_type === 'exact') return x === rule.pattern;
    if (rule.match_type === 'domain') return x === rule.pattern || x.endsWith(`.${rule.pattern}`);
    return rule.pattern.includes('*') ? patternMatches(rule.pattern, x) : x === rule.pattern;
  });
}

r.get(
  '/discovered',
  {
    summary: 'Applications and domains seen in the last 30 days (to categorize)',
    ids: 'APP-03, APP-16, APP-19',
    permission: 'apps.categorize',
    query: z.object({ targetType: z.enum(['app', 'website']).optional(), uncategorized: z.enum(['true', 'false']).optional() }),
  },
  async (req, res) => {
    const orgId = req.ctx.orgId;
    const q = req.v.query;
    const rules = await loadRules(orgId);
    const catalog = await loadCatalog();
    const categorize = await buildCategorizer(orgId, null, { rules, catalog });
    const orgRules = rules.filter((x) => x.scope_type === 'org');
    const items = [];
    if (q.targetType !== 'website') {
      const apps = await db.many(
        `SELECT app_identifier, max(app_name) AS app_name, sum(duration_seconds)::int AS s, count(DISTINCT member_id)::int AS members, max(ended_at) AS last_seen
         FROM app_usage WHERE organization_id = $1 AND started_at > now() - interval '30 days' GROUP BY app_identifier ORDER BY 3 DESC LIMIT 500`,
        [orgId],
      );
      for (const a of apps) {
        const vals = [a.app_name, a.app_identifier];
        items.push({
          targetType: 'app',
          identifier: a.app_identifier,
          name: a.app_name,
          totalSeconds: a.s,
          memberCount: a.members,
          lastSeenAt: a.last_seen,
          category: categorize('app', vals),
          hasRule: rules.some((x) => x.target_type === 'app' && ruleMatches(x, vals)),
          hasOrgRule: orgRules.some((x) => x.target_type === 'app' && ruleMatches(x, vals)),
        });
      }
    }
    if (q.targetType !== 'app') {
      const webs = await db.many(
        `SELECT domain, sum(duration_seconds)::int AS s, count(DISTINCT member_id)::int AS members, max(ended_at) AS last_seen
         FROM web_usage WHERE organization_id = $1 AND started_at > now() - interval '30 days' AND NOT is_excluded GROUP BY domain ORDER BY 2 DESC LIMIT 500`,
        [orgId],
      );
      for (const w of webs) {
        items.push({
          targetType: 'website',
          identifier: w.domain,
          name: w.domain,
          totalSeconds: w.s,
          memberCount: w.members,
          lastSeenAt: w.last_seen,
          category: categorize('website', [w.domain]),
          hasRule: rules.some((x) => x.target_type === 'website' && ruleMatches(x, [w.domain])),
          hasOrgRule: orgRules.some((x) => x.target_type === 'website' && ruleMatches(x, [w.domain])),
        });
      }
    }
    const out = q.uncategorized ? items.filter((i) => i.hasRule === (q.uncategorized === 'false')) : items;
    ok(res, out);
  },
);

export default r;
