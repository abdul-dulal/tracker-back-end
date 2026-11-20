import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Apply pending *.sql migrations in filename order, each in its own transaction. */
export async function migrate() {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await db.many('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    await db.tx(async () => {
      await db.exec(sql);
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    logger.info({ file }, 'migration applied');
  }
}
