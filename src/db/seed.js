import { db } from '../lib/db.js';
import { ALL_PERMISSIONS } from '../rbac/catalog.js';

export const PLANS = [
  {
    code: 'free',
    name: 'Free',
    priceMonth: 0,
    priceYear: 0,
    limits: { maxSeats: 3, storageGb: 1, screenshotRetentionDays: 7, minScreenshotInterval: 10 },
    features: {
      screenshots: true,
      apps: false,
      integrations: false,
      clientPortal: false,
      payroll: false,
      invoices: false,
      api: false,
      customRoles: false,
      scheduledReports: false,
      customReports: false,
    },
    sort: 0,
  },
  {
    code: 'starter',
    name: 'Starter',
    priceMonth: 5,
    priceYear: 50,
    limits: { maxSeats: 25, storageGb: 25, screenshotRetentionDays: 30, minScreenshotInterval: 5 },
    features: {
      screenshots: true,
      apps: true,
      integrations: false,
      clientPortal: true,
      payroll: false,
      invoices: true,
      api: false,
      customRoles: false,
      scheduledReports: true,
      customReports: false,
    },
    sort: 1,
  },
  {
    code: 'professional',
    name: 'Professional',
    priceMonth: 9,
    priceYear: 90,
    limits: { maxSeats: 500, storageGb: 250, screenshotRetentionDays: 180, minScreenshotInterval: 3 },
    features: {
      screenshots: true,
      apps: true,
      integrations: true,
      clientPortal: true,
      payroll: true,
      invoices: true,
      api: true,
      customRoles: true,
      scheduledReports: true,
      customReports: true,
    },
    sort: 2,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    priceMonth: 0,
    priceYear: 0,
    limits: { maxSeats: null, storageGb: null, screenshotRetentionDays: 730, minScreenshotInterval: 3 },
    features: {
      screenshots: true,
      apps: true,
      integrations: true,
      clientPortal: true,
      payroll: true,
      invoices: true,
      api: true,
      customRoles: true,
      scheduledReports: true,
      customReports: true,
    },
    sort: 3,
    isPublic: true,
  },
];

/** Global catalog of well-known apps/websites with default categories (PDF §8 example table). */
export const APPLICATIONS = [
  ['code.exe', 'VS Code', 'app', 'productive'],
  ['com.microsoft.vscode', 'VS Code', 'app', 'productive'],
  ['figma.exe', 'Figma', 'app', 'productive'],
  ['com.figma.desktop', 'Figma', 'app', 'productive'],
  ['slack.exe', 'Slack', 'app', 'neutral'],
  ['com.tinyspeck.slackmacgap', 'Slack', 'app', 'neutral'],
  ['figma.com', 'Figma', 'website', 'productive'],
  ['github.com', 'GitHub', 'website', 'productive'],
  ['slack.com', 'Slack', 'website', 'neutral'],
  ['youtube.com', 'YouTube', 'website', 'neutral'],
  ['facebook.com', 'Facebook', 'website', 'neutral'],
];

/** Idempotent global seed: permissions, plans, application catalog. */
export async function seed() {
  for (const p of ALL_PERMISSIONS) {
    await db.query(
      `INSERT INTO permissions (key, module) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET module = EXCLUDED.module`,
      [p.key, p.module],
    );
  }
  for (const p of PLANS) {
    await db.query(
      `INSERT INTO plans (code, name, price_month, price_year, limits, features, sort_order, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, price_month = EXCLUDED.price_month,
         price_year = EXCLUDED.price_year, limits = EXCLUDED.limits, features = EXCLUDED.features,
         sort_order = EXCLUDED.sort_order`,
      [p.code, p.name, p.priceMonth, p.priceYear, db.json(p.limits), db.json(p.features), p.sort, p.isPublic ?? true],
    );
  }
  for (const [identifier, name, kind, category] of APPLICATIONS) {
    await db.query(
      `INSERT INTO applications (identifier, display_name, kind, default_category) VALUES ($1,$2,$3,$4)
       ON CONFLICT (identifier) DO NOTHING`,
      [identifier, name, kind, category],
    );
  }
}
