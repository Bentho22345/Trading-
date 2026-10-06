'use client';
import type { NewsCluster, Quote, ServerMsg } from '@shared/types';
import { useStore } from './store';
import { useSettings } from './settings';
import { playChime } from './sound';
import { useV2 } from './v2';

/**
 * Browser ⇄ worker WebSocket.
 *  - one upstream connection per browser: the tab holding a Web Lock connects and relays frames to
 *    other tabs and pop-out windows over a BroadcastChannel (leader election, automatic failover)
 *  - exponential backoff with full jitter, capped at 20 s; resync via snapshot on reconnect
 *  - quote messages are coalesced and applied once per animation frame (no re-render storms)
 *  - when the tab is hidden the server throttles to 2 s batches; the UI catches up in one frame on focus
 */
export function wsUrl() {
  const env = process.env.NEXT_PUBLIC_WS_URL;
  if (env) return env;
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
}

const st = useStore.getState;

// ------------------------------------------------------------------ quote coalescing (shared)
const pendingQuotes = new Map<string, Quote>();
let raf = 0;
function flush() {
  raf = 0;
  if (!pendingQuotes.size) return;
  const qs = [...pendingQuotes.values()];
  pendingQuotes.clear();
  st().applyQuotes(qs);
}
function schedule() {
  if (raf) return;
  // rAF does not run in hidden tabs; fall back to a timer so memory stays bounded
  raf = document.hidden ? (setTimeout(flush, 1000) as unknown as number) : requestAnimationFrame(flush);
}
function flushNow() {
  if (raf) { clearTimeout(raf); cancelAnimationFrame(raf); raf = 0; }
  flush();
}

// ------------------------------------------------------------------ backfill
let backfilled = false;
/** The snapshot carries only the newest clusters; fetch older ones once the page is idle. */
function backfillOlder() {
  if (backfilled) return;
  backfilled = true;
  const run = async () => {
    const list = st().clusters;
    const oldest = list[list.length - 1];
    if (!oldest) return;
    try {
      const res = await fetch(`/api/news?before=${oldest.receivedAt}&limit=240`);
      if (!res.ok) return;
      const older = (await res.json()) as NewsCluster[];
      const cur = st().clusters;
      const have = new Set(cur.map((c) => c.id));
      st().set({ clusters: [...cur, ...older.filter((c) => !have.has(c.id))].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 600) });
    } catch {
      /* the feed still works; older items load via "Load older stories" */
    }
  };
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(() => void run(), { timeout: 4000 });
  else setTimeout(() => void run(), 1500);
}

// ------------------------------------------------------------------ message handling (leader and followers)
/** Replay mode swaps live market frames for archived ones; live frames are ignored meanwhile. */
export const replayGate = { active: false };

function handle(m: ServerMsg, leader: boolean) {
  const s = st();
  s.set({ lastMsgAt: Date.now() });
  if (replayGate.active && (m.t === 'q' || m.t === 'cluster' || m.t === 'alert')) return;
  switch (m.t) {
    case 'snapshot': {
      if (replayGate.active) return;
      s.applySnapshot(m.d);
      const v = useV2.getState();
      v.set({ intel: Object.fromEntries((m.d.intel ?? []).map((b) => [b.key, b])), handoffs: m.d.handoffs ?? [], exposure: m.d.exposure ?? null });
      if (!v.docsLoaded) void v.loadDocs();
      backfillOlder();
      break;
    }
    case 'q': for (const q of m.d) pendingQuotes.set(q.symbol, q); schedule(); break;
    case 'status': s.set({ statuses: m.d }); break;
    case 'cluster':
      s.upsertCluster(m.d, m.breakingNow);
      if (m.breakingNow) {
        if (leader && useSettings.getState().sound) playChime('breaking');
        window.dispatchEvent(new CustomEvent('pulse:breaking', { detail: m.d }));
      }
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
      if (leader && set.sound) playChime('alert');
      if (leader && set.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
        try {
          new Notification('PULSE alert', { body: m.d.message, tag: m.d.ruleId });
        } catch {
          /* some browsers only allow notifications from a service worker */
        }
      }
      break;
    }
    case 'intel': useV2.getState().setIntel(m.d); break;
    case 'doc': useV2.getState().applyDoc(m.c, m.op, m.d); break;
    case 'brief': {
      const v = useV2.getState();
      v.set({ latestBrief: m.d });
      s.pushToast({ kind: 'info', title: `${m.d.kind === 'eod' ? 'End-of-day wrap' : m.d.kind === 'weekly' ? 'Weekly review' : m.d.kind === 'handoff' ? 'Session handoff' : 'Brief'} ready`, body: m.d.headline });
      if (m.open && !document.hidden && leader) v.openBrief(m.d.id);
      break;
    }
    case 'handoff': useV2.getState().set({ handoffs: [m.d, ...useV2.getState().handoffs.filter((h) => h.id !== m.d.id)].slice(0, 6) }); break;
    case 'exposure': useV2.getState().set({ exposure: m.d }); break;
    case 'playbook': {
      const v = useV2.getState();
      v.set({ outcomes: [m.d, ...v.outcomes.filter((o) => o.id !== m.d.id)].slice(0, 50) });
      window.dispatchEvent(new CustomEvent('pulse:playbook', { detail: m.d }));
      if (m.d.status === 'pending' && leader) s.pushToast({ kind: 'alert', title: `Playbook fired: ${m.d.playbookName}`, body: m.d.scenarioLabel ? `Scenario “${m.d.scenarioLabel}” — ${m.d.eventTitle}` : `${m.d.eventTitle}: no scenario matched` });
      break;
    }
    case 'alert2': {
      const v = useV2.getState();
      v.set({ alertHistory: [m.d, ...v.alertHistory.filter((a) => a.id !== m.d.id)].slice(0, 200) });
      if (leader) window.dispatchEvent(new CustomEvent('pulse:alert2', { detail: m.d }));
      break;
    }
  }
}

