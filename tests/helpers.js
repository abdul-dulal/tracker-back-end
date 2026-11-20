/**
 * Test harness: each test file gets an in-memory PGlite database, migrations, seed and an app.
 *
 *   import { setupApp, registerOrg, addMember } from './helpers.js';
 *   const t = await setupApp();                       // in beforeAll
 *   const owner = await registerOrg(t);               // { api, token, user, orgId, memberId, roles }
 *   const emp = await addMember(t, owner, { role: 'employee' });
 *   await owner.api.get('/api/v1/members').expect(200);
 */
import request from 'supertest';
import { initDb, db } from '../src/lib/db.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { outbox } from '../src/lib/mailer.js';
import { emitted } from '../src/lib/realtime.js';

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function setupApp() {
  await initDb({ memory: true });
  await migrate();
  await seed();
  const app = await createApp();
  return { app, db, outbox, emitted };
}

/** Supertest wrapper that sends a bearer token on every request. */
export function client(app, token) {
  const wrap = (method) => (url) => {
    const req = request(app)[method](url);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete'), token };
}

/** Register a new user + organization; returns an authenticated client for the owner. */
export async function registerOrg(t, overrides = {}) {
  const email = overrides.email ?? `owner-${uniq()}@example.com`;
  const res = await request(t.app)
    .post('/api/v1/auth/register')
    .send({
      firstName: 'Olivia',
      lastName: 'Owner',
      email,
      password: 'Passw0rd!',
      organizationName: overrides.organizationName ?? `Org ${uniq()}`,
      timezone: overrides.timezone ?? 'UTC',
      ...overrides.body,
    });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = res.body.data.accessToken;
  const orgId = res.body.data.activeOrganizationId;
  const member = await db.one('SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, res.body.data.user.id]);
  const roles = Object.fromEntries((await db.many('SELECT slug, id FROM roles WHERE organization_id = $1', [orgId])).map((r) => [r.slug, r.id]));
  // Accept tracking consent so tracking endpoints work by default.
  await db.query(`INSERT INTO consents (organization_id, member_id, policy_version) VALUES ($1,$2,1) ON CONFLICT DO NOTHING`, [orgId, member.id]);
  return { api: client(t.app, token), token, user: res.body.data.user, email, password: 'Passw0rd!', orgId, memberId: member.id, roles };
}

/**
 * Invite + accept a new member with the given role slug. Returns an authenticated client.
 * @param {{role?:string, email?:string, firstName?:string, consent?:boolean}} opts
 */
export async function addMember(t, owner, opts = {}) {
  const email = opts.email ?? `${opts.role ?? 'employee'}-${uniq()}@example.com`;
  const roleId = owner.roles[opts.role ?? 'employee'];
  const inv = await owner.api.post('/api/v1/invitations').send({ email, roleId, ...(opts.teamId ? { teamId: opts.teamId } : {}) });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const mail = [...outbox].reverse().find((m) => m.to === email);
  const token = mail.text.match(/invite\/(inv_[A-Za-z0-9_-]+)/)[1];
  const acc = await request(t.app)
    .post(`/api/v1/invitations/token/${token}/accept`)
    .send({ firstName: opts.firstName ?? 'Member', lastName: 'Test', password: 'Passw0rd!' });
  if (acc.status !== 200) throw new Error(`accept failed: ${acc.status} ${JSON.stringify(acc.body)}`);
  const memberId = acc.body.data.memberId;
  if (opts.consent !== false)
    await db.query(`INSERT INTO consents (organization_id, member_id, policy_version) VALUES ($1,$2,1) ON CONFLICT DO NOTHING`, [owner.orgId, memberId]);
  return { api: client(t.app, acc.body.data.accessToken), token: acc.body.data.accessToken, user: acc.body.data.user, email, password: 'Passw0rd!', orgId: owner.orgId, memberId, roles: owner.roles };
}

export { request, db };
