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
      const m = JSON.parse(e.data) as Msg;
      listeners.forEach((f) => f(m));
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
