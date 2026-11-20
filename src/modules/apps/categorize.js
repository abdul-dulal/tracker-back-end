import { db } from '../../lib/db.js';

/**
 * Productivity categorization (APP-13…APP-19). Precedence: member rule > team rule > org rule >
 * global catalog default (applications) > 'neutral'.
 * Match types: exact (case-insensitive name or identifier), domain (domain or sub-domain), wildcard (* glob).
 */
export const BROWSER_PATTERN = /(chrome|firefox|msedge|edge|safari|brave|opera|vivaldi|arc)/i;

export async function loadRules(orgId) {
  return db.many(
    `SELECT scope_type, scope_id, target_type, lower(pattern) AS pattern, match_type, category
     FROM productivity_rules WHERE organization_id = $1`,
    [orgId],
  );
}

export async function loadCatalog() {
  return db.many('SELECT lower(identifier) AS identifier, lower(display_name) AS name, kind, default_category FROM applications');
}

function matches(rule, value) {
  if (!value) return false;
  const v = value.toLowerCase();
  if (rule.match_type === 'exact') return v === rule.pattern;
  if (rule.match_type === 'domain') return v === rule.pattern || v.endsWith(`.${rule.pattern}`);
  const re = new RegExp(`^${rule.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(v);
}

/**
 * Build a categorizer for one member.
 * @returns {(targetType:'app'|'website', values:string[]) => 'productive'|'unproductive'|'neutral'}
 */
export async function buildCategorizer(orgId, memberId, { rules, catalog } = {}) {
  rules = rules ?? (await loadRules(orgId));
  catalog = catalog ?? (await loadCatalog());
  const teamIds = memberId ? (await db.many('SELECT team_id FROM team_members WHERE member_id = $1', [memberId])).map((r) => r.team_id) : [];
  const ordered = [
    ...rules.filter((r) => r.scope_type === 'member' && r.scope_id === memberId),
    ...rules.filter((r) => r.scope_type === 'team' && teamIds.includes(r.scope_id)),
    ...rules.filter((r) => r.scope_type === 'org'),
  ];
  return (targetType, values) => {
    const vals = values.filter(Boolean);
    for (const r of ordered) if (r.target_type === targetType && vals.some((v) => matches(r, v))) return r.category;
    const kind = targetType === 'website' ? 'website' : 'app';
    for (const c of catalog) {
      if (c.kind !== kind) continue;
      if (vals.some((v) => {
        const x = v.toLowerCase();
        return x === c.identifier || x === c.name || (kind === 'website' && x.endsWith(`.${c.identifier}`));
      }))
        return c.default_category;
    }
    return 'neutral';
  };
}
