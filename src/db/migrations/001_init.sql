-- Tracker initial schema (see TRACKER_DASHBOARD_BACK-END.md §E)
-- Conventions: uuid PKs, organization_id on tenant tables, timestamptz in UTC,
-- text + CHECK instead of enum types, numeric for money, soft delete via deleted_at.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ───────────────────────── E.1 Identity & tenancy ─────────────────────────
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text,
  first_name varchar(100) NOT NULL,
  last_name varchar(100) NOT NULL DEFAULT '',
  avatar_key text,
  phone varchar(40),
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  time_format text NOT NULL DEFAULT '24h' CHECK (time_format IN ('12h','24h')),
  date_format varchar(20) NOT NULL DEFAULT 'YYYY-MM-DD',
  locale varchar(10) NOT NULL DEFAULT 'en',
  email_verified_at timestamptz,
  is_super_admin boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  mfa_enabled boolean NOT NULL DEFAULT false,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google')),
  provider_user_id varchar(255) NOT NULL,
  email citext,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE user_mfa (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret_enc text NOT NULL,
  recovery_codes_hash text[] NOT NULL DEFAULT '{}',
  enabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  name varchar(100) NOT NULL DEFAULT 'Passkey',
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('email_verify','password_reset','mfa_login','webauthn_challenge','oauth_state')),
  token_hash text NOT NULL UNIQUE,
  payload jsonb,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_type_idx ON auth_tokens (user_id, type);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(150) NOT NULL,
  slug varchar(80) NOT NULL UNIQUE,
  logo_key text,
  brand_color varchar(9),
  industry varchar(80),
  size varchar(20),
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  default_currency char(3) NOT NULL DEFAULT 'USD',
  date_format varchar(20) NOT NULL DEFAULT 'YYYY-MM-DD',
  time_format text NOT NULL DEFAULT '24h' CHECK (time_format IN ('12h','24h')),
  week_start smallint NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
  country varchar(2),
  address jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  owner_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE organization_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  working_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  work_start time NOT NULL DEFAULT '09:00',
  work_end time NOT NULL DEFAULT '17:00',
  activity_low_max smallint NOT NULL DEFAULT 30,
  activity_moderate_max smallint NOT NULL DEFAULT 60,
  require_manual_time_approval boolean NOT NULL DEFAULT true,
  allow_employee_edit_time boolean NOT NULL DEFAULT false,
  allow_employee_delete_time boolean NOT NULL DEFAULT false,
  overtime_mode text NOT NULL DEFAULT 'weekly' CHECK (overtime_mode IN ('daily','weekly','both','none')),
  overtime_multiplier numeric(4,2) NOT NULL DEFAULT 1.5,
  timesheet_period text NOT NULL DEFAULT 'week' CHECK (timesheet_period IN ('week','biweek','month')),
  timesheet_approval_levels smallint NOT NULL DEFAULT 1 CHECK (timesheet_approval_levels BETWEEN 1 AND 3),
  timesheet_lock_after_days smallint,
  attendance_auto_checkin boolean NOT NULL DEFAULT true,
  late_grace_minutes smallint NOT NULL DEFAULT 10,
  early_leave_grace_minutes smallint NOT NULL DEFAULT 10,
  enforce_2fa boolean NOT NULL DEFAULT false,
  session_idle_timeout_minutes int,
  leaderboard_visible_to_employees boolean NOT NULL DEFAULT true,
  productivity_weights jsonb NOT NULL DEFAULT '{"activity":0.4,"productive":0.4,"tasks":0.2}',
  default_billable_rate numeric(12,2),
  budget_alert_percents smallint[] NOT NULL DEFAULT '{80,100}',
  consent_policy_version int NOT NULL DEFAULT 1,
  consent_policy_text text NOT NULL DEFAULT 'Your employer uses Tracker to record working time. While the timer runs, Tracker may capture screenshots, keyboard/mouse activity levels (never what you type), and application/website usage according to your organization''s settings. You can always see what is tracked and view your own data.',
  data_retention_days int,
  activity_retention_days int,
  invoice_prefix varchar(10) NOT NULL DEFAULT 'INV-',
  next_invoice_number int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── E.2 RBAC ─────────────────────────
CREATE TABLE permissions (
  id serial PRIMARY KEY,
  key varchar(80) NOT NULL UNIQUE,
  module varchar(40) NOT NULL,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  slug varchar(80) NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  base_role text NOT NULL CHECK (base_role IN ('owner','admin','manager','team_leader','employee','client')),
  level smallint NOT NULL DEFAULT 10,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id int NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('own','team','project','org')),
  PRIMARY KEY (role_id, permission_id)
);

