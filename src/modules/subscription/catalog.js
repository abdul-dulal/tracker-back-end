/** Single source of truth for plan codes and plan feature flags (served to the UI via /platform/plans/catalog). */
export const PLAN_CODES = ['free', 'starter', 'professional', 'enterprise'];

export const PLAN_FEATURES = [
  ['screenshots', 'Screenshots'],
  ['apps', 'App & URL tracking'],
  ['integrations', 'Integrations'],
  ['clientPortal', 'Client portal'],
  ['payroll', 'Payroll'],
  ['invoices', 'Invoices'],
  ['api', 'API & webhooks'],
  ['customRoles', 'Custom roles'],
  ['scheduledReports', 'Scheduled reports'],
  ['customReports', 'Custom reports'],
].map(([key, label]) => ({ key, label }));

/** Allowed screenshot intervals (minutes). */
export const SCREENSHOT_INTERVALS = [3, 5, 10, 15];
