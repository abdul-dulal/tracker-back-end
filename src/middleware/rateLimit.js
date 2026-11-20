import { tooManyRequests } from '../lib/errors.js';
import { isTest } from '../config/env.js';

/**
 * In-memory fixed-window rate limiter (INT-05 / SEC-14). Single-instance; for multiple API
 * instances swap the store for Postgres/Redis behind the same interface.
 * @param {{windowMs:number,max:number,key?:(req)=>string,name:string}} opts
 */
export function rateLimit({ windowMs, max, key, name }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref?.();
  return (req, res, next) => {
    if (isTest && !req.get('x-test-rate-limit')) return next();
    const k = `${name}:${key ? key(req) : req.ip}`;
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count++;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.reset - now) / 1000)));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      throw tooManyRequests();
    }
    next();
  };
}

export const globalLimiter = rateLimit({
  name: 'global',
  windowMs: 60_000,
  max: 600,
  key: (req) => req.get('x-api-key') ?? req.ip,
});
export const authLimiter = rateLimit({ name: 'auth', windowMs: 15 * 60_000, max: 50 });
export const publicLimiter = rateLimit({ name: 'public', windowMs: 60_000, max: 60 });
