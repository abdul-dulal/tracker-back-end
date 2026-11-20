import { z } from 'zod';
import { createRouter } from '../../lib/router.js';
import { ok } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { assertMemberAccess, getOrgMember, assertProjectAccess } from '../../rbac/scope.js';
import { REPORT_TYPES, GROUP_DIMS, runReport, projectDetail } from './engine.js';
import { definitionSchema, formatSchema, recipientsSchema, buildReportFile, emailReport } from './service.js';
import { sendFile } from './render.js';
import { rangeQuery, filterQuery, zDims, orgTimezone, resolveRange, windowFor } from './common.js';
import { memberMetrics, consistency, projectContribution, SCORE_DISCLAIMER } from '../performance/service.js';
import { zCsvUuids } from '../../lib/router.js';

const r = createRouter('/reports', 'Reports');

const reportQuery = rangeQuery.extend({
  groupBy: zDims.pipe(z.array(z.enum(GROUP_DIMS)).max(3)).optional(),
  metrics: zDims.optional(),
  ...filterQuery,
});

const filtersFromQuery = (q) => ({
  memberIds: q.memberIds, teamIds: q.teamIds, projectIds: q.projectIds, clientIds: q.clientIds,
});

/** Run a sub-report, returning null when the caller lacks the permission/feature for it. */
async function optional(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.status === 403) return null;
    throw err;
  }
}

r.get(
  '/compare',
  {
    summary: 'Compare members, teams or projects on a metric (RPT-A05, RPT-A06)',
    ids: 'RPT-A05,RPT-A06',
    permission: 'reports.view',
    query: rangeQuery.extend({
      dimension: z.enum(['member', 'team', 'project']),
      ids: zCsvUuids.pipe(z.array(z.uuid()).min(1).max(20)),
      metric: z.string().max(40).default('trackedSeconds'),
    }),
  },
  async (req, res) => {
    const q = req.v.query;
    const reportType = q.dimension === 'project' ? 'time' : 'activity';
    const filterKey = { member: 'memberIds', team: 'teamIds', project: 'projectIds' }[q.dimension];
    const base = { reportType, from: q.from, to: q.to, range: q.range, filters: { [filterKey]: q.ids } };
    const summary = await runReport(req.ctx, { ...base, groupBy: [q.dimension] });
    if (!summary.columns.some((c) => c.key === q.metric))
      throw badRequest(`Unknown metric '${q.metric}'`, { available: summary.columns.map((c) => c.key) });
    const daily = await runReport(req.ctx, { ...base, groupBy: [q.dimension, 'day'] });
    const idKey = `${q.dimension}Id`;
    const byDate = new Map();
    for (const row of daily.rows) {
      if (!byDate.has(row.day)) byDate.set(row.day, { date: row.day });
      byDate.get(row.day)[row[idKey]] = row[q.metric];
    }
    ok(res, {
      dimension: q.dimension,
      metric: q.metric,
      from: summary.from,
      to: summary.to,
      items: summary.rows
        .filter((row) => q.ids.includes(row[idKey]))
        .map((row) => ({ id: row[idKey], label: row[q.dimension], value: row[q.metric], metrics: row })),
      series: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    });
  },
);

