'use client';
import { useEffect, useRef, useState } from 'react';
import { wsUrl } from './api';

type Msg = { ch: string; ts: number; data: any };
type Listener = (m: Msg) => void;

// One socket per tab, shared by every component.
let socket: WebSocket | null = null;
let connected = false;
let views: string[] = [];
const listeners = new Set<Listener>();
const statusListeners = new Set<(c: boolean) => void>();

// Bursts of socket messages are delivered once per animation frame, so React batches the
// resulting state updates into one render instead of one per message. Hidden tabs get no
// frames, so they flush right away (alerts and FLASH toasts must not wait).
let queue: Msg[] = [];
let scheduled = false;
let visHooked = false;
function flush() {
  scheduled = false;
  const batch = queue;
  queue = [];
  for (const m of batch) listeners.forEach((f) => f(m));
}
function schedule() {
  if (!visHooked) {
    // a frame requested just before the tab was hidden never fires; flush it now
    visHooked = true;
    document.addEventListener('visibilitychange', () => { if (scheduled && document.hidden) flush(); });
  }
  if (scheduled) return;
  scheduled = true;
  if (document.hidden) setTimeout(flush, 0);
  else requestAnimationFrame(flush);
}

function connect() {
  if (typeof window === 'undefined' || socket || window.location.pathname === '/login') return;
  const ws = new WebSocket(wsUrl());
  socket = ws;
  ws.onopen = () => {
    connected = true;
    statusListeners.forEach((f) => f(true));
    ws.send(JSON.stringify({ view: views }));
  };
  ws.onmessage = (e) => {
    try {
      queue.push(JSON.parse(e.data) as Msg);
      schedule();
    } catch { /* ignore */ }
  };
  ws.onclose = (e) => {
    socket = null;
    if (!connected && e.code !== 1000) {
      // handshake refused: probably logged out — let the session endpoint decide
      fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json()).then((s) => {
        if (s.auth_required && !s.authed && location.pathname !== '/login') location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      }).catch(() => {});
    }
    connected = false;
    statusListeners.forEach((f) => f(false));
    setTimeout(connect, 1500);
  };
}

export function setViewing(addrs: string[]) {
  views = addrs;
  if (socket && connected) socket.send(JSON.stringify({ view: views }));
}

export function useLive(handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    connect();
    const f: Listener = (m) => ref.current(m);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
}

export function useConnected() {
  const [c, setC] = useState(connected);
  useEffect(() => {
    connect();
    statusListeners.add(setC);
    return () => { statusListeners.delete(setC); };
  }, []);
  return c;
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Runs `fn` now and every `ms` while the tab is visible; refreshes as soon as it becomes visible again. */
export function usePoll(fn: () => unknown, ms: number, deps: React.DependencyList = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | undefined;
    const start = () => { stop(); ref.current(); t = setInterval(() => ref.current(), ms); };
    const stop = () => { if (t) clearInterval(t); t = undefined; };
    const onVis = () => (document.hidden ? stop() : start());
    if (document.hidden) ref.current(); else start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}
