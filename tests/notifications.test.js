import { describe, it, expect, beforeAll } from 'vitest';
import { setupApp, registerOrg, addMember, db } from './helpers.js';
import { notify } from '../src/modules/notifications/service.js';
import { drainJobs } from '../src/lib/jobs.js';

let t;
let owner;
let emp;
beforeAll(async () => {
  t = await setupApp();
  owner = await registerOrg(t);
  emp = await addMember(t, owner, { role: 'employee' });
});

const emailsTo = (email, subject) => t.outbox.filter((m) => m.to === email && (!subject || m.subject === subject)).length;

describe('Notifications (NOTIF-01…24)', () => {
  it('lists, counts, marks read, read-all and deletes own notifications', async () => {
    await notify({ orgId: owner.orgId, userIds: [emp.user.id], type: 'task.assigned', title: 'Task A', body: 'b' });
    await notify({ orgId: owner.orgId, userIds: [emp.user.id], type: 'project.created', title: 'Project B' });
    const list = await emp.api.get('/api/v1/notifications?unread=true').expect(200);
    expect(list.body.data.length).toBe(2);
    expect(list.body.meta.unread).toBe(2);
    const typed = await emp.api.get('/api/v1/notifications?type=task.assigned').expect(200);
    expect(typed.body.data.map((n) => n.title)).toEqual(['Task A']);
    const cnt = await emp.api.get('/api/v1/notifications/unread-count').expect(200);
    expect(cnt.body.data.count).toBe(2);
    const id = typed.body.data[0].id;
    const read = await emp.api.patch(`/api/v1/notifications/${id}/read`).send({}).expect(200);
    expect(read.body.data.read).toBe(true);
    expect((await emp.api.get('/api/v1/notifications/unread-count')).body.data.count).toBe(1);
    // other users cannot touch it
    await owner.api.patch(`/api/v1/notifications/${id}/read`).send({}).expect(404);
    await owner.api.delete(`/api/v1/notifications/${id}`).expect(404);
    const all = await emp.api.post('/api/v1/notifications/read-all').expect(200);
    expect(all.body.data.updated).toBe(1);
    await emp.api.delete(`/api/v1/notifications/${id}`).expect(204);
    expect((await emp.api.get('/api/v1/notifications')).body.data.length).toBe(1);
  });

  it('returns the preference matrix and honors disabled email in notify()', async () => {
    const m = await emp.api.get('/api/v1/me/notification-preferences').expect(200);
    const row = m.body.data.find((p) => p.type === 'task.overdue');
    expect(row).toMatchObject({ inApp: true, email: true, desktop: true, source: 'default', mandatory: false });
    expect(m.body.data.find((p) => p.type === 'timer.started').email).toBe(false);

    await emp.api.put('/api/v1/me/notification-preferences').send({ preferences: [{ type: 'task.overdue', email: false }] }).expect(200);
    const m2 = await emp.api.get('/api/v1/me/notification-preferences').expect(200);
    expect(m2.body.data.find((p) => p.type === 'task.overdue')).toMatchObject({ email: false, inApp: true, source: 'user' });

    await notify({ orgId: owner.orgId, userIds: [emp.user.id, owner.user.id], type: 'task.overdue', title: 'Overdue X' });
    await drainJobs();
    expect(emailsTo(emp.email, 'Overdue X')).toBe(0);
    expect(emailsTo(owner.email, 'Overdue X')).toBe(1);
  });

  it('in-app disabled hides the notification from the list', async () => {
    await emp.api.put('/api/v1/me/notification-preferences').send({ preferences: [{ type: 'summary.weekly', inApp: false, email: false, desktop: false }] }).expect(200);
    const created = await notify({ orgId: owner.orgId, userIds: [emp.user.id], type: 'summary.weekly', title: 'Weekly' });
    expect(created.length).toBe(0);
    const list = await emp.api.get('/api/v1/notifications?type=summary.weekly').expect(200);
    expect(list.body.data.length).toBe(0);
  });

  it('mandatory events cannot disable in-app', async () => {
    const res = await emp.api.put('/api/v1/me/notification-preferences').send({ preferences: [{ type: 'subscription.notice', inApp: false }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MANDATORY_NOTIFICATION');
    const bad = await emp.api.put('/api/v1/me/notification-preferences').send({ preferences: [{ type: 'nope.event', inApp: false }] });
    expect(bad.status).toBe(400);
    const m = await emp.api.get('/api/v1/me/notification-preferences').expect(200);
    expect(m.body.data.find((p) => p.type === 'system')).toMatchObject({ mandatory: true, inApp: true });
  });

  it('organization defaults apply unless the user overrides; manage permission required', async () => {
    await emp.api.get('/api/v1/organization/notification-defaults').expect(403);
    await emp.api.put('/api/v1/organization/notification-defaults').send({ preferences: [{ type: 'activity.low', email: false }] }).expect(403);
    const put = await owner.api.put('/api/v1/organization/notification-defaults').send({ preferences: [{ type: 'activity.low', email: false }] }).expect(200);
    expect(put.body.data.find((p) => p.type === 'activity.low')).toMatchObject({ email: false, source: 'organization' });
    const mine = await emp.api.get('/api/v1/me/notification-preferences').expect(200);
    expect(mine.body.data.find((p) => p.type === 'activity.low')).toMatchObject({ email: false, source: 'organization' });
    await notify({ orgId: owner.orgId, userIds: [emp.user.id], type: 'activity.low', title: 'Low act' });
    await drainJobs();
    expect(emailsTo(emp.email, 'Low act')).toBe(0);
    const rows = await db.many(`SELECT * FROM notification_preferences WHERE user_id IS NULL AND organization_id = $1`, [owner.orgId]);
    expect(rows.length).toBe(1);
  });
});
