import { z } from 'zod';
import { createRouter, zCurrency } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';
import { dateStr } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { CURRENCIES } from './service.js';

const currencies = createRouter('/currencies', 'Currencies');

currencies.get('/', { summary: 'List supported currencies (and the org default)', ids: 'BILL-16' }, async (req, res) => {
  const org = await db.one('SELECT default_currency FROM organizations WHERE id = $1', [req.ctx.orgId]);
  ok(res, { defaultCurrency: org?.default_currency ?? 'USD', currencies: CURRENCIES });
});

const rates = createRouter('/exchange-rates', 'Currencies');

rates.get(
  '/',
  {
    summary: 'Exchange rates for a base currency (nearest on/before date)',
    ids: 'BILL-17',
    query: z.object({ base: zCurrency.optional(), date: dateStr.optional() }),
  },
  async (req, res) => {
    const org = await db.one('SELECT default_currency FROM organizations WHERE id = $1', [req.ctx.orgId]);
    const base = req.v.query.base ?? org?.default_currency ?? 'USD';
    const date = req.v.query.date ?? new Date().toISOString().slice(0, 10);
    const rows = await db.many(
      `SELECT DISTINCT ON (quote) quote, rate, to_char(date, 'YYYY-MM-DD') AS date FROM exchange_rates
       WHERE base = $1 AND date <= $2::date ORDER BY quote, date DESC`,
      [base, date],
    );
    ok(res, { base, date, rates: rows.map((r) => ({ quote: r.quote, rate: Number(r.rate), date: r.date })) });
  },
);

rates.put(
  '/',
  {
    summary: 'Set a manual exchange rate',
    ids: 'BILL-17',
    permission: 'billing.manage',
    body: z
      .object({ base: zCurrency, quote: zCurrency, rate: z.coerce.number().positive().max(1e9), date: dateStr })
      .refine((b) => b.base !== b.quote, { message: 'base and quote must differ', path: ['quote'] }),
  },
  async (req, res) => {
    const b = req.body;
    const row = await db.one(
      `INSERT INTO exchange_rates (base, quote, rate, date) VALUES ($1,$2,$3,$4)
       ON CONFLICT (base, quote, date) DO UPDATE SET rate = EXCLUDED.rate
       RETURNING base, quote, rate, to_char(date, 'YYYY-MM-DD') AS date`,
      [b.base, b.quote, b.rate, b.date],
    );
    await audit(req.ctx, 'exchange_rate.set', { entityType: 'exchange_rate', after: b });
    ok(res, { base: row.base, quote: row.quote, rate: Number(row.rate), date: row.date });
  },
);

export default [currencies, rates];
