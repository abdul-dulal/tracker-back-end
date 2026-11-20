import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok } from '../../lib/http.js';

/** Public plan catalog (SUB-01…SUB-07). */
const r = createRouter('/plans', 'Subscription');

export function planDto(p) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    priceMonth: Number(p.price_month),
    priceYear: Number(p.price_year),
    currency: p.currency,
    perSeat: p.per_seat,
    limits: p.limits,
    features: p.features,
    isPublic: p.is_public,
    sortOrder: p.sort_order,
    contactSales: p.code === 'enterprise' && Number(p.price_month) === 0,
  };
}

r.get('/', { auth: 'public', summary: 'Public plans', ids: 'SUB-01…SUB-07' }, async (_req, res) => {
  const rows = await db.many('SELECT * FROM plans WHERE is_public ORDER BY sort_order');
  ok(res, rows.map(planDto));
});

export default r;