r.get(
  '/employees/:memberId',
  {
    summary: 'Individual employee report: hours, activity, screenshots, apps, websites, attendance, performance (RPT-E01…E08)',
    ids: 'RPT-E01,RPT-E02,RPT-E03,RPT-E04,RPT-E05,RPT-E06,RPT-E07,RPT-E08',
    permission: 'reports.view',
    params: z.object({ memberId: z.uuid() }),
    query: rangeQuery,
  },
  async (req, res) => {
    const ctx = req.ctx;
    const { memberId } = req.v.params;
    const member = await getOrgMember(ctx.orgId, memberId);
    await assertMemberAccess(ctx, 'reports.view', memberId);
    const q = req.v.query;
    const base = { from: q.from, to: q.to, range: q.range, filters: { memberIds: [memberId] } };
    const hours = await runReport(ctx, { ...base, reportType: 'activity', groupBy: ['day'] });
    const time = await runReport(ctx, { ...base, reportType: 'time', groupBy: ['project'] });
    const screenshots = await optional(() => runReport(ctx, { ...base, reportType: 'screenshots', groupBy: ['day'] }));
    const apps = await optional(() => runReport(ctx, { ...base, reportType: 'apps', groupBy: ['app', 'category'] }));
    const websites = await optional(() => runReport(ctx, { ...base, reportType: 'websites', groupBy: ['app', 'category'] }));
    const attendance = await optional(() => runReport(ctx, { ...base, reportType: 'attendance', groupBy: ['day'] }));
    const tz = await orgTimezone(ctx.orgId);
    const { from, to, today } = await resolveRange(q, tz);
    const { ws, we } = await windowFor(from, to, tz);
    const metrics = (await memberMetrics(ctx.orgId, [memberId], from, to, tz)).get(memberId);
    const cons = await consistency(ctx.orgId, memberId, from, to, today);
    ok(res, {
      member: { id: member.id, name: `${member.first_name} ${member.last_name}`.trim(), email: member.email, status: member.status },
      from,
      to,
      hours: { totals: hours.totals, series: hours.rows },
      projects: { totals: time.totals, rows: time.rows },
      screenshots: screenshots && { totals: screenshots.totals, series: screenshots.rows },
      apps: apps && { totals: apps.totals, rows: apps.rows.slice(0, 20) },
      websites: websites && { totals: websites.totals, rows: websites.rows.slice(0, 20) },
      attendance: attendance && { totals: attendance.totals, rows: attendance.rows },
      performance: {
        ...metrics,
        consistencyScore: cons.score,
        projectContribution: await projectContribution(ctx.orgId, memberId, ws, we),
        disclaimer: SCORE_DISCLAIMER,
      },
    });
  },
);

r.get(
  '/projects/:projectId',
  {
    summary: 'Project report: hours, cost, progress, completion, employee contribution (RPT-P01…P06)',
    ids: 'RPT-P01,RPT-P02,RPT-P03,RPT-P04,RPT-P05,RPT-P06',
    permission: 'reports.view',
    params: z.object({ projectId: z.uuid() }),
    query: rangeQuery.extend(filterQuery),
  },
  async (req, res) => {
    const ctx = req.ctx;
    const { projectId } = req.v.params;
    if (ctx.can('projects.view')) await assertProjectAccess(ctx, 'projects.view', projectId);
    const q = req.v.query;
    const out = await projectDetail(ctx, projectId, { from: q.from, to: q.to, range: q.range, filters: filtersFromQuery(q) });
    if (!out) throw notFound('Project');
    ok(res, out);
  },
);

r.post(
  '/run',
  {
    summary: 'Run a custom report definition (RPT-A12)',
    ids: 'RPT-A12',
    permission: 'reports.custom',
    feature: 'customReports',
    body: definitionSchema,
  },
  async (req, res) => {
    ok(res, await runReport(req.ctx, req.body));
  },
);

r.post(
  '/export',
  {
    summary: 'Export a report as PDF, CSV or Excel (RPT-A13) — returns the file',
    ids: 'RPT-A13',
    permission: 'reports.export',
    body: z.object({ definition: definitionSchema, format: formatSchema.default('pdf'), title: z.string().max(150).optional() }),
  },
  async (req, res) => {
    const { file } = await buildReportFile(req.ctx, req.body.definition, req.body.format, req.body.title);
    sendFile(res, file);
  },
);

r.post(
  '/email',
  {
    summary: 'Email a report to recipients as an attachment (RPT-A15)',
    ids: 'RPT-A15',
    permission: 'reports.export',
    body: z.object({
      definition: definitionSchema,
      format: formatSchema.default('pdf'),
      recipients: recipientsSchema,
      title: z.string().max(150).optional(),
    }),
  },
  async (req, res) => {
    ok(res, await emailReport(req.ctx, req.body));
  },
);

r.get(
  '/:type',
  {
    summary: 'Run a typed report: time, activity, apps, websites, screenshots, attendance, breaks, projects, tasks, employees (RPT-A01…A11)',
    ids: 'RPT-E02,RPT-E03,RPT-P01,RPT-P02,RPT-A01,RPT-A02,RPT-A03,RPT-A07,RPT-A08,RPT-A09,RPT-A10,RPT-A11',
    permission: 'reports.view',
    params: z.object({ type: z.enum(REPORT_TYPES) }),
    query: reportQuery,
  },
  async (req, res) => {
    const q = req.v.query;
    ok(
      res,
      await runReport(req.ctx, {
        reportType: req.v.params.type,
        from: q.from,
        to: q.to,
        range: q.range,
        groupBy: q.groupBy,
        metrics: q.metrics,
        filters: filtersFromQuery(q),
      }),
    );
  },
);

export default r;