-- ───────────────────────── E.3 Organization structure (part 1) ─────────────────────────
CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  description text,
  head_member_id uuid,
  parent_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX departments_org_name_uq ON departments (organization_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE work_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  schedule_type text NOT NULL DEFAULT 'fixed' CHECK (schedule_type IN ('fixed','flexible')),
  working_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  start_time time,
  end_time time,
  required_hours_per_day numeric(5,2) NOT NULL DEFAULT 8,
  work_mode text NOT NULL DEFAULT 'office' CHECK (work_mode IN ('office','remote','hybrid')),
  timezone varchar(64),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX work_schedules_default_uq ON work_schedules (organization_id) WHERE is_default;

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(150) NOT NULL,
  email citext,
  phone varchar(40),
  company varchar(150),
  address jsonb,
  currency char(3),
  hourly_rate numeric(12,2),
  portal_permissions jsonb NOT NULL DEFAULT '{"showScreenshots":false,"showActivity":false,"showMemberNames":true,"showRates":false}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX clients_org_name_uq ON clients (organization_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','inactive','suspended')),
  employee_code varchar(32),
  designation varchar(120),
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  employment_type text NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time','part_time','contract')),
  joined_on date,
  work_schedule_id uuid REFERENCES work_schedules(id) ON DELETE SET NULL,
  weekly_hours numeric(5,2) NOT NULL DEFAULT 40,
  weekly_limit_hours numeric(5,2),
  work_mode text NOT NULL DEFAULT 'office' CHECK (work_mode IN ('office','remote','hybrid')),
  timezone varchar(64),
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  restrictions jsonb NOT NULL DEFAULT '{}',
  work_email citext,
  deactivated_at timestamptz,
  status_reason text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, employee_code)
);
CREATE INDEX organization_members_org_status_idx ON organization_members (organization_id, status);
ALTER TABLE departments ADD CONSTRAINT departments_head_fk FOREIGN KEY (head_member_id) REFERENCES organization_members(id) ON DELETE SET NULL;

CREATE TABLE member_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('team','project','department')),
  scope_id uuid NOT NULL,
  UNIQUE (member_id, scope_type, scope_id)
);

CREATE TABLE member_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  rate_type text NOT NULL CHECK (rate_type IN ('pay','cost','billable')),
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL,
  pay_type text NOT NULL DEFAULT 'hourly' CHECK (pay_type IN ('hourly','monthly_salary')),
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (member_id WITH =, rate_type WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
);
CREATE INDEX member_rates_lookup_idx ON member_rates (member_id, rate_type, effective_from DESC);

CREATE TABLE member_managers (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  manager_member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  PRIMARY KEY (member_id, manager_member_id),
  CHECK (member_id <> manager_member_id)
);
CREATE INDEX member_managers_manager_idx ON member_managers (manager_member_id);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'desktop_agent' CHECK (kind IN ('desktop_agent','browser')),
  os text NOT NULL DEFAULT 'other' CHECK (os IN ('windows','macos','linux','other')),
  os_version varchar(60),
  app_version varchar(30),
  hostname varchar(120),
  machine_id_hash varchar(128) NOT NULL,
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  pending_count int NOT NULL DEFAULT 0,
  online boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, machine_id_hash)
);

CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  refresh_token_hash text NOT NULL UNIQUE,
  family_id uuid NOT NULL,
  ip inet,
  user_agent text,
  remember_me boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_reason varchar(60),
  replaced_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id, revoked_at);
CREATE INDEX sessions_family_idx ON sessions (family_id);

CREATE TABLE login_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  email_attempted citext,
  method text NOT NULL CHECK (method IN ('password','google','passkey','agent','mfa','refresh')),
  success boolean NOT NULL,
  failure_reason varchar(60),
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_history_user_idx ON login_history (user_id, created_at DESC);
CREATE INDEX login_history_email_idx ON login_history (email_attempted, created_at DESC);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email citext NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id),
  team_id uuid,
  project_ids uuid[] NOT NULL DEFAULT '{}',
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  member_id uuid REFERENCES organization_members(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','expired','revoked')),
  invited_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_user_id uuid REFERENCES users(id),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_pending_uq ON invitations (organization_id, email) WHERE status = 'pending';

CREATE TABLE invitation_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  token_enc text NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id),
  team_id uuid,
  max_uses int,
  uses int NOT NULL DEFAULT 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  policy_version int NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip inet,
  features jsonb,
  UNIQUE (member_id, policy_version)
);

-- ───────────────────────── E.3 Teams ─────────────────────────
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  description text,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  work_schedule_id uuid REFERENCES work_schedules(id) ON DELETE SET NULL,
  color varchar(9),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX teams_org_name_uq ON teams (organization_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  is_leader boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, member_id)
);
CREATE INDEX team_members_member_idx ON team_members (member_id);

