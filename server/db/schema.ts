import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

export const articles = sqliteTable(
  'articles',
  {
    id: text('id').primaryKey(),
    clusterId: text('cluster_id').notNull(),
    headline: text('headline').notNull(),
    summary: text('summary').notNull().default(''),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    url: text('url').notNull(),
    publishedAt: integer('published_at').notNull(),
    receivedAt: integer('received_at').notNull(),
    domains: text('domains', { mode: 'json' }).$type<string[]>().notNull(),
    tickers: text('tickers', { mode: 'json' }).$type<string[]>().notNull(),
    currencies: text('currencies', { mode: 'json' }).$type<string[]>().notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
    sentiment: real('sentiment').notNull().default(0),
    impact: integer('impact').notNull().default(0),
    demo: integer('demo', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('articles_cluster_idx').on(t.clusterId), index('articles_received_idx').on(t.receivedAt)],
);

export const clusters = sqliteTable('clusters', {
  id: text('id').primaryKey(),
  leadId: text('lead_id').notNull(),
  firstSeen: integer('first_seen').notNull(),
  updatedAt: integer('updated_at').notNull(),
  impact: integer('impact').notNull(),
  breaking: integer('breaking', { mode: 'boolean' }).notNull().default(false),
  tldr: text('tldr'),
  why: text('why'),
  aiModel: text('ai_model'),
});

export const readState = sqliteTable('read_state', {
  clusterId: text('cluster_id').primaryKey(),
  readAt: integer('read_at').notNull(),
});

export const saved = sqliteTable('saved', {
  clusterId: text('cluster_id').primaryKey(),
  savedAt: integer('saved_at').notNull(),
});

export const watchlist = sqliteTable('watchlist', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const alerts = sqliteTable('alerts', {
  id: text('id').primaryKey(),
  rule: text('rule', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
});

export const alertEvents = sqliteTable('alert_events', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').notNull(),
  message: text('message').notNull(),
  ts: integer('ts').notNull(),
});
