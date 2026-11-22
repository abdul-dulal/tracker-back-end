/**
 * Demo data for local development & front-end integration testing.
 *   npm run seed:demo            (uses DATABASE_URL or the embedded PGlite dir)
 * Creates "Softcrafty Demo" with 10 members (all roles), teams, clients, projects, tasks,
 * 14 days of time entries + activity + app usage, attendance and breaks.
 * Every demo user's password is: Passw0rd!
 * Idempotent: skipped if owner@demo.tracker already exists.
 */
import { initDb, db, closeDb } from '../lib/db.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';
import { hashPassword } from '../lib/password.js';
import { provisionOrganization } from '../modules/organizations/provision.js';
import { recomputeDailySummary } from '../modules/time/summary-service.js';

const PEOPLE = [
  ['Dulal', 'Ahmed', 'owner', 'CEO', 'Management', null],
  ['Nusrat', 'Jahan', 'admin', 'Operations Lead', 'Management', null],
  ['Rafiq', 'Islam', 'manager', 'Engineering Manager', 'Engineering', 'Web Platform'],
  ['Tania', 'Rahman', 'team_leader', 'Frontend Lead', 'Engineering', 'Web Platform'],
  ['Arif', 'Hossain', 'employee', 'Frontend Developer', 'Engineering', 'Web Platform'],
  ['Sadia', 'Akter', 'employee', 'Backend Developer', 'Engineering', 'Web Platform'],
  ['Imran', 'Khan', 'employee', 'QA Engineer', 'Engineering', 'Web Platform'],
  ['Farhana', 'Begum', 'employee', 'UI/UX Designer', 'Design', 'Product Design'],
  ['Mehedi', 'Hasan', 'team_leader', 'Design Lead', 'Design', 'Product Design'],
  ['Shila', 'Das', 'employee', 'Content Writer', 'Marketing', 'Growth'],
];
const PASSWORD = 'Passw0rd!';
const TZ = 'Asia/Dhaka';

// Deterministic pseudo-random
let s = 42;
const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;

