import { registerCron } from '../../lib/jobs.js';
import { logger } from '../../lib/logger.js';
import { runDueSchedules } from './service.js';

/** Scheduled / email reports (RPT-A14): every 5 minutes deliver due schedules. */
registerCron('reports.scheduled', 5 * 60_000, async () => {
  const results = await runDueSchedules();
  if (results.length) logger.info({ results }, 'scheduled reports processed');
  return results;
});
