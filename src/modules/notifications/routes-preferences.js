import { createRouter } from '../../lib/router.js';
import { ok } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { buildMatrix, savePrefs, prefsBody } from './preferences.js';

/** Per-user preferences (NOTIF-24) and organization defaults. */
const me = createRouter('/me', 'Notifications');

me.get('/notification-preferences', { auth: 'user', summary: 'My notification preference matrix (event × channel)', ids: 'NOTIF-21…24' }, async (req, res) => {
  ok(res, await buildMatrix({ userId: req.ctx.userId, orgId: req.ctx.orgId }));
});

me.put(
  '/notification-preferences',
  { auth: 'user', summary: 'Update my notification preferences', ids: 'NOTIF-24', body: prefsBody },
  async (req, res) => {
    const current = await buildMatrix({ userId: req.ctx.userId, orgId: req.ctx.orgId });
    await savePrefs({ userId: req.ctx.userId, orgId: req.ctx.orgId ?? null, items: req.body.preferences, current });
    ok(res, await buildMatrix({ userId: req.ctx.userId, orgId: req.ctx.orgId }));
  },
);

const org = createRouter('/organization', 'Notifications');

org.get(
  '/notification-defaults',
  { summary: 'Organization default notification preferences', ids: 'NOTIF-24', permission: 'notifications.manage' },
  async (req, res) => {
    ok(res, await buildMatrix({ userId: null, orgId: req.ctx.orgId }));
  },
);

org.put(
  '/notification-defaults',
  { summary: 'Update organization default notification preferences', ids: 'NOTIF-24', permission: 'notifications.manage', body: prefsBody },
  async (req, res) => {
    const current = await buildMatrix({ userId: null, orgId: req.ctx.orgId });
    await savePrefs({ userId: null, orgId: req.ctx.orgId, items: req.body.preferences, current });
    await audit(req.ctx, 'notification_defaults.update', { entityType: 'organization', entityId: req.ctx.orgId, after: req.body.preferences });
    ok(res, await buildMatrix({ userId: null, orgId: req.ctx.orgId }));
  },
);

export default [me, org];