CREATE TABLE team_managers (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, member_id)
);
CREATE INDEX team_managers_member_idx ON team_managers (member_id);

-- ───────────────────────── E.4 Projects & tasks ─────────────────────────
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(150) NOT NULL,
  code varchar(20),
  description text,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('planning','active','on_hold','completed','cancelled')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  start_date date,
  deadline date,
  budget_type text NOT NULL DEFAULT 'none' CHECK (budget_type IN ('none','hours','amount')),
  budget_value numeric(14,2),
  budget_alerts_sent smallint[] NOT NULL DEFAULT '{}',
  currency char(3),
  hourly_rate numeric(12,2),
  is_billable_default boolean NOT NULL DEFAULT true,
  progress_mode text NOT NULL DEFAULT 'auto' CHECK (progress_mode IN ('auto','manual')),
  progress_manual smallint CHECK (progress_manual BETWEEN 0 AND 100),
  client_visible boolean NOT NULL DEFAULT true,
  color varchar(9),
  archived_at timestamptz,
  created_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX projects_org_name_uq ON projects (organization_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX projects_org_status_idx ON projects (organization_id, status);
CREATE INDEX projects_name_trgm ON projects USING gin (name gin_trgm_ops);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('manager','member','viewer')),
  billable_rate numeric(12,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, member_id)
);
CREATE INDEX project_members_member_idx ON project_members (member_id);

CREATE TABLE project_teams (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, team_id)
);
CREATE INDEX project_teams_team_idx ON project_teams (team_id);

ALTER TABLE invitations ADD CONSTRAINT invitations_team_fk FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE invitation_links ADD CONSTRAINT invitation_links_team_fk FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;

CREATE TABLE project_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_member_id uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  title varchar(200),
  body text NOT NULL,
  is_pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_notes_project_idx ON project_notes (project_id);

CREATE TABLE board_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  category text NOT NULL CHECK (category IN ('todo','in_progress','in_review','done')),
  position double precision NOT NULL,
  color varchar(9),
  wip_limit int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX board_columns_project_idx ON board_columns (project_id, position);

CREATE TABLE task_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  color varchar(9),
  UNIQUE (organization_id, name)
);

CREATE TABLE labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  color varchar(9)
);
CREATE UNIQUE INDEX labels_uq ON labels (organization_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  column_id uuid REFERENCES board_columns(id) ON DELETE SET NULL,
  title varchar(300) NOT NULL,
  description text,
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  category_id uuid REFERENCES task_categories(id) ON DELETE SET NULL,
  start_date date,
  due_date date,
  estimated_hours numeric(8,2),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  position double precision NOT NULL DEFAULT 0,
  reviewer_member_id uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  completed_at timestamptz,
  approval_status text NOT NULL DEFAULT 'none' CHECK (approval_status IN ('none','pending','approved','changes_requested')),
  approved_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  approved_at timestamptz,
  due_reminder_sent_at timestamptz,
  overdue_alert_sent_at timestamptz,
  created_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  external_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX tasks_board_idx ON tasks (project_id, column_id, position);
CREATE INDEX tasks_due_idx ON tasks (organization_id, due_date) WHERE completed_at IS NULL AND deleted_at IS NULL;
CREATE INDEX tasks_parent_idx ON tasks (parent_task_id);
CREATE INDEX tasks_title_trgm ON tasks USING gin (title gin_trgm_ops);

CREATE TABLE task_assignees (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, member_id)
);
CREATE INDEX task_assignees_member_idx ON task_assignees (member_id);

CREATE TABLE task_labels (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

CREATE TABLE task_dependencies (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'blocks' CHECK (type IN ('blocks')),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('project','task','timesheet','invoice')),
  entity_id uuid NOT NULL,
  author_member_id uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  body text NOT NULL,
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','client')),
  mentions uuid[] NOT NULL DEFAULT '{}',
  edited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX comments_entity_idx ON comments (entity_type, entity_id, created_at);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('project','task','comment')),
  entity_id uuid NOT NULL,
  file_key text NOT NULL,
  file_name varchar(255) NOT NULL,
  mime varchar(120),
  size_bytes bigint NOT NULL DEFAULT 0,
  uploaded_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX attachments_entity_idx ON attachments (entity_type, entity_id);

CREATE TABLE activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type varchar(40) NOT NULL,
  entity_id uuid,
  actor_member_id uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  action varchar(60) NOT NULL,
  changes jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_log_org_idx ON activity_log (organization_id, created_at DESC);
