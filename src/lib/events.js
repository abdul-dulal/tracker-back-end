import { EventEmitter } from 'node:events';
import { logger } from './logger.js';

/**
 * In-process domain event bus. Modules publish domain events; other modules subscribe without
 * import cycles (e.g. webhooks dispatch, attendance auto check-in, summaries refresh).
 *
 *   publish('timer.started', { orgId, memberId, entry })
 *   subscribe('timer.started', async (evt) => {...})
 *
 * Handlers run after the current tick and errors are logged (never break the request).
 * Event names (keep in sync with webhooks module):
 *   timer.started, timer.paused, timer.resumed, timer.stopped,
 *   time_entry.created, time_entry.updated, time_entry.deleted, time_entry.approved, time_entry.rejected,
 *   member.created, member.updated, member.deactivated,
 *   project.created, project.updated, project.archived, project.deleted,
 *   task.created, task.updated, task.completed, task.deleted,
 *   timesheet.submitted, timesheet.level_approved, timesheet.approved, timesheet.rejected, timesheet.locked, timesheet.unlocked,
 *   attendance.checked_in, attendance.checked_out,
 *   screenshot.captured, break.started, break.ended, idle.detected,
 *   invoice.created, invoice.sent, invoice.paid, client.created
 */
const bus = new EventEmitter();
bus.setMaxListeners(100);
const handlers = new Map();

export function subscribe(event, handler) {
  if (!handlers.has(event)) handlers.set(event, []);
  handlers.get(event).push(handler);
}

export function subscribeAll(handler) {
  subscribe('*', handler);
}

/** Publish and await all handlers (errors logged, not thrown). */
export async function publish(event, payload) {
  const list = [...(handlers.get(event) ?? []), ...(handlers.get('*') ?? [])];
  for (const h of list) {
    try {
      await h({ event, ...payload });
    } catch (err) {
      logger.error({ err, event }, 'event handler failed');
    }
  }
}

export { bus };
