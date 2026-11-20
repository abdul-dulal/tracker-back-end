import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Database access layer.
 * - PostgreSQL (pg Pool) when DATABASE_URL is set.
 * - Embedded PGlite (real Postgres in WASM) otherwise — for local dev & tests.
 *
 * Usage:
 *   await db.query(sql, params)     → { rows, rowCount }
 *   await db.one(sql, params)       → first row or null
 *   await db.many(sql, params)      → rows[]
 *   await db.tx(async () => {...})  → every db.* call inside runs in the same transaction
 *
 * Conventions: int8 (bigint/count) parsed to Number, numeric stays string (money-safe),
 * jsonb values must be passed as JSON strings (use db.json()).
 */

const txStore = new AsyncLocalStorage();
let driver = null;

async function createPgDriver(url) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  pg.types.setTypeParser(1082, (v) => v); // date → 'YYYY-MM-DD'
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  return {
    kind: 'pg',
    query: (text, params) => pool.query(text, params),
    exec: (text) => pool.query(text),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const res = await fn({ query: (t, p) => client.query(t, p), exec: (t) => client.query(t) });
        await client.query('COMMIT');
        return res;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function createPgliteDriver(dataDir) {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const lite = new PGlite({
    dataDir,
    extensions: { citext, btree_gist, pg_trgm },
    parsers: {
      [types.INT8]: (v) => (v === null ? null : Number(v)),
      [types.DATE]: (v) => v,
    },
  });
  await lite.waitReady;
  const normalize = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });
  return {
    kind: 'pglite',
    query: async (text, params) => normalize(await lite.query(text, params)),
    exec: (text) => lite.exec(text),
    tx: (fn) =>
      lite.transaction((t) =>
        fn({ query: async (q, p) => normalize(await t.query(q, p)), exec: (q) => t.exec(q) }),
      ),
    close: () => lite.close(),
  };
}

export async function initDb({ memory = false } = {}) {
  if (driver) return driver;
  if (env.DATABASE_URL && !memory) {
    driver = await createPgDriver(env.DATABASE_URL);
  } else {
    driver = await createPgliteDriver(memory ? undefined : env.PGLITE_DIR);
  }
  logger.info({ driver: driver.kind }, 'database initialized');
  return driver;
}

export async function closeDb() {
  if (driver) await driver.close();
  driver = null;
}

function current() {
  const tx = txStore.getStore();
  if (tx) return tx;
  if (!driver) throw new Error('Database not initialized');
  return driver;
}

export const db = {
  get kind() {
    return driver?.kind;
  },
  query(text, params = []) {
    return current().query(text, params);
  },
  async one(text, params = []) {
    const r = await current().query(text, params);
    return r.rows[0] ?? null;
  },
  async many(text, params = []) {
    const r = await current().query(text, params);
    return r.rows;
  },
  /** Execute multi-statement SQL (migrations). */
  exec(text) {
    const tx = txStore.getStore();
    return tx ? tx.exec(text) : driver.exec(text);
  },
  /** Run fn inside a transaction. Nested calls reuse the outer transaction. */
  tx(fn) {
    if (txStore.getStore()) return fn();
    return driver.tx((client) => txStore.run(client, fn));
  },
  json(value) {
    return value === undefined || value === null ? null : JSON.stringify(value);
  },
};
