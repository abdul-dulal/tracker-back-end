import { db } from '../../../lib/db.js';
import { AppError } from '../../../lib/errors.js';
import { seedColumns } from '../../projects/service.js';

/** Outbound HTTP helper for provider adapters (global fetch, 15 s timeout). */
export async function http(url, { method = 'GET', headers = {}, body, json = true, timeoutMs = 15_000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined && json ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : json && typeof body !== 'string' ? JSON.stringify(body) : body,
      signal: ac.signal,
    });
  } catch (err) {
    throw new AppError(502, 'INTEGRATION_UNREACHABLE', `Could not reach ${new URL(url).host}: ${ac.signal.aborted ? 'timeout' : err.message}`);
  } finally {
    clearTimeout(t);
  }
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    const code = resp.status === 401 || resp.status === 403 ? 'INTEGRATION_AUTH_FAILED' : 'INTEGRATION_ERROR';
    throw new AppError(502, code, `${new URL(url).host} responded ${resp.status}`, { status: resp.status, body: text.slice(0, 500) });
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const httpsUrl = (v) => {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

async function findLink(integrationId, externalType, externalId) {
  return db.one(
    `SELECT * FROM integration_links WHERE integration_id = $1 AND external_type = $2 AND external_id = $3`,
    [integrationId, externalType, String(externalId)],
  );
}

async function link(integration, externalType, externalId, internalType, internalId) {
  await db.query(
    `INSERT INTO integration_links (organization_id, integration_id, external_type, external_id, internal_type, internal_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (integration_id, external_type, external_id) DO UPDATE SET internal_id = EXCLUDED.internal_id`,
    [integration.organization_id, integration.id, externalType, String(externalId), internalType, internalId],
  );
}

/**
 * Upsert an external project → projects (linked via integration_links). Reuses a same-named project.
 * @returns {Promise<{id:string, created:boolean}>}
 */
export async function upsertProject(ctx, integration, { externalId, externalType = 'project', name, description }) {
  const orgId = integration.organization_id;
  const existing = await findLink(integration.id, externalType, externalId);
  if (existing) {
    const p = await db.one('SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL', [existing.internal_id]);
    if (p) {
      await db.query('UPDATE projects SET description = coalesce($2, description), updated_at = now() WHERE id = $1', [p.id, description ?? null]);
      return { id: p.id, created: false };
    }
  }
  const safeName = String(name || `Imported ${externalId}`).slice(0, 150);
  let p = await db.one('SELECT id FROM projects WHERE organization_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL', [orgId, safeName]);
  let createdNew = false;
  if (!p) {
    p = await db.one(
      `INSERT INTO projects (organization_id, name, description, status, created_by) VALUES ($1,$2,$3,'active',$4) RETURNING id`,
      [orgId, safeName, description ?? null, ctx?.memberId ?? null],
    );
    await seedColumns(orgId, p.id);
    createdNew = true;
  }
  await link(integration, externalType, externalId, 'project', p.id);
  return { id: p.id, created: createdNew };
}

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export function mapPriority(name) {
  const n = String(name ?? '').toLowerCase();
  if (PRIORITIES.includes(n)) return n;
  if (/highest|critical|blocker|urgent|^1$/.test(n)) return 'urgent';
  if (/high|^2$/.test(n)) return 'high';
  if (/low|lowest|^4$|^5$/.test(n)) return 'low';
  return 'medium';
}

const toDate = (v) => {
  if (!v) return null;
  const d = typeof v === 'number' || /^\d{10,}$/.test(String(v)) ? new Date(Number(v)) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/**
 * Upsert an external issue/card → tasks.
 * @returns {Promise<{id:string, created:boolean}>}
 */
export async function upsertTask(ctx, integration, projectId, { externalId, externalType = 'task', title, description, dueDate, priority, done, url }) {
  const orgId = integration.organization_id;
  const category = done ? 'done' : 'todo';
  const col = await db.one(
    'SELECT id FROM board_columns WHERE project_id = $1 AND category = $2 ORDER BY position LIMIT 1',
    [projectId, category],
  );
  const ref = db.json({ provider: integration.provider, id: String(externalId), url: url ?? null });
  const existing = await findLink(integration.id, externalType, externalId);
  if (existing) {
    const t = await db.one(
      `UPDATE tasks SET title = $2, description = coalesce($3, description), due_date = $4, priority = $5,
         completed_at = CASE WHEN $6 THEN coalesce(completed_at, now()) ELSE NULL END,
         column_id = coalesce($7, column_id), external_ref = $8, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [existing.internal_id, String(title).slice(0, 300), description ?? null, toDate(dueDate), mapPriority(priority), !!done, col?.id ?? null, ref],
    );
    if (t) return { id: t.id, created: false };
  }
  const pos = (await db.one('SELECT coalesce(max(position), 0) + 1 AS p FROM tasks WHERE project_id = $1', [projectId])).p;
  const t = await db.one(
    `INSERT INTO tasks (organization_id, project_id, column_id, title, description, due_date, priority, position, completed_at, created_by, external_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9 THEN now() END, $10, $11) RETURNING id`,
    [orgId, projectId, col?.id ?? null, String(title || 'Untitled').slice(0, 300), description ?? null, toDate(dueDate), mapPriority(priority), pos, !!done, ctx?.memberId ?? null, ref],
  );
  await link(integration, externalType, externalId, 'task', t.id);
  return { id: t.id, created: true };
}

/** Run an import of {project, tasks[]} groups and return counts. */
export async function importGroups(ctx, integration, groups) {
  const stats = { projectsCreated: 0, projectsUpdated: 0, tasksCreated: 0, tasksUpdated: 0 };
  for (const g of groups) {
    const p = await upsertProject(ctx, integration, g.project);
    stats[p.created ? 'projectsCreated' : 'projectsUpdated']++;
    for (const t of g.tasks) {
      const r = await upsertTask(ctx, integration, p.id, t);
      stats[r.created ? 'tasksCreated' : 'tasksUpdated']++;
    }
  }
  return stats;
}

/** Find the external id linked to an internal entity (e.g. task → Jira issue). */
export async function externalIdFor(integrationId, internalType, internalId) {
  const row = await db.one(
    'SELECT external_id FROM integration_links WHERE integration_id = $1 AND internal_type = $2 AND internal_id = $3 LIMIT 1',
    [integrationId, internalType, internalId],
  );
  return row?.external_id ?? null;
}

/** Human-readable one-line message for a domain event (Slack / Teams). */
export function formatEvent(evt, orgName) {
  const d = evt;
  const who = d.memberName ?? d.member?.name ?? '';
  const proj = d.entry?.project?.name ?? d.project?.name;
  const task = d.entry?.task?.title ?? d.task?.title;
  const parts = {
    'timer.started': `Timer started${who ? ` by ${who}` : ''}${proj ? ` on ${proj}` : ''}${task ? ` / ${task}` : ''}`,
    'timer.stopped': `Timer stopped${who ? ` by ${who}` : ''}${d.entry?.durationSeconds ? ` (${Math.round(d.entry.durationSeconds / 60)} min)` : ''}`,
    'project.created': `New project: ${proj ?? ''}`,
    'task.created': `New task: ${task ?? ''}`,
    'task.completed': `Task completed: ${task ?? ''}`,
    'timesheet.submitted': 'A timesheet was submitted for approval',
    'timesheet.approved': 'A timesheet was approved',
    'invoice.paid': `Invoice ${d.invoice?.number ?? ''} paid`,
  };
  const text = parts[evt.event] ?? `${evt.event.replace(/[._]/g, ' ')}`;
  return `[${orgName ?? 'Tracker'}] ${text}`.trim();
}
