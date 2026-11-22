/**
 * Connect-form metadata per provider (served to the front end with the integration catalog so
 * the UI renders forms from the backend instead of hard-coding them).
 * Field: { key, label, type: 'text'|'secret'|'list'|'bool'|'select'|'number'|'events', required?, placeholder?, options?: [[value,label]], default? }
 */
export const CATEGORY_LABELS = {
  communication: 'Communication',
  project_management: 'Project management',
  development: 'Development',
  calendar: 'Calendar',
  accounting: 'Accounting',
  payroll: 'Payroll',
};

export const BRAND_COLORS = {
  slack: '#4a154b',
  ms_teams: '#4b53bc',
  jira: '#0052cc',
  trello: '#0079bf',
  asana: '#f06a6a',
  clickup: '#7b68ee',
  github: '#24292f',
  gitlab: '#fc6d26',
  google_calendar: '#1a73e8',
  outlook_calendar: '#0078d4',
  quickbooks: '#2ca01c',
  xero: '#13b5ea',
  payroll_csv: '#6b7280',
};

const webhookChat = (placeholder) => [
  { key: 'webhookUrl', label: 'Incoming webhook URL', type: 'secret', required: true, placeholder },
  { key: 'channel', label: 'Channel (display only)', type: 'text', placeholder: '#time-tracking' },
  { key: 'events', label: 'Events to post', type: 'events', default: ['timer.started', 'timer.stopped', 'timesheet.submitted', 'timesheet.approved'] },
];
const calendar = (oauthLabel) => [
  { key: 'mode', label: 'Mode', type: 'select', options: [['ics_feed', 'iCalendar feed (no sign-in)'], ['oauth', oauthLabel]] },
  { key: 'calendarId', label: 'Calendar ID (OAuth only)', type: 'text' },
];
const accounting = [
  { key: 'mode', label: 'Mode', type: 'select', options: [['csv', 'CSV export'], ['oauth', 'Direct sync (OAuth)']] },
  { key: 'incomeAccount', label: 'Income account', type: 'text' },
  { key: 'taxType', label: 'Tax type', type: 'text' },
];

export const PROVIDER_FIELDS = {
  slack: webhookChat('https://hooks.slack.com/services/…'),
  ms_teams: webhookChat('https://outlook.office.com/webhook/…'),
  jira: [
    { key: 'siteUrl', label: 'Site URL', type: 'text', required: true, placeholder: 'https://your-site.atlassian.net' },
    { key: 'email', label: 'Account email', type: 'text', required: true },
    { key: 'apiToken', label: 'API token', type: 'secret', required: true },
    { key: 'projectKeys', label: 'Project keys to import', type: 'list', placeholder: 'ACP, AMA' },
    { key: 'pushWorklogs', label: 'Push worklogs to Jira', type: 'bool' },
  ],
  trello: [
    { key: 'apiKey', label: 'API key', type: 'secret', required: true },
    { key: 'token', label: 'Token', type: 'secret', required: true },
    { key: 'boardIds', label: 'Board IDs', type: 'list' },
  ],
  asana: [
    { key: 'accessToken', label: 'Personal access token', type: 'secret', required: true },
    { key: 'workspaceId', label: 'Workspace ID', type: 'text' },
    { key: 'projectIds', label: 'Project IDs', type: 'list' },
  ],
  clickup: [
    { key: 'apiToken', label: 'API token', type: 'secret', required: true },
    { key: 'listIds', label: 'List IDs', type: 'list' },
  ],
  github: [
    { key: 'accessToken', label: 'Personal access token', type: 'secret', required: true },
    { key: 'repos', label: 'Repositories (owner/repo)', type: 'list', placeholder: 'acme/web, acme/api' },
  ],
  gitlab: [
    { key: 'accessToken', label: 'Personal access token', type: 'secret', required: true },
    { key: 'baseUrl', label: 'GitLab URL', type: 'text', placeholder: 'https://gitlab.com' },
    { key: 'projectIds', label: 'Project IDs', type: 'list' },
  ],
  google_calendar: calendar('Google sign-in'),
  outlook_calendar: calendar('Microsoft sign-in'),
  quickbooks: accounting,
  xero: accounting,
  payroll_csv: [
    { key: 'delimiter', label: 'Delimiter', type: 'select', options: [[',', 'Comma (,)'], [';', 'Semicolon (;)'], ['\t', 'Tab']] },
    { key: 'hoursDecimals', label: 'Hour decimals', type: 'number' },
  ],
};
