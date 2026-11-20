import { z } from 'zod';

/** Standard success responses: { data, meta? } */
export const ok = (res, data, meta) => res.status(200).json(meta ? { data, meta } : { data });
export const created = (res, data) => res.status(201).json({ data });
export const noContent = (res) => res.status(204).end();

/** Common query schemas. */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().max(50).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().max(200).optional(),
});

export const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid calendar date');
export const dateRangeQuery = z.object({ from: dateStr.optional(), to: dateStr.optional() });
export const uuidParam = z.object({ id: z.uuid() });
export const id = () => z.uuid();

/**
 * Build ORDER BY / LIMIT / OFFSET safely from a whitelist.
 * @param {{page:number,limit:number,sort?:string,order:'asc'|'desc'}} q
 * @param {Record<string,string>} sortable map of api field → sql expression
 * @param {string} defaultSort api field
 */
export function pageClause(q, sortable, defaultSort) {
  const col = sortable[q.sort] ?? sortable[defaultSort];
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const offset = (q.page - 1) * q.limit;
  return { orderBy: `ORDER BY ${col} ${dir} NULLS LAST`, limit: q.limit, offset };
}

export const pageMeta = (q, total) => ({ page: q.page, limit: q.limit, total });

/**
 * Tiny SQL builder for dynamic WHERE clauses with positional params.
 *   const w = where(); w.add('organization_id = ?', orgId); w.add('status = ?', status)
 *   `SELECT ... ${w.sql}` with w.params
 */
export function where(initialParams = []) {
  const parts = [];
  const params = [...initialParams];
  const api = {
    params,
    /** Add a condition; each '?' is replaced with the next $n. Skips when any value is undefined. */
    add(cond, ...values) {
      if (values.some((v) => v === undefined)) return api;
      let i = 0;
      const sql = cond.replace(/\?/g, () => {
        params.push(values[i++]);
        return `$${params.length}`;
      });
      parts.push(`(${sql})`);
      return api;
    },
    /** Add a raw condition (no params). */
    raw(cond) {
      if (cond) parts.push(`(${cond})`);
      return api;
    },
    /** Push a value and return its $n placeholder (for use outside WHERE). */
    param(value) {
      params.push(value);
      return `$${params.length}`;
    },
    get sql() {
      return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
    },
    get and() {
      return parts.length ? `AND ${parts.join(' AND ')}` : '';
    },
  };
  return api;
}

/** Convert snake_case row keys to camelCase (shallow) for API output. */
export function camel(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row instanceof Date) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}
export const camelAll = (rows) => rows.map(camel);

/**
 * Build an UPDATE SET clause from a partial object using a field map (apiField → column).
 * Returns null when nothing to update.
 */
export function setClause(input, fieldMap, startIndex = 1, jsonFields = []) {
  const sets = [];
  const params = [];
  for (const [field, column] of Object.entries(fieldMap)) {
    if (input[field] === undefined) continue;
    params.push(jsonFields.includes(field) ? JSON.stringify(input[field]) : input[field]);
    sets.push(`${column} = $${startIndex + params.length - 1}`);
  }
  if (!sets.length) return null;
  return { sql: sets.join(', '), params };
}
