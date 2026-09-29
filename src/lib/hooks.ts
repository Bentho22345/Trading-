'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from './store';
import { useSettings } from './settings';

// ------------------------------------------------------------------ shared clock
// One interval per resolution for the whole app, instead of one timer per "12s ago" label.
const clocks = new Map<number, { now: number; subs: Set<() => void>; timer: ReturnType<typeof setInterval> | null }>();

function clock(ms: number) {
  let c = clocks.get(ms);
  if (!c) clocks.set(ms, (c = { now: Date.now(), subs: new Set(), timer: null }));
  return c;
}

export function useNow(ms = 1000): number {
  const c = clock(ms);
  return useSyncExternalStore(
    (cb) => {
      c.subs.add(cb);
      if (!c.timer) c.timer = setInterval(() => {
        c.now = Date.now();
        c.subs.forEach((f) => f());
      }, ms);
      return () => {
        c.subs.delete(cb);
        if (!c.subs.size && c.timer) {
          clearInterval(c.timer);
          c.timer = null;
        }
      };
    },
    () => c.now,
    () => 0,
  );
}

export const useQuote = (symbol: string) => useStore((s) => s.quotes[symbol]);

// ------------------------------------------------------------------ motion preferences
export function usePrefersReducedMotion() {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}

/** true when animations should be minimal (OS reduced-motion or in-app Calm mode) */
export function useCalm() {
  const reduced = usePrefersReducedMotion();
  const calm = useSettings((s) => s.calm);
  return reduced || calm;
}

// ------------------------------------------------------------------ price flash
/**
 * Flashes the element's background green/red for 400ms when `value` changes. Uses WAAPI on the
 * element directly so a tick never triggers a React re-render of its own.
 */
export function useFlash<T extends HTMLElement>(value: number | undefined, intensity = 1) {
  const ref = useRef<T>(null);
  const prev = useRef<number | undefined>(value);
  const calm = useCalm();
  useEffect(() => {
    const p = prev.current;
    prev.current = value;
    const el = ref.current;
    if (!el || p === undefined || value === undefined || p === value) return;
    const up = value > p;
    const color = getComputedStyle(document.documentElement).getPropertyValue(up ? '--up-bg' : '--down-bg').trim();
    if (!color) return;
    el.animate([{ backgroundColor: color, opacity: 1 }, { backgroundColor: 'transparent' }], {
      duration: calm ? 250 : 400 * intensity,
      easing: 'ease-out',
    });
  }, [value, calm, intensity]);
  return ref;
}

// ------------------------------------------------------------------ misc
export function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

export function useInterval(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
