import WebSocket from 'ws';
import type { StreamId } from '../../../shared/types';
import type { AdapterContext } from '../types';
import { backoff } from '../types';

interface Opts {
  url: string | (() => string);
  stream: StreamId;
  name: string;
  ctx: AdapterContext;
  /** Called on every (re)connect — send subscriptions here */
  onOpen: (ws: WebSocket) => void;
  onMessage: (data: string, ws: WebSocket) => void;
  /** Reconnect if nothing is received for this long */
  idleTimeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * Upstream WebSocket with exponential backoff + full jitter, idle watchdog,
 * automatic resubscribe on reconnect, and status reporting into the hub.
 */
export class ReconnectingWS {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private o: Opts) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private connect() {
    if (this.stopped) return;
    const url = typeof this.o.url === 'function' ? this.o.url() : this.o.url;
    this.o.ctx.hub.setState(this.o.stream, 'connecting', this.attempt ? `reconnecting (attempt ${this.attempt})` : undefined);
    const ws = new WebSocket(url, { headers: { 'User-Agent': 'PulseTerminal/0.1', ...this.o.headers } });
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.o.ctx.log.info(`[${this.o.name}] connected`);
      try {
        this.o.onOpen(ws);
      } catch (e) {
        this.o.ctx.log.error(`[${this.o.name}] subscribe failed`, e);
      }
      this.bumpIdle();
    });
    ws.on('message', (buf) => {
      this.bumpIdle();
      try {
        this.o.onMessage(buf.toString(), ws);
      } catch (e) {
        this.o.ctx.log.warn(`[${this.o.name}] bad message`, e);
      }
    });
    ws.on('error', (e) => this.o.ctx.log.warn(`[${this.o.name}] ws error: ${(e as Error).message}`));
    ws.on('close', (code) => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.stopped) return;
      const delay = backoff(this.attempt++);
      this.o.ctx.hub.setState(this.o.stream, 'down', `disconnected (${code}); retry in ${Math.round(delay / 1000)}s`);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.o.idleTimeoutMs ?? 60_000;
    this.idleTimer = setTimeout(() => {
      this.o.ctx.log.warn(`[${this.o.name}] idle for ${ms / 1000}s, reconnecting`);
      this.ws?.terminate();
    }, ms);
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.ws?.removeAllListeners();
    this.ws?.on('error', () => {});
    this.ws?.close();
    this.ws = null;
  }
}