async function main() {
  await initDb();
  await migrate();
  await seed();
  if (await db.one(`SELECT 1 FROM users WHERE email = 'owner@demo.tracker'`)) {
    console.log('Demo data already present (owner@demo.tracker). Nothing to do.');
    return;
  }
  const hash = await hashPassword(PASSWORD);
  const owner = await db.one(
    `INSERT INTO users (email, password_hash, first_name, last_name, timezone, time_format, date_format, email_verified_at)
     VALUES ('owner@demo.tracker', $1, 'Dulal', 'Ahmed', $2, '12h', 'DD/MM/YYYY', now()) RETURNING id`,
    [hash, TZ],
  );
  const { org, member: ownerMember, roles } = await provisionOrganization({ name: 'Softcrafty Demo', ownerUserId: owner.id, timezone: TZ, currency: 'USD', industry: 'Software', size: '11-50', country: 'BD' });
  const orgId = org.id;
  await db.query(`UPDATE organizations SET date_format = 'DD/MM/YYYY', time_format = '12h', week_start = 6 WHERE id = $1`, [orgId]);
  await db.query(`UPDATE organization_settings SET working_days = '{0,1,2,3,4}', default_billable_rate = 35 WHERE organization_id = $1`, [orgId]);
  await db.query(`UPDATE work_schedules SET working_days = '{0,1,2,3,4}', name = 'Standard (Sun–Thu 9–5)' WHERE organization_id = $1`, [orgId]);

  const depts = {};
  for (const name of ['Management', 'Engineering', 'Design', 'Marketing'])
    depts[name] = (await db.one('INSERT INTO departments (organization_id, name) VALUES ($1,$2) RETURNING id', [orgId, name])).id;
  const teams = {};
  for (const [name, dept, color] of [['Web Platform', 'Engineering', '#2a78d6'], ['Product Design', 'Design', '#1baf7a'], ['Growth', 'Marketing', '#eb6834']])
    teams[name] = (await db.one('INSERT INTO teams (organization_id, name, department_id, color) VALUES ($1,$2,$3,$4) RETURNING id', [orgId, name, depts[dept], color])).id;

  // Members
  const members = [];
  for (const [i, [first, last, role, designation, dept, team]] of PEOPLE.entries()) {
    let memberId;
    let userId;
    if (i === 0) {
      memberId = ownerMember.id;
      userId = owner.id;
      await db.query('UPDATE organization_members SET designation = $2, department_id = $3 WHERE id = $1', [memberId, designation, depts[dept]]);
    } else {
      const email = `${role === 'employee' || role === 'team_leader' ? first.toLowerCase() : role}@demo.tracker`;
      const u = await db.one(
        `INSERT INTO users (email, password_hash, first_name, last_name, timezone, time_format, email_verified_at) VALUES ($1,$2,$3,$4,$5,'12h', now()) RETURNING id`,
        [email, hash, first, last, TZ],
      );
      userId = u.id;
      const m = await db.one(
        `INSERT INTO organization_members (organization_id, user_id, role_id, status, employee_code, designation, department_id, employment_type, joined_on, work_schedule_id, work_mode)
         VALUES ($1,$2,$3,'active',$4,$5,$6,$7, current_date - ($8 || ' days')::interval, (SELECT id FROM work_schedules WHERE organization_id = $1 AND is_default), $9) RETURNING id`,
        [orgId, userId, roles[role], `EMP-${String(i + 1).padStart(4, '0')}`, designation, depts[dept], i === 9 ? 'part_time' : 'full_time', String(400 - i * 30), ['remote', 'office', 'hybrid'][i % 3]],
      );
      memberId = m.id;
    }
    if (team) await db.query('INSERT INTO team_members (team_id, member_id, is_leader) VALUES ($1,$2,$3)', [teams[team], memberId, role === 'team_leader']);
    await db.query(`INSERT INTO consents (organization_id, member_id, policy_version) VALUES ($1,$2,1) ON CONFLICT DO NOTHING`, [orgId, memberId]);
    await db.query(`INSERT INTO member_rates (organization_id, member_id, rate_type, amount, currency, effective_from) VALUES ($1,$2,'pay',$3,'USD', current_date - interval '400 days')`, [orgId, memberId, 12 + i * 2]);
    members.push({ id: memberId, userId, role, first, team });
  }
  const M = (first) => members.find((m) => m.first === first).id;
  await db.query('INSERT INTO team_managers (team_id, member_id) VALUES ($1,$2), ($3,$2)', [teams['Web Platform'], M('Rafiq'), teams['Product Design']]);
  await db.query('INSERT INTO member_managers (organization_id, member_id, manager_member_id) VALUES ($1,$2,$3)', [orgId, M('Shila'), M('Nusrat')]);

  // Clients & projects
  const clients = {};
  for (const [name, email, rate] of [['Acme Corporation', 'billing@acme.example', 45], ['Nimbus Health', 'ap@nimbus.example', 55], ['Delta Retail', 'finance@delta.example', 40]])
    clients[name] = (await db.one('INSERT INTO clients (organization_id, name, email, currency, hourly_rate) VALUES ($1,$2,$3,$4,$5) RETURNING id', [orgId, name, email, 'USD', rate])).id;
  const projectDefs = [
    ['Acme Customer Portal', 'Acme Corporation', 'high', '#2a78d6', 'hours', 800, ['Arif', 'Sadia', 'Imran', 'Tania', 'Farhana'], 'Web Platform'],
    ['Acme Mobile App', 'Acme Corporation', 'urgent', '#eb6834', 'amount', 30000, ['Arif', 'Sadia', 'Mehedi'], null],
    ['Nimbus Patient Dashboard', 'Nimbus Health', 'medium', '#1baf7a', 'hours', 600, ['Sadia', 'Imran', 'Farhana'], null],
    ['Internal Design System', null, 'low', '#6250d6', 'none', null, ['Farhana', 'Mehedi', 'Tania'], 'Product Design'],
    ['Marketing Website', null, 'medium', '#e87ba4', 'none', null, ['Shila', 'Farhana'], 'Growth'],
  ];
  const projects = [];
  for (const [name, client, priority, color, budgetType, budget, people, team] of projectDefs) {
    const p = await db.one(
      `INSERT INTO projects (organization_id, name, client_id, priority, color, budget_type, budget_value, currency, start_date, deadline, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD', current_date - interval '60 days', current_date + ($8 || ' days')::interval, $9) RETURNING id`,
      [orgId, name, client ? clients[client] : null, priority, color, budgetType, budget, String(10 + Math.floor(rnd() * 50)), ownerMember.id],
    );
    await db.query(`INSERT INTO project_members (project_id, member_id, role) VALUES ($1,$2,'manager')`, [p.id, M('Rafiq')]);
    for (const who of people) await db.query(`INSERT INTO project_members (project_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [p.id, M(who)]);
    if (team) await db.query('INSERT INTO project_teams (project_id, team_id) VALUES ($1,$2)', [p.id, teams[team]]);
    const cols = {};
    for (const [i, [cname, cat]] of [['To Do', 'todo'], ['In Progress', 'in_progress'], ['In Review', 'in_review'], ['Completed', 'done']].entries())
      cols[cat] = (await db.one('INSERT INTO board_columns (organization_id, project_id, name, category, position) VALUES ($1,$2,$3,$4,$5) RETURNING id', [orgId, p.id, cname, cat, (i + 1) * 1000])).id;
    projects.push({ id: p.id, name, people, cols });
  }

  // Tasks
  const titles = ['Login & signup flow', 'Dashboard layout', 'API pagination', 'Fix Safari redirect bug', 'Payment checkout', 'Notifications center', 'Accessibility audit', 'Performance tuning', 'Write release notes', 'Search filters', 'Export to CSV', 'Onboarding emails'];
  const tasksByProject = {};
  for (const p of projects) {
    tasksByProject[p.id] = [];
    for (let i = 0; i < 9; i++) {
      const cat = ['todo', 'todo', 'in_progress', 'in_progress', 'in_review', 'done', 'done', 'done', 'todo'][i];
      const due = Math.floor(rnd() * 24) - 6;
      const t = await db.one(
        `INSERT INTO tasks (organization_id, project_id, column_id, title, priority, due_date, estimated_hours, progress, position, completed_at, created_by)
         VALUES ($1,$2,$3,$4,$5, current_date + ($6 || ' days')::interval, $7, $8, $9, CASE WHEN $10 THEN now() - interval '2 days' END, $11) RETURNING id`,
        [orgId, p.id, p.cols[cat], titles[(i + projects.indexOf(p) * 3) % titles.length], ['low', 'medium', 'high', 'urgent'][Math.floor(rnd() * 4)], String(due), 4 + Math.floor(rnd() * 12), cat === 'done' ? 100 : cat === 'todo' ? 0 : 40, (i + 1) * 1000, cat === 'done', ownerMember.id],
      );
      await db.query('INSERT INTO task_assignees (task_id, member_id) VALUES ($1,$2)', [t.id, M(p.people[i % p.people.length])]);
      tasksByProject[p.id].push(t.id);
    }
  }

  // 14 days of time, activity, app usage, attendance (working days Sun–Thu)
  const apps = [['code.exe', 'VS Code'], ['figma.exe', 'Figma'], ['chrome.exe', 'Google Chrome'], ['slack.exe', 'Slack'], ['jira', 'Jira']];
  const trackers = members.filter((m) => m.role !== 'owner' && m.role !== 'admin');
  for (let dayAgo = 13; dayAgo >= 0; dayAgo--) {
    const dayRow = await db.one(`SELECT (now() AT TIME ZONE $1)::date - $2::int AS d, extract(dow FROM (now() AT TIME ZONE $1)::date - $2::int)::int AS dow`, [TZ, dayAgo]);
    if (dayRow.dow === 5 || dayRow.dow === 6) continue; // Fri/Sat weekend
    for (const m of trackers) {
      if (rnd() < 0.07) continue; // occasional absence
      const myProjects = projects.filter((p) => p.people.includes(m.first) || m.role === 'manager');
      if (!myProjects.length) continue;
      const lateMin = rnd() < 0.15 ? 10 + Math.floor(rnd() * 30) : Math.floor(rnd() * 8);
      let cursor = await db.one(`SELECT ($1::date::timestamp + interval '9 hours' + ($2 || ' minutes')::interval) AT TIME ZONE $3 AS t`, [dayRow.d, String(lateMin), TZ]);
      let t = new Date(cursor.t);
      const checkIn = new Date(t);
      const blocks = 3 + Math.floor(rnd() * 2);
      for (let b = 0; b < blocks; b++) {
        if (dayAgo === 0 && b >= 2) break;
        const p = myProjects[Math.floor(rnd() * myProjects.length)];
        const taskId = tasksByProject[p.id][Math.floor(rnd() * 9)];
        const mins = 70 + Math.floor(rnd() * 80);
        const end = new Date(t.getTime() + mins * 60000);
        if (end > new Date()) break;
        const e = await db.one(
          `INSERT INTO time_entries (organization_id, member_id, project_id, task_id, client_id, started_at, ended_at, duration_seconds, status, source, is_billable, entry_type)
           VALUES ($1,$2,$3,$4,(SELECT client_id FROM projects WHERE id = $3),$5,$6,$7,'completed',$8,true,$9) RETURNING id`,
          [orgId, m.id, p.id, taskId, t, end, mins * 60, rnd() < 0.8 ? 'desktop' : 'web_timer', rnd() < 0.1 ? 'meeting' : 'work'],
        );
        for (let k = 0; k < mins; k += 10) {
          const iv = Math.min(10, mins - k) * 60;
          const active = Math.round(iv * (0.45 + rnd() * 0.5));
          await db.query(
            `INSERT INTO activity_samples (organization_id, member_id, time_entry_id, project_id, task_id, interval_start, interval_seconds, keyboard_active_seconds, mouse_active_seconds, active_seconds, activity_percent)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
            [orgId, m.id, e.id, p.id, taskId, new Date(t.getTime() + k * 60000), iv, Math.round(active * 0.6), Math.round(active * 0.8), active, Math.round((active / iv) * 100)],
          );
        }
        const [ident, appName] = m.first === 'Farhana' || m.first === 'Mehedi' ? apps[1] : m.first === 'Shila' ? apps[2] : apps[Math.floor(rnd() * apps.length)];
        await db.query(
          `INSERT INTO app_usage (organization_id, member_id, time_entry_id, app_identifier, app_name, started_at, ended_at, duration_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orgId, m.id, e.id, ident, appName, t, end, mins * 60],
        );
        if (rnd() < 0.5)
          await db.query(
            `INSERT INTO web_usage (organization_id, member_id, time_entry_id, browser, domain, started_at, ended_at, duration_seconds) VALUES ($1,$2,$3,'chrome',$4,$5,$6,$7)`,
            [orgId, m.id, e.id, ['github.com', 'stackoverflow.com', 'figma.com', 'youtube.com', 'docs.google.com'][Math.floor(rnd() * 5)], t, new Date(t.getTime() + 15 * 60000), 900],
          );
        t = new Date(end.getTime() + (b === 1 ? 45 : 10) * 60000);
        if (b === 1) {
          const lunch = (await db.one(`SELECT id FROM break_types WHERE organization_id = $1 AND name = 'Lunch Break'`, [orgId])).id;
          await db.query(
            `INSERT INTO breaks (organization_id, member_id, break_type_id, started_at, ended_at, duration_seconds, is_paid) VALUES ($1,$2,$3,$4,$5,2700,false)`,
            [orgId, m.id, lunch, end, new Date(end.getTime() + 45 * 60000)],
          );
        }
      }
      await db.query(
        `INSERT INTO attendance_records (organization_id, member_id, date, status, check_in_at, check_out_at, check_in_source, late_minutes, worked_seconds, work_mode)
         VALUES ($1,$2,$3,$4,$5,$6,'timer',$7,$8,'office') ON CONFLICT (member_id, date) DO NOTHING`,
        [orgId, m.id, dayRow.d, lateMin > 10 ? 'late' : 'present', checkIn, dayAgo === 0 ? null : t, lateMin > 10 ? lateMin : 0, Math.round((t - checkIn) / 1000)],
      );
      await recomputeDailySummary(m.id, dayRow.d);
    }
  }

  // A pending manual entry for the approvals queue
  await db.query(
    `INSERT INTO time_entries (organization_id, member_id, project_id, started_at, ended_at, duration_seconds, status, source, note)
     VALUES ($1,$2,$3, date_trunc('day', now()) - interval '2 days' + interval '20 hours', date_trunc('day', now()) - interval '2 days' + interval '22 hours', 7200, 'pending', 'manual', 'Client call (forgot timer)')`,
    [orgId, M('Arif'), projects[0].id],
  );

  console.log('\nDemo organization created: "Softcrafty Demo"');
  console.log(`Password for every account: ${PASSWORD}`);
  console.log('  owner@demo.tracker   (Owner, also Super Admin)');
  console.log('  admin@demo.tracker   (Admin)');
  console.log('  manager@demo.tracker (Manager)');
  console.log('  tania@demo.tracker   (Team Leader)');
  console.log('  arif@demo.tracker    (Employee)');
  await db.query('UPDATE users SET is_super_admin = true WHERE id = $1', [owner.id]);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
