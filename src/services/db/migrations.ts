/**
 * SQLite schema migrations (§73). Each migration is forward-only and recorded
 * in schema_migrations. Foreign keys are enabled at connection time.
 */

export interface Migration { name: string; sql: string }

export const MIGRATIONS: Migration[] = [
  {
    name: '001_initial',
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  is_default INTEGER DEFAULT 0,
  read_only INTEGER DEFAULT 0,
  encrypted INTEGER DEFAULT 0,
  git_repo_path TEXT,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  favorite INTEGER DEFAULT 0,
  read_only INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collections_ws ON collections(workspace_id);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  parent_folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_collection ON folders(collection_id);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  url TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT 'http',
  favorite INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_ws ON requests(workspace_id);
CREATE INDEX IF NOT EXISTS idx_requests_collection ON requests(collection_id);
CREATE INDEX IF NOT EXISTS idx_requests_folder ON requests(folder_id);
CREATE INDEX IF NOT EXISTS idx_requests_name ON requests(name);

CREATE TABLE IF NOT EXISTS examples (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_examples_request ON examples(request_id);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT,
  status INTEGER,
  duration_ms REAL,
  size INTEGER,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_request ON responses(request_id);
CREATE INDEX IF NOT EXISTS idx_responses_created ON responses(created_at);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_environments_ws ON environments(workspace_id);

CREATE TABLE IF NOT EXISTS kv_store (
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, scope)
);

CREATE TABLE IF NOT EXISTS cookies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '/',
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name, domain, path)
);
CREATE INDEX IF NOT EXISTS idx_cookies_ws ON cookies(workspace_id);

CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT,
  name TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  duration_ms REAL,
  doc TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_ws ON history(workspace_id);
CREATE INDEX IF NOT EXISTS idx_history_ts ON history(timestamp);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_ws ON runs(workspace_id);

CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flows_ws ON flows(workspace_id);

CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  workspace_id TEXT,
  status TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS mocks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  port INTEGER NOT NULL,
  running INTEGER DEFAULT 0,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mock_logs (
  id TEXT PRIMARY KEY,
  mock_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_mock_logs_id ON mock_logs(mock_id);

CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_results (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_monitor_results ON monitor_results(monitor_id);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'csv',
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS specs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  lifecycle TEXT DEFAULT 'Draft',
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_specs_ws ON specs(workspace_id);

CREATE TABLE IF NOT EXISTS apis (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lifecycle TEXT DEFAULT 'Draft',
  version TEXT DEFAULT '1.0.0',
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS git_repos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  remote_url TEXT,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  port INTEGER NOT NULL,
  running INTEGER DEFAULT 0,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_webhook_events ON webhook_events(webhook_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  timestamp TEXT NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  severity TEXT DEFAULT 'info'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_cat ON audit_events(category);

CREATE TABLE IF NOT EXISTS script_library (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  name TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  tags TEXT DEFAULT '[]',
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  name TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_request ON snapshots(request_id);

CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  name TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, relative_path)
);

CREATE TABLE IF NOT EXISTS governance_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  doc TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS secret_patterns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pattern TEXT NOT NULL,
  severity TEXT NOT NULL,
  builtin INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  UNIQUE (workspace_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  doc TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crash_recovery (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  doc TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  UNIQUE (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS perf_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS secrets_meta (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT
);

CREATE TABLE IF NOT EXISTS doc_sites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS baselines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
`,
  },
  {
    name: '002_layouts_searches',
    sql: `
CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  options TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  query TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS layouts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  name TEXT NOT NULL,
  doc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
`,
  },
];
