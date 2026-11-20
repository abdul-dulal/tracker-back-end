import { logger } from './lib/logger.js';
import { initDb, closeDb } from './lib/db.js';
import { migrate } from './db/migrate.js';
import { loadModules } from './modules/index.js';
import { startWorker, stopWorker } from './lib/jobs.js';

/** Standalone background worker (use with WORKER_INLINE=false on API instances). */
async function main() {
  await initDb();
  await migrate();
  await loadModules(); // registers jobs & crons
  startWorker({ pollMs: 1000 });
  const stop = async () => {
    stopWorker();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed');
  process.exit(1);
});
