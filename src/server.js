import http from 'node:http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { initDb, closeDb } from './lib/db.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { createApp } from './app.js';
import { attachSocket } from './realtime/socket.js';
import { startWorker, stopWorker } from './lib/jobs.js';

async function main() {
  await initDb();
  await migrate();
  await seed();
  const app = await createApp();
  const server = http.createServer(app);
  attachSocket(server);
  if (env.WORKER_INLINE) startWorker();
  server.listen(env.PORT, () => logger.info(`Tracker API listening on ${env.APP_URL} (docs: ${env.APP_URL}/api/docs)`));

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    stopWorker();
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
