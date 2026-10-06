import type Database from 'better-sqlite3';

/**
 * Versioned, additive migrations tracked with PRAGMA user_version. Each step runs once, in a
 * transaction. Never edit a released step: append a new one. Existing v1 tables are untouched.
 */
const doc = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`;

export const DOC_TABLES = [
  'brief_profiles', 'workspaces', 'layouts', 'themes', 'smart_feeds', 'playbooks', 'positions', 'journal_entries',
  'annotations', 'levels', 'themes_narrative', 'alert_routes', 'integrations', 'source_overrides', 'score_weights', 'settings_docs',
] as const;

const MIGRATIONS: string[] = [
  // 1 — PULSE 2.0 base
  `
  ${DOC_TABLES.map(doc).join('\n')}
  CREATE TABLE IF NOT EXISTS briefs (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, kind TEXT NOT NULL, date TEXT NOT NULL,
    created_at INTEGER NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS briefs_date_idx ON briefs(date, kind);
  CREATE TABLE IF NOT EXISTS playbook_outcomes (
    id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, event_id TEXT NOT NULL, scenario_id TEXT,
    fired_at INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS playbook_outcomes_pb_idx ON playbook_outcomes(playbook_id, fired_at);
  CREATE TABLE IF NOT EXISTS alert_history (
    id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, ts INTEGER NOT NULL, message TEXT NOT NULL, severity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new', acked_at INTEGER, snoozed_until INTEGER, routes TEXT NOT NULL DEFAULT '[]', data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS alert_history_ts_idx ON alert_history(ts);
  CREATE TABLE IF NOT EXISTS tick_archive (
    symbol TEXT NOT NULL, t_start INTEGER NOT NULL, res TEXT NOT NULL, data BLOB NOT NULL,
    PRIMARY KEY (symbol, t_start, res)
  );
  CREATE INDEX IF NOT EXISTS tick_archive_t_idx ON tick_archive(t_start);
  CREATE TABLE IF NOT EXISTS econ_history (
    id TEXT PRIMARY KEY, series TEXT NOT NULL, country TEXT NOT NULL, currency TEXT NOT NULL, time INTEGER NOT NULL,
    actual REAL, consensus REAL, previous REAL, unit TEXT NOT NULL DEFAULT '', lower_is_better INTEGER NOT NULL DEFAULT 0,
    reactions TEXT NOT NULL DEFAULT '{}', demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS econ_history_series_idx ON econ_history(series, time);
  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY, dest TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox(status, next_at);
  CREATE TABLE IF NOT EXISTS ai_usage (
    day TEXT NOT NULL, kind TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (day, kind)
  );
  CREATE TABLE IF NOT EXISTS ai_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS pipeline_stats (hour INTEGER PRIMARY KEY, ingested INTEGER NOT NULL DEFAULT 0, deduped INTEGER NOT NULL DEFAULT 0, clustered INTEGER NOT NULL DEFAULT 0);
  `,
];

export function migrate(sqlite: Database.Database) {
  const current = Number(sqlite.pragma('user_version', { simple: true })) || 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    sqlite.transaction(() => {
      sqlite.exec(MIGRATIONS[v]);
      sqlite.pragma(`user_version = ${v + 1}`);
    })();
    console.log(`[db] migrated to schema v${v + 1}`);
  }
}
