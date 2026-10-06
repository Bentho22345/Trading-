import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config';

export class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  body: <T = Record<string, unknown>>() => Promise<T>;
  raw: () => Promise<Buffer>;
}

export type Handler = (c: Ctx) => unknown | Promise<unknown>;

/** A response the router should send verbatim (text, HTML, CSV, ICS…) instead of JSON. */
export class Raw {
  constructor(public body: string | Buffer, public type: string, public headers: Record<string, string> = {}) {}
}

const MAX_BODY = 2 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'payload too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Tiny method + regex router for the PULSE 2.0 API. Unmatched paths fall through to the v1 API. */
export class Router {
  private routes: { method: string; re: RegExp; h: Handler }[] = [];

  add(method: string, path: string | RegExp, h: Handler) {
    const re = typeof path === 'string' ? new RegExp(`^${path.replace(/:(\w+)/g, '([^/]+)')}$`) : path;
    this.routes.push({ method, re, h });
    return this;
  }
  get(p: string | RegExp, h: Handler) { return this.add('GET', p, h); }
  post(p: string | RegExp, h: Handler) { return this.add('POST', p, h); }
  put(p: string | RegExp, h: Handler) { return this.add('PUT', p, h); }
  del(p: string | RegExp, h: Handler) { return this.add('DELETE', p, h); }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      let cached: Buffer | null = null;
      const raw = async () => (cached ??= await readBody(req));
      const ctx: Ctx = {
        req, res, url, params: m.slice(1).map(decodeURIComponent), raw,
        body: async <T>() => {
          const b = await raw();
          try {
            return JSON.parse(b.toString() || '{}') as T;
          } catch {
            throw new HttpError(400, 'invalid JSON');
          }
        },
      };
      try {
        const out = await r.h(ctx);
        if (res.headersSent) return true;
        if (out instanceof Raw) {
          res.writeHead(200, { 'Content-Type': out.type, 'Cache-Control': 'no-store', ...out.headers });
          res.end(out.body);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': config.corsOrigin.split(',')[0] });
          res.end(JSON.stringify(out ?? { ok: true }));
        }
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error('[api]', e);
        if (!res.headersSent) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: status === 500 ? 'internal error' : (e as Error).message }));
        }
      }
      return true;
    }
    return false;
  }
}

export function bad(msg: string): never {
  throw new HttpError(400, msg);
}
export function notFound(msg = 'not found'): never {
  throw new HttpError(404, msg);
}
