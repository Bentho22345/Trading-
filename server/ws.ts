import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMsg, Quote, ServerMsg, Snapshot } from '../shared/types';
import { config } from './config';

interface Client {
  ws: WebSocket;
  dirty: Map<string, Quote>;
  hidden: boolean;
  alive: boolean;
  lastFlush: number;
}

/**
 * Fan-out to browsers. Quotes are coalesced per client (latest value per symbol) and flushed
 * every 100 ms while visible, every 2 s while the tab is hidden — the client then catches up
 * instantly on focus because the coalesced map always holds the latest price.
 */
export class Fanout {
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private timers: NodeJS.Timeout[] = [];

  constructor(server: Server, private snapshot: () => Snapshot) {
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
    this.wss.on('connection', (ws, req) => {
      const origin = req.headers.origin;
      if (config.corsOrigin !== '*' && origin && !config.corsOrigin.split(',').includes(origin)) {
        ws.close(1008, 'origin not allowed');
        return;
      }
      const c: Client = { ws, dirty: new Map(), hidden: false, alive: true, lastFlush: 0 };
      this.clients.add(c);
      this.sendTo(c, { t: 'snapshot', d: this.snapshot() });
      ws.on('pong', () => (c.alive = true));
      ws.on('message', (buf) => {
        try {
          const m = JSON.parse(buf.toString()) as ClientMsg;
          if (m.t === 'ping') this.sendTo(c, { t: 'pong', id: m.id, serverTime: Date.now() });
          else if (m.t === 'vis') {
            c.hidden = !!m.hidden;
            if (!c.hidden) this.flush(c);
          }
        } catch {
          /* ignore malformed client messages */
        }
      });
      ws.on('close', () => this.clients.delete(c));
      ws.on('error', () => this.clients.delete(c));
    });
    this.timers.push(setInterval(() => {
      const now = Date.now();
      for (const c of this.clients) if (now - c.lastFlush >= (c.hidden ? 2000 : 100)) this.flush(c);
    }, 100));
    // protocol-level heartbeat: drop dead sockets so we don't leak
    this.timers.push(setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.ws.terminate();
          this.clients.delete(c);
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }, 20_000));
  }

  get size() {
    return this.clients.size;
  }

  quotes(qs: Quote[]) {
    for (const c of this.clients) for (const q of qs) c.dirty.set(q.symbol, q);
  }

  broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }

  private flush(c: Client) {
    c.lastFlush = Date.now();
    if (!c.dirty.size || c.ws.readyState !== WebSocket.OPEN) return;
    // backpressure: skip this round if the socket buffer is backed up (slow client)
    if (c.ws.bufferedAmount > 1_000_000) return;
    const d = [...c.dirty.values()];
    c.dirty.clear();
    this.sendTo(c, { t: 'q', d });
  }

  private sendTo(c: Client, msg: ServerMsg) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  close() {
    this.timers.forEach(clearInterval);
    for (const c of this.clients) c.ws.terminate();
    this.wss.close();
  }
}