CREATE INDEX activity_log_entity_idx ON activity_log (entity_type, entity_id, created_at DESC);

-- ───────────────────────── E.6 Schedules (rest) ─────────────────────────
CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  crosses_midnight boolean NOT NULL DEFAULT false,
  break_minutes int NOT NULL DEFAULT 0,
  color varchar(9),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE shift_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date,
  weekdays smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shift_assignments_member_idx ON shift_assignments (member_id, start_date);

CREATE TABLE holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  date date NOT NULL,
  recurring_yearly boolean NOT NULL DEFAULT false,
  applies_to text NOT NULL DEFAULT 'org' CHECK (applies_to IN ('org','team','department')),
  scope_id uuid,
  is_paid boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX holidays_org_date_idx ON holidays (organization_id, date);

-- ───────────────────────── E.7 Timesheets (before time entries FK) ─────────────────────────
CREATE TABLE timesheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  period_type text NOT NULL CHECK (period_type IN ('day','week','biweek','month')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  current_level smallint NOT NULL DEFAULT 1,
  revision int NOT NULL DEFAULT 1,
  total_seconds int NOT NULL DEFAULT 0,
  billable_seconds int NOT NULL DEFAULT 0,
  overtime_seconds int NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  approved_at timestamptz,
  locked_at timestamptz,
  locked_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  reminder_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, period_type, period_start),
  CHECK (period_end >= period_start)
);
CREATE INDEX timesheets_org_status_idx ON timesheets (organization_id, status);

CREATE TABLE timesheet_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timesheet_id uuid NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  level smallint NOT NULL,
  revision int NOT NULL,
  approver_member_id uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  comment text,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timesheet_approvals_ts_idx ON timesheet_approvals (timesheet_id);

CREATE TABLE timesheet_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  timesheet_id uuid NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  actor_member_id uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  from_status text,
  to_status text NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timesheet_events_ts_idx ON timesheet_events (timesheet_id, created_at);

-- ───────────────────────── E.9 Invoices (before time entries FK) ─────────────────────────
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  number varchar(30) NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partially_paid','paid','overdue','void')),
  issue_date date NOT NULL DEFAULT current_date,
  due_date date,
  currency char(3) NOT NULL,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  tax_percent numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid numeric(14,2) NOT NULL DEFAULT 0,
  notes text,
  period_from date,
  period_to date,
  sent_at timestamptz,
  created_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (organization_id, number)
);
CREATE INDEX invoices_client_idx ON invoices (client_id, status);

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  member_id uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  description text NOT NULL,
  hours numeric(10,2) NOT NULL DEFAULT 0,
  rate numeric(12,2) NOT NULL DEFAULT 0,
  amount numeric(14,2) NOT NULL DEFAULT 0,
  position int NOT NULL DEFAULT 0
);
CREATE INDEX invoice_items_invoice_idx ON invoice_items (invoice_id);

CREATE TABLE invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_at date NOT NULL,
  method varchar(40),
  reference varchar(120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_payments_invoice_idx ON invoice_payments (invoice_id);

-- ───────────────────────── E.5 Time, activity, monitoring ─────────────────────────
CREATE TABLE time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  client_uuid uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_seconds int NOT NULL DEFAULT 0,
  paused_seconds int NOT NULL DEFAULT 0,
  idle_seconds int NOT NULL DEFAULT 0,
  idle_discarded_seconds int NOT NULL DEFAULT 0,
  active_seconds int NOT NULL DEFAULT 0,
  entry_type text NOT NULL DEFAULT 'work' CHECK (entry_type IN ('work','meeting')),
  source text NOT NULL DEFAULT 'web_timer' CHECK (source IN ('web_timer','desktop','manual','import','integration')),
  is_offline boolean NOT NULL DEFAULT false,
  is_billable boolean NOT NULL DEFAULT true,
  note text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','paused','pending','approved','rejected','completed')),
  approval_reason text,
  approved_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  approved_at timestamptz,
  timesheet_id uuid REFERENCES timesheets(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  edit_reason text,
  created_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  EXCLUDE USING gist (member_id WITH =, tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz), '[)') WITH &&) WHERE (deleted_at IS NULL)
);
CREATE UNIQUE INDEX time_entries_one_running_uq ON time_entries (member_id) WHERE ended_at IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX time_entries_client_uuid_uq ON time_entries (device_id, client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX time_entries_org_started_idx ON time_entries (organization_id, started_at);
CREATE INDEX time_entries_member_started_idx ON time_entries (member_id, started_at);
CREATE INDEX time_entries_project_idx ON time_entries (project_id, started_at);
CREATE INDEX time_entries_task_idx ON time_entries (task_id);
CREATE INDEX time_entries_status_idx ON time_entries (organization_id, status) WHERE deleted_at IS NULL;

CREATE TABLE time_entry_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time_entry_id uuid NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  reason text NOT NULL DEFAULT 'manual' CHECK (reason IN ('manual','idle','break'))
);
CREATE INDEX time_entry_pauses_entry_idx ON time_entry_pauses (time_entry_id);
CREATE UNIQUE INDEX time_entry_pauses_open_uq ON time_entry_pauses (time_entry_id) WHERE ended_at IS NULL;

