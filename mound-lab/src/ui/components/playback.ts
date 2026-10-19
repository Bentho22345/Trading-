// Shared playback clock (real time, seconds) with speed, looping and frame stepping.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Playback {
  t: number;
  playing: boolean;
  speed: number;
  loop: [number, number] | null;
  setT(t: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  setSpeed(s: number): void;
  setLoop(l: [number, number] | null): void;
  step(frames: number): void;
}

export const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1];

export function usePlayback(duration: number, fps: number, opts: { pauseAt?: number[] } = {}): Playback {
  const [t, setTState] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.25);
  const [loop, setLoop] = useState<[number, number] | null>(null);
  const ref = useRef({ t: 0, speed: 0.25, loop: null as [number, number] | null, duration, pauseAt: opts.pauseAt });
  ref.current.speed = speed; ref.current.loop = loop; ref.current.duration = duration; ref.current.pauseAt = opts.pauseAt;

  const setT = useCallback((v: number) => {
    const c = Math.max(0, Math.min(ref.current.duration, v));
    ref.current.t = c;
    setTState(c);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * ref.current.speed;
      last = now;
      let nt = ref.current.t + dt;
      const [lo, hi] = ref.current.loop ?? [0, ref.current.duration];
      // event tour: pause when crossing an event
      const stop = ref.current.pauseAt?.find((e) => ref.current.t < e && nt >= e);
      if (stop !== undefined) { setT(stop); setPlaying(false); return; }
      if (nt >= hi) nt = ref.current.loop ? lo : (setPlaying(false), hi);
      setT(nt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, setT]);

  return {
    t, playing, speed, loop, setT,
    play: () => { if (ref.current.t >= ref.current.duration - 1e-3) setT(ref.current.loop?.[0] ?? 0); setPlaying(true); },
    pause: () => setPlaying(false),
    toggle: () => setPlaying((p) => { if (!p && ref.current.t >= ref.current.duration - 1e-3) setT(0); return !p; }),
    setSpeed, setLoop,
    step: (k: number) => { setPlaying(false); setT(Math.round(ref.current.t * fps + k) / fps); },
  };
}

/** Keyboard shortcuts shared by the clip and compare screens. */
export function useKeys(map: Record<string, (e: KeyboardEvent) => void>) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key === ' ' ? 'Space' : e.key;
      const fn = ref.current[k];
      if (fn) { e.preventDefault(); fn(e); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}
