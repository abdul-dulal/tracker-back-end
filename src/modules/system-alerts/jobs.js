import { registerCron } from '../../lib/jobs.js';
import { checkAll } from './service.js';

/** Hourly: seats ≥ 90%, storage ≥ 90%, trial ending ≤ 3 days, failing webhooks → upsert / auto-resolve alerts. */
registerCron('system-alerts.check', 3600_000, checkAll);