CREATE TABLE time_entry_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  time_entry_id uuid NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  changed_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('create','update','delete','approve','reject','start','pause','resume','stop')),
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_entry_history_entry_idx ON time_entry_history (time_entry_id, created_at);

CREATE TABLE idle_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  time_entry_id uuid REFERENCES time_entries(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  client_uuid uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  duration_seconds int GENERATED ALWAYS AS (greatest(0, extract(epoch FROM (ended_at - started_at))::int)) STORED,
  resolution text NOT NULL DEFAULT 'pending' CHECK (resolution IN ('pending','kept','discarded','reassigned')),
  resolved_at timestamptz,
  reassigned_entry_id uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  note text,
  alert_sent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at >= started_at)
);
CREATE UNIQUE INDEX idle_periods_client_uuid_uq ON idle_periods (device_id, client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX idle_periods_member_idx ON idle_periods (member_id, started_at);

CREATE TABLE idle_adjustment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idle_period_id uuid NOT NULL REFERENCES idle_periods(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  requested_action text NOT NULL CHECK (requested_action IN ('keep','discard')),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idle_adjustments_org_status_idx ON idle_adjustment_requests (organization_id, status);

CREATE TABLE break_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  is_paid boolean NOT NULL DEFAULT false,
  max_minutes int,
  color varchar(9),
  is_system boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  break_type_id uuid NOT NULL REFERENCES break_types(id),
  time_entry_id uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  client_uuid uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_seconds int NOT NULL DEFAULT 0,
  is_paid boolean NOT NULL DEFAULT false,
  exceeded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX breaks_one_open_uq ON breaks (member_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX breaks_client_uuid_uq ON breaks (device_id, client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX breaks_member_idx ON breaks (member_id, started_at);

CREATE TABLE activity_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  time_entry_id uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  client_uuid uuid,
  interval_start timestamptz NOT NULL,
  interval_seconds smallint NOT NULL CHECK (interval_seconds BETWEEN 1 AND 3600),
  keyboard_active_seconds smallint NOT NULL DEFAULT 0,
  mouse_active_seconds smallint NOT NULL DEFAULT 0,
  active_seconds smallint NOT NULL DEFAULT 0,
  activity_percent smallint NOT NULL DEFAULT 0 CHECK (activity_percent BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (active_seconds <= interval_seconds)
  -- PRIVACY: no columns for key content, key codes, or pointer coordinates (PDF §7).
);
CREATE UNIQUE INDEX activity_samples_dedupe_uq ON activity_samples (member_id, interval_start, coalesce(device_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX activity_samples_member_idx ON activity_samples (member_id, interval_start);
CREATE INDEX activity_samples_org_idx ON activity_samples (organization_id, interval_start);

CREATE TABLE screenshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  time_entry_id uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  client_uuid uuid,
  capture_group_id uuid,
  monitor_index smallint NOT NULL DEFAULT 0,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  object_key text NOT NULL,
  thumb_key text,
  blurred_key text,
  is_blurred boolean NOT NULL DEFAULT false,
  width int,
  height int,
  size_bytes bigint NOT NULL DEFAULT 0,
  activity_percent smallint CHECK (activity_percent BETWEEN 0 AND 100),
  app_name varchar(200),
  window_title varchar(500),
  deleted_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX screenshots_client_uuid_uq ON screenshots (device_id, client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX screenshots_member_idx ON screenshots (member_id, captured_at DESC);
CREATE INDEX screenshots_org_idx ON screenshots (organization_id, captured_at DESC);

CREATE TABLE applications (
  id serial PRIMARY KEY,
  identifier varchar(200) NOT NULL UNIQUE,
  display_name varchar(200) NOT NULL,
  icon_key text,
  kind text NOT NULL DEFAULT 'app' CHECK (kind IN ('app','website')),
  default_category text NOT NULL DEFAULT 'neutral' CHECK (default_category IN ('productive','unproductive','neutral'))
);

CREATE TABLE app_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  time_entry_id uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  client_uuid uuid,
  app_identifier varchar(200) NOT NULL,
  app_name varchar(200) NOT NULL,
  window_title varchar(500),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  duration_seconds int NOT NULL,
  CHECK (ended_at >= started_at)
);
CREATE UNIQUE INDEX app_usage_client_uuid_uq ON app_usage (device_id, client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX app_usage_member_idx ON app_usage (member_id, started_at);
CREATE INDEX app_usage_org_idx ON app_usage (organization_id, started_at);

CREATE TABLE web_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  time_entry_id uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  client_uuid uuid,
  browser text NOT NULL DEFAULT 'other' CHECK (browser IN ('chrome','firefox','edge','safari','other')),
  domain varchar(255) NOT NULL,
  url text,
  title varchar(500),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  duration_seconds int NOT NULL,
  is_excluded boolean NOT NULL DEFAULT false,
  CHECK (ended_at >= started_at)
);
CREATE UNIQUE INDEX web_usage_client_uuid_uq ON web_usage (device_id, client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX web_usage_member_idx ON web_usage (member_id, started_at);
CREATE INDEX web_usage_org_domain_idx ON web_usage (organization_id, domain);

CREATE TABLE productivity_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type text NOT NULL DEFAULT 'org' CHECK (scope_type IN ('org','team','member')),
  scope_id uuid,
  target_type text NOT NULL CHECK (target_type IN ('app','website')),
  pattern varchar(255) NOT NULL,
  match_type text NOT NULL DEFAULT 'exact' CHECK (match_type IN ('exact','domain','wildcard')),
  category text NOT NULL CHECK (category IN ('productive','unproductive','neutral')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX productivity_rules_uq ON productivity_rules (organization_id, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), target_type, lower(pattern));

CREATE TABLE sensitive_exclusions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain_pattern varchar(255) NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, domain_pattern)
);

CREATE TABLE tracking_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('org','team','project','member')),
  scope_id uuid,
  screenshots_enabled boolean,
  screenshot_interval_minutes smallint CHECK (screenshot_interval_minutes IN (3,5,10,15)),
  screenshot_random boolean,
  screenshot_blur boolean,
  screenshot_retention_days int CHECK (screenshot_retention_days > 0),
  allow_employee_screenshot_delete boolean,
  capture_window_titles boolean,
  notify_on_capture boolean,
  activity_tracking_enabled boolean,
  app_tracking_enabled boolean,
  website_tracking_enabled boolean,
  track_full_url boolean,
  idle_threshold_minutes smallint CHECK (idle_threshold_minutes BETWEEN 1 AND 120),
  auto_pause_minutes smallint CHECK (auto_pause_minutes BETWEEN 1 AND 240),
  weekly_limit_hours numeric(5,2),
  limit_mode text CHECK (limit_mode IN ('warn','block')),
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'org') = (scope_id IS NULL))
);
CREATE UNIQUE INDEX tracking_settings_scope_uq ON tracking_settings (organization_id, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE daily_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  date date NOT NULL,
  tracked_seconds int NOT NULL DEFAULT 0,
  active_seconds int NOT NULL DEFAULT 0,
  idle_seconds int NOT NULL DEFAULT 0,
  break_seconds int NOT NULL DEFAULT 0,
  paid_break_seconds int NOT NULL DEFAULT 0,
  meeting_seconds int NOT NULL DEFAULT 0,
  productive_seconds int NOT NULL DEFAULT 0,
  unproductive_seconds int NOT NULL DEFAULT 0,
  neutral_seconds int NOT NULL DEFAULT 0,
  billable_seconds int NOT NULL DEFAULT 0,
  overtime_seconds int NOT NULL DEFAULT 0,
  activity_percent smallint NOT NULL DEFAULT 0,
  screenshot_count int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, date)
);
CREATE INDEX daily_summaries_org_date_idx ON daily_summaries (organization_id, date);

