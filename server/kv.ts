import { sqlite } from './db/client';

const getStmt = sqlite.prepare('SELECT value FROM kv WHERE key = ?');
const setStmt = sqlite.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');

/** Small JSON key-value store for worker state that must survive restarts. */
export function kvGet<T>(key: string, fallback: T): T {
  const row = getStmt.get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function kvSet(key: string, value: unknown) {
  setStmt.run(key, JSON.stringify(value), Date.now());
}
