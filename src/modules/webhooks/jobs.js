import { registerJob } from '../../lib/jobs.js';
import { subscribeAll } from '../../lib/events.js';
import { dispatchEvent, attemptDelivery } from './service.js';

/** INT-03: every domain event → deliveries for subscribed webhooks, delivered by the job worker. */
subscribeAll(async (evt) => {
  await dispatchEvent(evt);
});

registerJob('webhooks.deliver', async ({ deliveryId }) => {
  if (deliveryId) await attemptDelivery(deliveryId, { retry: true });
});
