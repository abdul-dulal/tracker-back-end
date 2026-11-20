import express from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/authenticate.js';
import { validationError, forbidden } from './errors.js';
import { registerRoute } from '../docs/registry.js';
import { requireFeature } from '../modules/subscription/features.js';

/**
 * Declarative route helper. Each route declares auth level, permission, plan feature and Zod
 * schemas; the helper wires middleware, validation and OpenAPI documentation.
 *
 *   const r = createRouter('/projects', 'Projects');
 *   r.get('/:id', { summary: 'Get project', permission: 'projects.view', params: uuidParam }, async (req, res) => {...});
 *   export default r;
 *
 * Handlers receive validated data in req.body / req.v.query / req.v.params, and context in req.ctx.
 */
export function createRouter(prefix, tag) {
  const router = express.Router({ mergeParams: true });
  const api = { router, prefix, tag };

  const formatIssues = (issues, location) =>
    issues.map((i) => ({ path: [location, ...i.path].join('.'), message: i.message, code: i.code }));

  const validate = (opts) => (req, _res, next) => {
    req.v = { query: req.query, params: req.params };
    const issues = [];
    for (const loc of ['params', 'query', 'body']) {
      const schema = opts[loc];
      if (!schema) continue;
      const source = loc === 'body' ? (req.body ?? {}) : req[loc];
      const parsed = schema.safeParse(source);
      if (!parsed.success) issues.push(...formatIssues(parsed.error.issues, loc));
      else if (loc === 'body') req.body = parsed.data;
      else req.v[loc] = parsed.data;
    }
    if (issues.length) throw validationError(issues);
    next();
  };

  const add = (method) => (path, opts, ...handlers) => {
    const auth = opts.auth ?? 'org';
    const chain = [requireAuth(auth)];
    if (opts.permission) {
      chain.push((req, _res, next) => {
        const perms = Array.isArray(opts.permission) ? opts.permission : [opts.permission];
        // any-of semantics for arrays
        if (!perms.some((p) => req.ctx.can(p))) throw forbidden(`Missing permission: ${perms.join(' or ')}`);
        next();
      });
    }
    if (opts.roles) {
      chain.push((req, _res, next) => {
        if (!opts.roles.includes(req.ctx.role?.baseRole)) throw forbidden('Not allowed for your role');
        next();
      });
    }
    if (opts.feature) chain.push(requireFeature(opts.feature));
    if (opts.middleware) chain.push(...[].concat(opts.middleware));
    chain.push(validate(opts));
    router[method](path, ...chain, ...handlers);
    registerRoute({ method, prefix, path, tag, ...opts, auth });
    return api;
  };

  api.get = add('get');
  api.post = add('post');
  api.put = add('put');
  api.patch = add('patch');
  api.delete = add('delete');
  return api;
}

/** Zod helpers shared by modules. */
export const zBool = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true');
export const zCsvUuids = z
  .union([z.array(z.uuid()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(',').filter(Boolean)))
  .pipe(z.array(z.uuid()));
export const zColor = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'Expected hex color');
export const zCurrency = z.string().regex(/^[A-Z]{3}$/, 'Expected ISO-4217 currency code');
export const zTimezone = z.string().refine((tz) => {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Invalid IANA time zone');
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Expected HH:MM');
export const zMoney = z.union([z.number(), z.string()]).pipe(z.coerce.number().nonnegative().max(1e12));
