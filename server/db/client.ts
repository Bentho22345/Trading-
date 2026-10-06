import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config';
import * as schema from './schema';
import { migrate } from './migrate';

mkdirSync(dirname(config.dbPath), { recursive: true });
const sqlite = new Database(config.dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');

// Schema bootstrap. The tables are tiny and additive, so an idempotent DDL block keeps
// "npm run dev" zero-setup; switch to drizzle-kit migrations if the schema starts evolving.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, headline TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL, source_id TEXT NOT NULL, url TEXT NOT NULL, published_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL, domains TEXT NOT NULL, tickers TEXT NOT NULL, currencies TEXT NOT NULL,
  tags TEXT NOT NULL, sentiment REAL NOT NULL DEFAULT 0, impact INTEGER NOT NULL DEFAULT 0, demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS articles_cluster_idx ON articles(cluster_id);
CREATE INDEX IF NOT EXISTS articles_received_idx ON articles(received_at);
CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, first_seen INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  impact INTEGER NOT NULL, breaking INTEGER NOT NULL DEFAULT 0, tldr TEXT, why TEXT, ai_model TEXT
);
CREATE TABLE IF NOT EXISTS read_state (cluster_id TEXT PRIMARY KEY, read_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS saved (cluster_id TEXT PRIMARY KEY, saved_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS watchlist (id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, rule TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS alert_events (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, message TEXT NOT NULL, ts INTEGER NOT NULL);
`);

migrate(sqlite);

export const db = drizzle(sqlite, { schema });
export { schema, sqlite };
