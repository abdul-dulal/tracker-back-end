import { db } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';

/**
 * Currency data & conversion (BILL-16, BILL-17). Rates live in the global `exchange_rates` table
 * (base, quote, rate, date). Conversion uses the nearest rate on/before the document date, direct or inverse.
 */

export const CURRENCIES = [
  ['USD', 'US Dollar', '$'], ['EUR', 'Euro', '€'], ['GBP', 'British Pound', '£'], ['JPY', 'Japanese Yen', '¥'],
  ['AUD', 'Australian Dollar', 'A$'], ['CAD', 'Canadian Dollar', 'C$'], ['CHF', 'Swiss Franc', 'CHF'],
  ['CNY', 'Chinese Yuan', '¥'], ['HKD', 'Hong Kong Dollar', 'HK$'], ['NZD', 'New Zealand Dollar', 'NZ$'],
  ['SEK', 'Swedish Krona', 'kr'], ['NOK', 'Norwegian Krone', 'kr'], ['DKK', 'Danish Krone', 'kr'],
  ['PLN', 'Polish Złoty', 'zł'], ['CZK', 'Czech Koruna', 'Kč'], ['HUF', 'Hungarian Forint', 'Ft'],
  ['RON', 'Romanian Leu', 'lei'], ['BGN', 'Bulgarian Lev', 'лв'], ['TRY', 'Turkish Lira', '₺'],
  ['INR', 'Indian Rupee', '₹'], ['BDT', 'Bangladeshi Taka', '৳'], ['PKR', 'Pakistani Rupee', '₨'],
  ['SGD', 'Singapore Dollar', 'S$'], ['MYR', 'Malaysian Ringgit', 'RM'], ['THB', 'Thai Baht', '฿'],
  ['IDR', 'Indonesian Rupiah', 'Rp'], ['PHP', 'Philippine Peso', '₱'], ['KRW', 'South Korean Won', '₩'],
  ['ZAR', 'South African Rand', 'R'], ['BRL', 'Brazilian Real', 'R$'], ['MXN', 'Mexican Peso', '$'],
  ['ILS', 'Israeli New Shekel', '₪'], ['AED', 'UAE Dirham', 'د.إ'], ['SAR', 'Saudi Riyal', '﷼'],
  ['ISK', 'Icelandic Króna', 'kr'], ['NGN', 'Nigerian Naira', '₦'], ['EGP', 'Egyptian Pound', 'E£'],
].map(([code, name, symbol]) => ({ code, name, symbol }));

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Exchange rate from → to on/before date (direct or inverse, whichever is nearest). null if unknown.
 * @param {Map} [cache] optional memo map shared across a request
 */
export async function getRate(from, to, date = today(), cache) {
  if (!from || !to || from === to) return 1;
  const key = `${from}|${to}|${date}`;
  if (cache?.has(key)) return cache.get(key);
  const row = await db.one(
    `SELECT rate, date, inverse FROM (
       (SELECT rate, date, false AS inverse FROM exchange_rates WHERE base = $1 AND quote = $2 AND date <= $3::date ORDER BY date DESC LIMIT 1)
       UNION ALL
       (SELECT rate, date, true AS inverse FROM exchange_rates WHERE base = $2 AND quote = $1 AND date <= $3::date ORDER BY date DESC LIMIT 1)
     ) x ORDER BY date DESC, inverse ASC LIMIT 1`,
    [from, to, date],
  );
  let rate = null;
  if (row && Number(row.rate) > 0) rate = row.inverse ? 1 / Number(row.rate) : Number(row.rate);
  cache?.set(key, rate);
  return rate;
}

/** Convert an amount (not rounded). Returns null when no rate is available. */
export async function convert(amount, from, to, date = today(), cache) {
  const rate = await getRate(from, to, date, cache);
  if (rate === null) return null;
  return Number(amount) * rate;
}

/** Fetch latest rates from frankfurter for every currency in use (cron). Network failures are ignored. */
export async function fetchExchangeRates({ fetchImpl = globalThis.fetch } = {}) {
  const used = await db.many(
    `SELECT DISTINCT c FROM (
       SELECT default_currency AS c FROM organizations WHERE deleted_at IS NULL
       UNION SELECT currency FROM clients WHERE currency IS NOT NULL AND deleted_at IS NULL
       UNION SELECT currency FROM projects WHERE currency IS NOT NULL AND deleted_at IS NULL
       UNION SELECT currency FROM member_rates) x WHERE c IS NOT NULL`,
  );
  let stored = 0;
  for (const { c } of used) {
    const base = String(c).trim().toUpperCase();
    try {
      const res = await fetchImpl(`https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const body = await res.json();
      const date = body.date ?? today();
      for (const [quote, rate] of Object.entries(body.rates ?? {})) {
        if (!/^[A-Z]{3}$/.test(quote) || !(Number(rate) > 0)) continue;
        await db.query(
          `INSERT INTO exchange_rates (base, quote, rate, date) VALUES ($1,$2,$3,$4)
           ON CONFLICT (base, quote, date) DO UPDATE SET rate = EXCLUDED.rate`,
          [base, quote, rate, date],
        );
        stored++;
      }
    } catch (err) {
      logger.warn({ err: err?.message, base }, 'exchange rate fetch failed (ignored)');
    }
  }
  return stored;
}