function parse(raw: string): ServerMsg | null {
  try {
    return JSON.parse(raw) as ServerMsg;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ connection
export function connect(): () => void {
  if (typeof navigator === 'undefined' || !('locks' in navigator) || typeof BroadcastChannel === 'undefined') return connectDirect();
  return connectShared();
}

const CHANNEL = 'pulse-ws';
type Relay = { raw?: string; conn?: { conn: 'connecting' | 'open' | 'closed'; rttMs: number | null }; hello?: boolean };

function connectShared(): () => void {
  const bc = new BroadcastChannel(CHANNEL);
  let stopDirect: (() => void) | null = null;
  let release: (() => void) | null = null;
  let requestSnapshot: (() => void) | null = null;
  let stopped = false;
  const abort = new AbortController();
  st().set({ conn: 'connecting' });

  bc.onmessage = (e: MessageEvent<Relay>) => {
    const m = e.data;
    if (stopDirect) {
      if (m.hello) {
        // a new follower wants a fresh snapshot and the current connection state
        requestSnapshot?.();
        bc.postMessage({ conn: { conn: st().conn, rttMs: st().rttMs } } satisfies Relay);
      }
      return;
    }
    if (m.raw) {
      const msg = parse(m.raw);
      if (msg) handle(msg, false);
    }
    if (m.conn) st().set({ conn: m.conn.conn, rttMs: m.conn.rttMs });
  };

  void navigator.locks.request('pulse-ws-leader', { signal: abort.signal }, () => new Promise<void>((resolve) => {
    if (stopped) return resolve();
    release = resolve;
    stopDirect = connectDirect({
      relay: (raw) => bc.postMessage({ raw } satisfies Relay),
      onConn: (conn, rttMs) => bc.postMessage({ conn: { conn, rttMs } } satisfies Relay),
      onSnapshotRequester: (fn) => (requestSnapshot = fn),
    });
  })).catch(() => { /* aborted on unmount */ });
  // as a follower, ask the leader (if there is one) for a snapshot
  const hello = setTimeout(() => !stopDirect && bc.postMessage({ hello: true } satisfies Relay), 80);

  return () => {
    stopped = true;
    clearTimeout(hello);
    abort.abort();
    stopDirect?.();
    release?.();
    bc.close();
  };
}

interface DirectOpts {
  relay?: (raw: string) => void;
  onConn?: (conn: 'connecting' | 'open' | 'closed', rttMs: number | null) => void;
  onSnapshotRequester?: (fn: () => void) => void;
}

function connectDirect(opts: DirectOpts = {}): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const pings = new Map<number, number>();
  let pingId = 0;

  const setConn = (conn: 'connecting' | 'open' | 'closed', rttMs: number | null = st().rttMs) => {
    st().set({ conn, rttMs });
    opts.onConn?.(conn, rttMs);
  };
  opts.onSnapshotRequester?.(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resnap' }));
  });

  const onMessage = (ev: MessageEvent) => {
    const raw = ev.data as string;
    const m = parse(raw);
    if (!m) return;
    if (m.t === 'pong') {
      const sent = pings.get(m.id);
      if (sent) {
        pings.delete(m.id);
        const rtt = Math.round(performance.now() - sent);
        st().set({ rttMs: rtt, lastMsgAt: Date.now() });
        opts.onConn?.('open', rtt);
      }
      return;
    }
    opts.relay?.(raw);
    handle(m, true);
  };

  const open = () => {
    if (stopped) return;
    setConn('connecting');
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      return reconnect();
    }
    ws.onopen = () => {
      attempt = 0;
      st().set({ lastMsgAt: Date.now() });
      setConn('open');
      ws?.send(JSON.stringify({ t: 'vis', hidden: document.hidden }));
      ping();
    };
    ws.onmessage = onMessage;
    ws.onclose = () => {
      setConn('closed', null);
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
      flushNow();
      ping();
    }
  };

  // deferred so React StrictMode's mount/unmount/mount in dev doesn't open-and-abort a socket
  const startTimer = setTimeout(open, 0);
  const pingTimer = setInterval(ping, 5000);
  // if the socket goes silent (half-open TCP), force a reconnect
  const watchdog = setInterval(() => {
    const last = st().lastMsgAt;
    if (ws?.readyState === WebSocket.OPEN && last && Date.now() - last > 20_000) ws.close();
  }, 5000);
  document.addEventListener('visibilitychange', onVis);

  return () => {
    stopped = true;
    clearTimeout(startTimer);
    if (retry) clearTimeout(retry);
    clearInterval(pingTimer);
    clearInterval(watchdog);
    document.removeEventListener('visibilitychange', onVis);
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  };
}

/** Followers keep their own visibility catch-up even though they hold no socket. */
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => !document.hidden && flushNow());
