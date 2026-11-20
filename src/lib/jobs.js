import { db } from './db.js';
import { logger } from './logger.js';

/**
 * Postgres-backed job queue + cron (replaces BullMQ/Redis; see guide §D.4).
 *   registerJob('email.send', async (payload) => {...})
 *   await enqueue('email.send', {...}, { runAt, dedupeKey, maxAttempts })
 *   registerCron('alerts.idle', 5 * 60_000, async () => {...})
 * The worker (src/worker.js, or inline in the API process when WORKER_INLINE=true) polls the queue.
 */
const handlers = new Map();
const crons = [];

export function registerJob(name, handler) {
  handlers.set(name, handler);
}

export function registerCron(name, intervalMs, handler) {
  crons.push({ name, intervalMs, handler });
}

export async function enqueue(name, payload = {}, { runAt, dedupeKey, maxAttempts = 5 } = {}) {
  const row = await db.one(
    `INSERT INTO jobs (name, payload, run_at, dedupe_key, max_attempts)
     VALUES ($1, $2, coalesce($3::timestamptz, now()), $4, $5)
     ON CONFLICT DO NOTHING RETURNING id`,
    [name, db.json(payload), runAt ?? null, dedupeKey ?? null, maxAttempts],
  );
  return row?.id ?? null;
}

/** Run a job handler immediately (used in tests and for sync fallbacks). */
export async function runNow(name, payload = {}) {
  const h = handlers.get(name);
  if (!h) throw new Error(`No handler for job ${name}`);
  return h(payload);
}

async function claim(limit) {
  return db.tx(() =>
    db.many(
      `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
         ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, name, payload, attempts, max_attempts`,
      [limit],
    ),
  );
}

/** Process up to `limit` ready jobs. Returns number processed. */
export async function processJobs(limit = 20) {
  // Recover jobs stuck in running for > 10 minutes (crashed worker).
  await db.query(
    `UPDATE jobs SET status = 'queued' WHERE status = 'running' AND locked_at < now() - interval '10 minutes'`,
  );
  const jobs = await claim(limit);
  for (const job of jobs) {
    const handler = handlers.get(job.name);
    try {
      if (!handler) throw new Error(`No handler registered for ${job.name}`);
      await handler(job.payload ?? {});
      await db.query(`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1`, [job.id]);
    } catch (err) {
      const failed = job.attempts >= job.max_attempts;
      const backoffSec = Math.min(3600, 2 ** job.attempts * 15);
      await db.query(
        `UPDATE jobs SET status = $2, last_error = $3, run_at = now() + ($4 || ' seconds')::interval,
           finished_at = CASE WHEN $2 = 'failed' THEN now() END WHERE id = $1`,
        [job.id, failed ? 'failed' : 'queued', String(err?.stack ?? err).slice(0, 4000), String(backoffSec)],
      );
      logger.error({ err, job: job.name, attempts: job.attempts }, 'job failed');
    }
  }
  return jobs.length;
}

/** Run due cron tasks (persisted last-run so restarts don't double-fire). */
export async function runDueCrons() {
  for (const c of crons) {
    const due = await db.one(
      `INSERT INTO cron_runs (name, last_run_at) VALUES ($1, now())
       ON CONFLICT (name) DO UPDATE SET last_run_at = now()
       WHERE cron_runs.last_run_at <= now() - ($2 || ' milliseconds')::interval
       RETURNING name`,
      [c.name, String(c.intervalMs)],
    );
    if (!due) continue;
    try {
      await c.handler();
    } catch (err) {
      logger.error({ err, cron: c.name }, 'cron failed');
    }
  }
}

/** Run a cron task by name immediately (tests / admin). */
export async function runCron(name) {
  const c = crons.find((x) => x.name === name);
  if (!c) throw new Error(`No cron ${name}`);
  return c.handler();
}

let timer = null;
export function startWorker({ pollMs = 2000 } = {}) {
  if (timer) return;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueCrons();
      while ((await processJobs()) > 0) {
        /* drain */
      }
    } catch (err) {
      logger.error({ err }, 'worker loop error');
    } finally {
      busy = false;
    }
  }, pollMs);
  timer.unref?.();
  logger.info('job worker started');
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Drain all queued jobs that are due (tests). */
export async function drainJobs() {
  let n = 0;
  let processed;
  do {
    processed = await processJobs(50);
    n += processed;
  } while (processed > 0);
  return n;
}
