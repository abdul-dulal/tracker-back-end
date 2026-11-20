import { registerCron } from '../../lib/jobs.js';
import { fetchExchangeRates } from './service.js';

// Daily exchange-rate refresh (BILL-17). Network failures are swallowed inside fetchExchangeRates.
registerCron('billing.exchange_rates', 24 * 60 * 60_000, async () => {
  await fetchExchangeRates();
});
