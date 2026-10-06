import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { sqlite } from './db/client';
import { DOC_TABLES } from './db/migrate';

export type Collection = (typeof DOC_TABLES)[number];
export const isCollection = (c: string): c is Collection => (DOC_TABLES as readonly string[]).includes(c);

/** Collections the browser may read/write through the generic REST API (integrations hold secrets). */
export const PUBLIC_COLLECTIONS: Collection[] = DOC_TABLES.filter((c) => c !== 'integrations');

const MAX_DOC_BYTES = 256 * 1024;

type Doc = { id: string } & Record<string, unknown>;

/**
 * Generic JSON document collections (one SQLite table each). Every write emits 'change' so the
 * fan-out can sync other tabs/devices, and feature modules can react (e.g. levels → alerts).
 */
class DocStore extends EventEmitter {
  private cache = new Map<Collection, Map<string, Doc>>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  private load(c: Collection): Map<string, Doc> {
    let m = this.cache.get(c);
    if (m) return m;
    m = new Map();
    for (const row of sqlite.prepare(`SELECT id, data FROM ${c} ORDER BY created_at`).all() as { id: string; data: string }[]) {
      try {
        m.set(row.id, { ...JSON.parse(row.data), id: row.id });
      } catch {
        /* skip corrupt rows rather than failing the whole collection */
      }
    }
    this.cache.set(c, m);
    return m;
  }

  list<T = Doc>(c: Collection): T[] {
    return [...this.load(c).values()] as T[];
  }

  get<T = Doc>(c: Collection, id: string): T | null {
    return (this.load(c).get(id) as T) ?? null;
  }

  put<T extends object>(c: Collection, input: T & { id?: string }, opts: { silent?: boolean } = {}): T & { id: string } {
    const id = typeof input.id === 'string' && /^[\w:.-]{1,80}$/.test(input.id) ? input.id : randomUUID();
    const doc = { ...input, id } as unknown as Doc;
    const json = JSON.stringify(doc);
    if (json.length > MAX_DOC_BYTES) throw new Error('document too large');
    const now = Date.now();
    sqlite.prepare(`INSERT INTO ${c} (id, data, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(id, json, now, now);
    this.load(c).set(id, doc);
    if (!opts.silent) this.emit('change', c, 'put', doc);
    return doc as unknown as T & { id: string };
  }

  remove(c: Collection, id: string) {
    sqlite.prepare(`DELETE FROM ${c} WHERE id = ?`).run(id);
    this.load(c).delete(id);
    this.emit('change', c, 'del', { id });
  }

  /** Replace a whole collection (settings import). */
  replaceAll(c: Collection, docs: Doc[]) {
    sqlite.transaction(() => {
      sqlite.prepare(`DELETE FROM ${c}`).run();
      this.cache.delete(c);
      for (const d of docs) this.put(c, d, { silent: true });
    })();
    this.emit('reset', c);
  }
}

export const docs = new DocStore();