-- ───────────────────────── E.6 Attendance ─────────────────────────
CREATE TABLE attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  date date NOT NULL,
  status text NOT NULL DEFAULT 'present' CHECK (status IN ('present','late','absent','half_day','holiday','weekend','leave')),
  check_in_at timestamptz,
  check_out_at timestamptz,
  check_in_source text CHECK (check_in_source IN ('manual','timer','agent','correction','system')),
  late_minutes int NOT NULL DEFAULT 0,
  early_leave_minutes int NOT NULL DEFAULT 0,
  worked_seconds int NOT NULL DEFAULT 0,
  overtime_seconds int NOT NULL DEFAULT 0,
  work_mode text CHECK (work_mode IN ('office','remote','hybrid')),
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, date)
);
CREATE INDEX attendance_org_date_idx ON attendance_records (organization_id, date, status);

CREATE TABLE attendance_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  attendance_record_id uuid REFERENCES attendance_records(id) ON DELETE SET NULL,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  date date NOT NULL,
  requested_check_in timestamptz,
  requested_check_out timestamptz,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attendance_corrections_org_status_idx ON attendance_corrections (organization_id, status);

-- ───────────────────────── E.8 Reports & performance ─────────────────────────
CREATE TABLE saved_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(150) NOT NULL,
  report_type varchar(40) NOT NULL,
  definition jsonb NOT NULL,
  owner_member_id uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  is_shared_in_org boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_reports_org_idx ON saved_reports (organization_id);

