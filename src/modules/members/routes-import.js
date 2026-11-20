import { z } from 'zod';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify as stringifyCsv } from 'csv-stringify/sync';
import { createRouter } from '../../lib/router.js';
import { db } from '../../lib/db.js';
import { ok, created } from '../../lib/http.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { assertSeatsAvailable } from '../subscription/features.js';
import { createMember, afterCreate } from './service.js';

/** EMP-22 bulk import (CSV / XLSX): upload → validate → preview → commit. Mounted under /members. */
const r = createRouter('/members', 'Members');

const MAX_ROWS = 1000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

export const COLUMNS = ['email', 'firstName', 'lastName', 'employeeCode', 'designation', 'department', 'team', 'role', 'employmentType', 'joinedOn', 'weeklyHours', 'hourlyRate'];
const SAMPLE = ['jane.doe@example.com', 'Jane', 'Doe', '', 'Software Engineer', 'Engineering', 'Platform', 'employee', 'full_time', '2026-01-15', '40', '25.00'];

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER_MAP = Object.fromEntries(COLUMNS.map((c) => [norm(c), c]));
Object.assign(HEADER_MAP, { emailaddress: 'email', first: 'firstName', last: 'lastName', employeeid: 'employeeCode', code: 'employeeCode', title: 'designation', jobtitle: 'designation', rate: 'hourlyRate', startdate: 'joinedOn', joiningdate: 'joinedOn', type: 'employmentType' });

const EMPLOYMENT = { fulltime: 'full_time', parttime: 'part_time', contract: 'contract', contractor: 'contract' };

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.hyperlink) return String(v.hyperlink).replace(/^mailto:/, '');
  }
  return String(v);
}

async function readRows(file) {
  const name = (file.originalname ?? '').toLowerCase();
  const isXlsx = name.endsWith('.xlsx') || file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  let matrix;
  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer);
    } catch {
      throw badRequest('Could not read the Excel file', undefined, 'INVALID_FILE');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('The workbook has no sheets', undefined, 'INVALID_FILE');
    matrix = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let i = 1; i <= Math.max(row.cellCount, COLUMNS.length); i++) vals.push(cellText(row.getCell(i).value).trim());
      matrix.push(vals);
    });
  } else if (name.endsWith('.csv') || /csv|text\/plain|application\/vnd\.ms-excel/.test(file.mimetype ?? '')) {
    try {
      matrix = parseCsv(file.buffer, { bom: true, skip_empty_lines: true, trim: true, relax_column_count: true });
    } catch (err) {
      throw badRequest(`Could not parse CSV: ${err.message}`, undefined, 'INVALID_FILE');
    }
  } else throw badRequest('Upload a .csv or .xlsx file', undefined, 'UNSUPPORTED_FILE_TYPE');
  if (!matrix.length) throw badRequest('The file is empty', undefined, 'INVALID_FILE');
  const header = matrix[0].map((h) => HEADER_MAP[norm(h)] ?? null);
  if (!header.includes('email')) throw badRequest('Missing required column "email"', undefined, 'INVALID_FILE');
  if (!header.includes('firstName')) throw badRequest('Missing required column "firstName"', undefined, 'INVALID_FILE');
  const rows = matrix
    .slice(1)
    .filter((vals) => vals.some((v) => String(v ?? '').trim() !== ''))
    .map((vals) => {
      const o = {};
      header.forEach((k, i) => {
        if (k) o[k] = String(vals[i] ?? '').trim();
      });
      return o;
    });
  if (rows.length > MAX_ROWS) throw badRequest(`Too many rows (max ${MAX_ROWS})`, undefined, 'TOO_MANY_ROWS');
  return rows;
}

const emailSchema = z.email().max(254);

