'use client';
import type { Quote, ServerMsg } from '@shared/types';
import { useStore } from './store';
import { useSettings } from './settings';
import { playChime } from './sound';

/**
 * Browser ⇄ worker WebSocket.
 *  - exponential backoff with full jitter, capped at 20 s; resync via snapshot on reconnect
 *  - quote messages are coalesced and applied once per animation frame (no re-render storms)
 *  - when the tab is hidden the server throttles to 2 s batches; we keep coalescing so the
 *    UI catches up in one frame on focus
 */
export function wsUrl() {
  const env = process.env.NEXT_PUBLIC_WS_URL;
  if (env) return env;
  const { protocol, hostname } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${hostname}:${process.env.NEXT_PUBLIC_WORKER_PORT ?? '4000'}/ws`;
}

export function connect(): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let raf = 0;
  const pendingQuotes = new Map<string, Quote>();
  const pings = new Map<number, number>();
  let pingId = 0;
  const st = useStore.getState;

  const flush = () => {
    raf = 0;
    if (!pendingQuotes.size) return;
    const qs = [...pendingQuotes.values()];
    pendingQuotes.clear();
    st().applyQuotes(qs);
  };
  const schedule = () => {
    if (raf) return;
    // rAF does not run in hidden tabs; fall back to a timer so memory stays bounded
    raf = document.hidden ? (setTimeout(flush, 1000) as unknown as number) : requestAnimationFrame(flush);
  };

  const onMessage = (ev: MessageEvent) => {
    let m: ServerMsg;
    try {
      m = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    const s = st();
    s.set({ lastMsgAt: Date.now() });
    switch (m.t) {
      case 'snapshot': s.applySnapshot(m.d); break;
      case 'q': for (const q of m.d) pendingQuotes.set(q.symbol, q); schedule(); break;
      case 'status': s.set({ statuses: m.d }); break;
      case 'cluster':
        s.upsertCluster(m.d, m.breakingNow);
        if (m.breakingNow && useSettings.getState().sound) playChime('breaking');
        break;
      case 'calendar': s.set({ calendar: m.d }); break;
      case 'banks': s.set({ banks: m.d }); break;
      case 'crypto': s.set({ crypto: m.d }); break;
      case 'vol': s.set({ vol: m.d }); break;
      case 'analytics': s.set({ analytics: m.d }); break;
      case 'watchlist': s.set({ watchlist: m.d }); break;
      case 'alerts': s.set({ alerts: m.d }); break;
      case 'alert': {
        s.set({ alertEvents: [m.d, ...s.alertEvents].slice(0, 30) });
        s.pushToast({ kind: 'alert', title: 'Alert triggered', body: m.d.message });
        const set = useSettings.getState();
        if (set.sound) playChime('alert');
        if (set.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
          try {
            new Notification('PULSE alert', { body: m.d.message, tag: m.d.ruleId });
          } catch {
            /* some browsers only allow notifications from a service worker */
          }
        }
        break;
      }
      case 'pong': {
        const sent = pings.get(m.id);
        if (sent) {
          pings.delete(m.id);
          s.set({ rttMs: Math.round(performance.now() - sent) });
        }
        break;
      }
    }
  };

  const open = () => {
    if (stopped) return;
    st().set({ conn: 'connecting' });
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      return reconnect();
    }
    ws.onopen = () => {
      attempt = 0;
      st().set({ conn: 'open', lastMsgAt: Date.now() });
      ws?.send(JSON.stringify({ t: 'vis', hidden: document.hidden }));
      ping();
    };
    ws.onmessage = onMessage;
    ws.onclose = () => {
      st().set({ conn: 'closed', rttMs: null });
      reconnect();
    };
    ws.onerror = () => ws?.close();
  };

  const reconnect = () => {
    if (stopped || retry) return;
    const cap = Math.min(20_000, 500 * 2 ** attempt++);
    const delay = cap / 2 + Math.random() * (cap / 2);
    retry = setTimeout(() => {
      retry = null;
      open();
    }, delay);
  };

  const ping = () => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const id = ++pingId;
    pings.set(id, performance.now());
    if (pings.size > 10) pings.delete(pings.keys().next().value!);
    ws.send(JSON.stringify({ t: 'ping', id }));
  };

  const onVis = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'vis', hidden: document.hidden }));
    if (!document.hidden) {
      if (raf) { clearTimeout(raf); cancelAnimationFrame(raf); raf = 0; }
      flush();
      ping();
    }
  };

  // deferred so React StrictMode's mount/unmount/mount in dev doesn't open-and-abort a socket
  const startTimer = setTimeout(open, 0);
  pingTimer = setInterval(ping, 5000);
  // if the socket goes silent (half-open TCP), force a reconnect
  watchdog = setInterval(() => {
    const last = st().lastMsgAt;
    if (ws?.readyState === WebSocket.OPEN && last && Date.now() - last > 20_000) ws.close();
  }, 5000);
  document.addEventListener('visibilitychange', onVis);

  return () => {
    stopped = true;
    clearTimeout(startTimer);
    if (retry) clearTimeout(retry);
    if (pingTimer) clearInterval(pingTimer);
    if (watchdog) clearInterval(watchdog);
    if (raf) { cancelAnimationFrame(raf); clearTimeout(raf); }
    document.removeEventListener('visibilitychange', onVis);
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  };
}