CREATE TABLE report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  saved_report_id uuid NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  frequency text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  day_of_week smallint CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 28),
  time_of_day time NOT NULL DEFAULT '08:00',
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  format text NOT NULL DEFAULT 'pdf' CHECK (format IN ('pdf','csv','xlsx')),
  recipients text[] NOT NULL,
  last_run_at timestamptz,
  next_run_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_schedules_next_idx ON report_schedules (next_run_at) WHERE active;

CREATE TABLE report_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  saved_report_id uuid REFERENCES saved_reports(id) ON DELETE CASCADE,
  definition_snapshot jsonb NOT NULL,
  name varchar(150),
  token_hash text NOT NULL UNIQUE,
  password_hash text,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  expires_at timestamptz,
  revoked_at timestamptz,
  view_count int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type varchar(40) NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  file_key text,
  file_name varchar(255),
  error text,
  requested_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX export_jobs_requested_idx ON export_jobs (requested_by, created_at DESC);

CREATE TABLE performance_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(150) NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('member','team')),
  scope_id uuid NOT NULL,
  metric varchar(50) NOT NULL,
  target numeric(12,2) NOT NULL,
  comparator text NOT NULL DEFAULT 'gte' CHECK (comparator IN ('gte','lte')),
  period text NOT NULL DEFAULT 'week' CHECK (period IN ('day','week','month')),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX performance_goals_scope_idx ON performance_goals (scope_type, scope_id);

CREATE TABLE custom_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  formula jsonb NOT NULL,
  unit varchar(20),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE performance_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  period_type text NOT NULL CHECK (period_type IN ('week','month')),
  period_start date NOT NULL,
  metrics jsonb NOT NULL,
  productivity_score numeric(5,2),
  rank int,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, period_type, period_start)
);

-- ───────────────────────── E.9 Billing & payroll ─────────────────────────
CREATE TABLE exchange_rates (
  base char(3) NOT NULL,
  quote char(3) NOT NULL,
  rate numeric(18,8) NOT NULL,
  date date NOT NULL,
  PRIMARY KEY (base, quote, date)
);

CREATE TABLE payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','paid','exported')),
  currency char(3) NOT NULL,
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  finalized_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  finalized_at timestamptz,
  paid_at timestamptz,
  created_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, period_start, period_end)
);

CREATE TABLE payroll_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  pay_type text NOT NULL DEFAULT 'hourly',
  regular_seconds int NOT NULL DEFAULT 0,
  overtime_seconds int NOT NULL DEFAULT 0,
  paid_break_seconds int NOT NULL DEFAULT 0,
  rate numeric(12,2) NOT NULL DEFAULT 0,
  overtime_rate numeric(12,2) NOT NULL DEFAULT 0,
  regular_amount numeric(14,2) NOT NULL DEFAULT 0,
  overtime_amount numeric(14,2) NOT NULL DEFAULT 0,
  adjustments numeric(14,2) NOT NULL DEFAULT 0,
  adjustment_note text,
  total numeric(14,2) NOT NULL DEFAULT 0,
  currency char(3) NOT NULL,
  UNIQUE (payroll_run_id, member_id)
);

-- ───────────────────────── E.10 Notifications, integrations, security, subscription ─────────────────────────
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type varchar(60) NOT NULL,
  title varchar(200) NOT NULL,
  body text,
  data jsonb,
  link text,
  read_at timestamptz,
  channels_sent text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_user_id, read_at, created_at DESC);

CREATE TABLE notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  event_type varchar(60) NOT NULL,
  in_app boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT true,
  desktop boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX notification_preferences_uq ON notification_preferences (
  coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
  event_type
);

CREATE TABLE system_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type varchar(60) NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  message text NOT NULL,
  data jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_alerts_org_idx ON system_alerts (organization_id, resolved_at);
CREATE UNIQUE INDEX system_alerts_open_uq ON system_alerts (organization_id, type) WHERE resolved_at IS NULL;

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  prefix varchar(16) NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url text NOT NULL,
  events text[] NOT NULL,
  secret_enc text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  description text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','zapier','n8n','rest_hook')),
  failure_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_org_idx ON webhooks (organization_id);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event varchar(60) NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  attempts int NOT NULL DEFAULT 0,
  response_code int,
  response_body text,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_status_idx ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX webhook_deliveries_webhook_idx ON webhook_deliveries (webhook_id, created_at DESC);

CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('slack','ms_teams','jira','trello','asana','clickup','github','gitlab','google_calendar','outlook_calendar','quickbooks','xero','payroll_csv')),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('pending','connected','error','disconnected')),
  access_token_enc text,
  refresh_token_enc text,
  expires_at timestamptz,
  settings jsonb NOT NULL DEFAULT '{}',
  connected_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)
);

CREATE TABLE integration_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  external_type varchar(40) NOT NULL,
  external_id varchar(255) NOT NULL,
  internal_type varchar(40) NOT NULL,
  internal_id uuid NOT NULL,
  UNIQUE (integration_id, external_type, external_id)
);

CREATE TABLE sync_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  batch_uuid uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  item_counts jsonb,
  results jsonb,
  checksum varchar(128),
  UNIQUE (device_id, batch_uuid)
);

CREATE TABLE sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  entity_type varchar(40) NOT NULL,
  payload jsonb NOT NULL,
  conflicting_entity_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution varchar(40),
  resolved_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_conflicts_org_status_idx ON sync_conflicts (organization_id, status);

CREATE TABLE app_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  os text NOT NULL CHECK (os IN ('windows','macos','linux')),
  channel text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable','beta')),
  version varchar(30) NOT NULL,
  url text NOT NULL,
  sha256 varchar(64),
  min_supported boolean NOT NULL DEFAULT false,
  release_notes text,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (os, channel, version)
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','api_key','system','super_admin','agent')),
  action varchar(80) NOT NULL,
  entity_type varchar(40),
  entity_id uuid,
  before jsonb,
  after jsonb,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_idx ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

CREATE TABLE security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  type varchar(60) NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  data jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_created_idx ON security_events (created_at DESC);

CREATE TABLE data_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('export','deletion')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','processing','completed','rejected')),
  reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  processed_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  processed_at timestamptz,
  file_key text,
  notes text
);
CREATE INDEX data_requests_org_status_idx ON data_requests (organization_id, status);

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'members' CHECK (type IN ('members')),
  status text NOT NULL DEFAULT 'validated' CHECK (status IN ('validated','committed','failed')),
  rows jsonb NOT NULL DEFAULT '[]',
  rows_total int NOT NULL DEFAULT 0,
  rows_valid int NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]',
  result jsonb,
  created_by uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code IN ('free','starter','professional','enterprise')),
  name varchar(60) NOT NULL,
  price_month numeric(10,2) NOT NULL DEFAULT 0,
  price_year numeric(10,2) NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  per_seat boolean NOT NULL DEFAULT true,
  stripe_price_month_id varchar(100),
  stripe_price_year_id varchar(100),
  limits jsonb NOT NULL,
  features jsonb NOT NULL,
  is_public boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id),
  status text NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','canceled','expired')),
  billing_interval text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month','year')),
  seats int NOT NULL DEFAULT 1,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  stripe_customer_id varchar(100),
  stripe_subscription_id varchar(100),
  pending_plan_id uuid REFERENCES plans(id),
  pending_interval text CHECK (pending_interval IN ('month','year')),
  expiry_notice_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_invoice_id varchar(100) UNIQUE,
  number varchar(60),
  amount numeric(12,2) NOT NULL,
  currency char(3) NOT NULL,
  status varchar(30) NOT NULL,
  hosted_url text,
  pdf_url text,
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_payment_intent_id varchar(100) UNIQUE,
  amount numeric(12,2) NOT NULL,
  currency char(3) NOT NULL,
  status varchar(30) NOT NULL,
  paid_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_counters (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('storage_bytes','screenshots')),
  value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, metric)
);

CREATE TABLE processed_webhook_events (
  provider varchar(30) NOT NULL,
  event_id varchar(120) NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- ───────────────────────── Background job queue (replaces BullMQ) ─────────────────────────
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(80) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  last_error text,
  locked_at timestamptz,
  dedupe_key varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';
CREATE UNIQUE INDEX jobs_dedupe_uq ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');

CREATE TABLE cron_runs (
  name varchar(80) PRIMARY KEY,
  last_run_at timestamptz NOT NULL
);

-- Files stored by the local storage driver (used for signed URLs & storage accounting)
CREATE TABLE files (
  key text PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  purpose varchar(40) NOT NULL,
  content_type varchar(120),
  size_bytes bigint NOT NULL DEFAULT 0,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_org_idx ON files (organization_id);