/** Validate raw rows → normalized rows with per-row errors. */
async function validateRows(ctx, raw) {
  const roles = await db.many('SELECT id, slug, name, base_role, level FROM roles WHERE organization_id = $1', [ctx.orgId]);
  const existing = new Map(
    (
      await db.many(
        `SELECT lower(u.email) AS email, m.status FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND m.deleted_at IS NULL`,
        [ctx.orgId],
      )
    ).map((x) => [x.email, x.status]),
  );
  const codes = new Set((await db.many('SELECT employee_code FROM organization_members WHERE organization_id = $1 AND employee_code IS NOT NULL', [ctx.orgId])).map((x) => x.employee_code.toLowerCase()));
  const seenEmails = new Set();
  const seenCodes = new Set();
  const errors = [];
  const rows = raw.map((x, i) => {
    const rowNumber = i + 2; // 1-based, header is row 1
    const errs = [];
    const err = (field, message) => errs.push({ row: rowNumber, field, message });
    const email = (x.email ?? '').toLowerCase();
    if (!email) err('email', 'Email is required');
    else if (!emailSchema.safeParse(email).success) err('email', 'Invalid email');
    else if (seenEmails.has(email)) err('email', 'Duplicate email in file');
    else if (existing.has(email)) err('email', `Already a member (${existing.get(email)})`);
    seenEmails.add(email);
    if (!x.firstName) err('firstName', 'First name is required');
    else if (x.firstName.length > 100) err('firstName', 'Too long');
    if ((x.lastName ?? '').length > 100) err('lastName', 'Too long');
    const code = x.employeeCode || null;
    if (code) {
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(code)) err('employeeCode', 'Invalid employee code');
      else if (codes.has(code.toLowerCase())) err('employeeCode', 'Employee code already in use');
      else if (seenCodes.has(code.toLowerCase())) err('employeeCode', 'Duplicate employee code in file');
      seenCodes.add(code.toLowerCase());
    }
    let role = roles.find((r0) => r0.slug === 'employee');
    if (x.role) {
      role = roles.find((r0) => r0.slug === norm(x.role).replace(/^teamleader$/, 'team_leader') || r0.slug === x.role.toLowerCase() || r0.name.toLowerCase() === x.role.toLowerCase());
      if (!role) err('role', `Unknown role "${x.role}"`);
      else if (role.base_role === 'owner') err('role', 'Owner role cannot be imported');
      else if (role.level > (ctx.role?.level ?? 0)) err('role', 'You cannot assign a role above your own');
    }
    let employmentType = 'full_time';
    if (x.employmentType) {
      employmentType = EMPLOYMENT[norm(x.employmentType)];
      if (!employmentType) err('employmentType', 'Use full_time, part_time or contract');
    }
    let joinedOn = null;
    if (x.joinedOn) {
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(x.joinedOn);
      const d = iso ? new Date(`${x.joinedOn}T00:00:00Z`) : new Date(x.joinedOn);
      if (Number.isNaN(d.getTime()) || (iso && d.toISOString().slice(0, 10) !== x.joinedOn)) err('joinedOn', 'Invalid date (use YYYY-MM-DD)');
      else joinedOn = d.toISOString().slice(0, 10);
    }
    let weeklyHours = null;
    if (x.weeklyHours) {
      weeklyHours = Number(x.weeklyHours);
      if (!Number.isFinite(weeklyHours) || weeklyHours < 0 || weeklyHours > 168) err('weeklyHours', 'Must be between 0 and 168');
    }
    let hourlyRate = null;
    if (x.hourlyRate) {
      hourlyRate = Number(String(x.hourlyRate).replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(hourlyRate) || hourlyRate < 0) err('hourlyRate', 'Must be a non-negative number');
      else if (!(ctx.can('payroll.manage') || ctx.can('billing.manage'))) err('hourlyRate', 'You need payroll.manage to import rates');
    }
    if ((x.designation ?? '').length > 120) err('designation', 'Too long');
    if ((x.department ?? '').length > 120) err('department', 'Too long');
    if ((x.team ?? '').length > 120) err('team', 'Too long');
    errors.push(...errs);
    return {
      rowNumber,
      valid: errs.length === 0,
      errors: errs.map((e) => ({ field: e.field, message: e.message })),
      data: {
        email,
        firstName: x.firstName ?? '',
        lastName: x.lastName ?? '',
        employeeCode: code,
        designation: x.designation || null,
        department: x.department || null,
        team: x.team || null,
        roleId: role?.id ?? null,
        roleSlug: role?.slug ?? x.role ?? null,
        roleBase: role?.base_role ?? null,
        employmentType: employmentType ?? null,
        joinedOn,
        weeklyHours,
        hourlyRate,
      },
    };
  });
  return { rows, errors };
}

const jobDto = (j) => ({
  id: j.id,
  type: j.type,
  status: j.status,
  rowsTotal: j.rows_total,
  rowsValid: j.rows_valid,
  rowsInvalid: j.rows_total - j.rows_valid,
  errors: j.errors,
  rows: j.rows,
  result: j.result,
  createdAt: j.created_at,
});

r.get(
  '/import/template',
  { summary: 'Download the import template', ids: 'EMP-22', permission: 'members.import', query: z.object({ format: z.enum(['csv', 'xlsx']).default('csv') }) },
  async (req, res) => {
    if (req.v.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="employee-import-template.csv"');
      return res.send(stringifyCsv([COLUMNS, SAMPLE]));
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees');
    ws.addRow(COLUMNS);
    ws.addRow(SAMPLE);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => {
      c.width = 20;
    });
    const help = wb.addWorksheet('Instructions');
    help.addRows([
      ['Column', 'Notes'],
      ['email', 'Required. Unique per organization.'],
      ['firstName', 'Required.'],
      ['employeeCode', 'Optional. Auto-generated (EMP-0001…) when empty.'],
      ['department / team', 'Optional. Created automatically when they do not exist.'],
      ['role', 'Role slug or name (default: employee).'],
      ['employmentType', 'full_time | part_time | contract'],
      ['joinedOn', 'YYYY-MM-DD'],
      ['weeklyHours', 'Expected weekly hours (default 40).'],
      ['hourlyRate', 'Pay rate in the organization currency (requires payroll permission).'],
    ]);
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="employee-import-template.xlsx"');
    res.send(Buffer.from(buf));
  },
);

