import { db } from '../../lib/db.js';
import { DEFAULT_ROLES } from '../../rbac/catalog.js';

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'org';

/** Seed the built-in roles for an organization. Returns { slug: roleId }. */
export async function seedRoles(orgId) {
  const perms = new Map((await db.many('SELECT id, key FROM permissions')).map((p) => [p.key, p.id]));
  const ids = {};
  for (const r of DEFAULT_ROLES) {
    const role = await db.one(
      `INSERT INTO roles (organization_id, name, slug, description, is_system, base_role, level)
       VALUES ($1,$2,$3,$4,true,$5,$6)
       ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [orgId, r.name, r.slug, r.description, r.baseRole, r.level],
    );
    ids[r.slug] = role.id;
    for (const [key, scope] of Object.entries(r.grants)) {
      const pid = perms.get(key);
      if (!pid) continue;
      await db.query(
        `INSERT INTO role_permissions (role_id, permission_id, scope) VALUES ($1,$2,$3)
         ON CONFLICT (role_id, permission_id) DO UPDATE SET scope = EXCLUDED.scope`,
        [role.id, pid, scope],
      );
    }
  }
  return ids;
}

/**
 * Create an organization with everything it needs (AUTH-11):
 * roles, settings, tracking defaults, default schedule, break types, trial subscription, owner membership.
 */
export async function provisionOrganization({ name, ownerUserId, timezone = 'UTC', currency = 'USD', industry, size, country }) {
  return db.tx(async () => {
    let slug = slugify(name);
    if (await db.one('SELECT 1 FROM organizations WHERE slug = $1', [slug])) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    const org = await db.one(
      `INSERT INTO organizations (name, slug, timezone, default_currency, industry, size, country, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, slug, timezone, currency, industry ?? null, size ?? null, country ?? null, ownerUserId],
    );
    await db.query('INSERT INTO organization_settings (organization_id) VALUES ($1)', [org.id]);
    await db.query(
      `INSERT INTO tracking_settings (organization_id, scope_type, screenshots_enabled, screenshot_interval_minutes,
         screenshot_random, screenshot_blur, screenshot_retention_days, allow_employee_screenshot_delete, capture_window_titles,
         notify_on_capture, activity_tracking_enabled, app_tracking_enabled, website_tracking_enabled, track_full_url,
         idle_threshold_minutes, auto_pause_minutes, weekly_limit_hours, limit_mode)
       VALUES ($1,'org',true,10,true,false,30,false,true,true,true,true,true,false,5,10,NULL,'warn')`,
      [org.id],
    );
    await db.query(
      `INSERT INTO work_schedules (organization_id, name, schedule_type, working_days, start_time, end_time, required_hours_per_day, is_default)
       VALUES ($1,'Standard (Mon–Fri 9–5)','fixed','{1,2,3,4,5}','09:00','17:00',8,true)`,
      [org.id],
    );
    await db.query(
      `INSERT INTO break_types (organization_id, name, is_paid, max_minutes, is_system, color) VALUES
       ($1,'Lunch Break',false,60,true,'#f59e0b'), ($1,'Tea Break',true,15,true,'#10b981')`,
      [org.id],
    );
    const roles = await seedRoles(org.id);
    const member = await db.one(
      `INSERT INTO organization_members (organization_id, user_id, role_id, status, employee_code, joined_on, work_schedule_id)
       VALUES ($1,$2,$3,'active','EMP-0001', current_date, (SELECT id FROM work_schedules WHERE organization_id = $1 AND is_default))
       RETURNING *`,
      [org.id, ownerUserId, roles.owner],
    );
    const plan = await db.one(`SELECT id FROM plans WHERE code = 'professional'`);
    await db.query(
      `INSERT INTO subscriptions (organization_id, plan_id, status, trial_ends_at, current_period_start, current_period_end, seats)
       VALUES ($1,$2,'trialing', now() + interval '14 days', now(), now() + interval '14 days', 1)`,
      [org.id, plan.id],
    );
    return { org, member, roles };
  });
}

/** Next sequential employee code for an org: EMP-0002, … */
export async function nextEmployeeCode(orgId) {
  const r = await db.one(
    `SELECT coalesce(max((regexp_match(employee_code, '^EMP-(\\d+)$'))[1]::int), 0) + 1 AS n
     FROM organization_members WHERE organization_id = $1`,
    [orgId],
  );
  return `EMP-${String(r.n).padStart(4, '0')}`;
}