r.post('/import', { summary: 'Upload CSV/XLSX → validation preview', ids: 'EMP-22', permission: 'members.import', middleware: upload.single('file') }, async (req, res) => {
  if (!req.file) throw badRequest('Attach the file as multipart field "file"', [{ path: 'body.file', message: 'Required' }], 'VALIDATION_ERROR');
  const raw = await readRows(req.file);
  if (!raw.length) throw badRequest('The file has no data rows', undefined, 'INVALID_FILE');
  const { rows, errors } = await validateRows(req.ctx, raw);
  const job = await db.one(
    `INSERT INTO import_jobs (organization_id, type, status, rows, rows_total, rows_valid, errors, created_by)
     VALUES ($1,'members','validated',$2,$3,$4,$5,$6) RETURNING *`,
    [req.ctx.orgId, db.json(rows), rows.length, rows.filter((x) => x.valid).length, db.json(errors), req.ctx.memberId ?? null],
  );
  await audit(req.ctx, 'member_import.validated', { entityType: 'import_job', entityId: job.id, after: { rowsTotal: job.rows_total, rowsValid: job.rows_valid } });
  created(res, jobDto(job));
});

async function loadJob(ctx, id) {
  const j = await db.one(`SELECT * FROM import_jobs WHERE id = $1 AND organization_id = $2 AND type = 'members'`, [id, ctx.orgId]);
  if (!j) throw notFound('Import job');
  return j;
}

r.get('/import/:jobId', { summary: 'Import preview / result', ids: 'EMP-22', permission: 'members.import', params: z.object({ jobId: z.uuid() }) }, async (req, res) => {
  ok(res, jobDto(await loadJob(req.ctx, req.v.params.jobId)));
});

/** Find or create a department/team by name (case-insensitive). */
async function resolveByName(table, orgId, name, cache) {
  const key = `${table}:${name.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  let row = await db.one(`SELECT id FROM ${table} WHERE organization_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL`, [orgId, name]);
  if (!row) row = await db.one(`INSERT INTO ${table} (organization_id, name) VALUES ($1,$2) RETURNING id`, [orgId, name]);
  cache.set(key, row.id);
  return row.id;
}

r.post('/import/:jobId/commit', { summary: 'Commit import: create members + invitations for valid rows', ids: 'EMP-22, SUB-17', permission: 'members.import', params: z.object({ jobId: z.uuid() }) }, async (req, res) => {
  const ctx = req.ctx;
  const job = await loadJob(ctx, req.v.params.jobId);
  if (job.status !== 'validated') throw conflict('IMPORT_ALREADY_PROCESSED', `This import is already ${job.status}`);
  const valid = job.rows.filter((x) => x.valid);
  if (!valid.length) throw badRequest('There are no valid rows to import', undefined, 'NOTHING_TO_IMPORT');
  const seatRows = valid.filter((x) => x.data.roleBase !== 'client').length;
  if (seatRows) await assertSeatsAvailable(ctx.orgId, seatRows);
  const cache = new Map();
  const results = [];
  const createdMembers = [];
  for (const row of valid) {
    const d = row.data;
    try {
      const { member, invitation } = await db.tx(async () => {
        const departmentId = d.department ? await resolveByName('departments', ctx.orgId, d.department, cache) : undefined;
        const teamId = d.team ? await resolveByName('teams', ctx.orgId, d.team, cache) : undefined;
        return createMember(
          ctx,
          {
            email: d.email,
            firstName: d.firstName,
            lastName: d.lastName,
            roleId: d.roleId,
            employeeCode: d.employeeCode ?? undefined,
            designation: d.designation,
            departmentId,
            teamIds: teamId ? [teamId] : undefined,
            employmentType: d.employmentType,
            joinedOn: d.joinedOn,
            weeklyHours: d.weeklyHours ?? undefined,
            hourlyRate: d.hourlyRate ?? undefined,
          },
          { skipSeatCheck: true },
        );
      });
      createdMembers.push(member);
      results.push({ row: row.rowNumber, email: d.email, status: 'created', memberId: member.id, invitationId: invitation.id });
    } catch (err) {
      // Department/team created in the failed transaction were rolled back: drop them from the cache.
      for (const k of [...cache.keys()]) {
        const id = cache.get(k);
        const table = k.startsWith('departments:') ? 'departments' : 'teams';
        if (!(await db.one(`SELECT 1 FROM ${table} WHERE id = $1`, [id]))) cache.delete(k);
      }
      results.push({ row: row.rowNumber, email: d.email, status: 'failed', code: err.code ?? 'ERROR', message: err.message });
    }
  }
  for (const m of createdMembers) await afterCreate(ctx, m);
  const result = {
    created: results.filter((x) => x.status === 'created').length,
    failed: results.filter((x) => x.status === 'failed').length,
    skippedInvalid: job.rows_total - valid.length,
    results,
  };
  const status = result.created === 0 ? 'failed' : 'committed';
  const updated = await db.one(`UPDATE import_jobs SET status = $2, result = $3 WHERE id = $1 RETURNING *`, [job.id, status, db.json(result)]);
  await audit(ctx, 'member_import.committed', { entityType: 'import_job', entityId: job.id, after: { created: result.created, failed: result.failed } });
  ok(res, jobDto(updated));
});

export default r;
