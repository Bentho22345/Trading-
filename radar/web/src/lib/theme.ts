'use client';
import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'radar:theme';
const EVT = 'radar:theme';

/** Runs before first paint (inlined in <head>) so the page never flashes the wrong theme. */
export const THEME_BOOT = `try{var t=localStorage.getItem('${KEY}');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}`;

export function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(t: Theme) {
  const root = document.documentElement;
  root.classList.add('theme-anim');
  root.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* private mode */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f3f3f0' : '#000000');
  window.dispatchEvent(new Event(EVT));
  window.setTimeout(() => root.classList.remove('theme-anim'), 400);
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [t, setT] = useState<Theme>('dark');
  useEffect(() => {
    setT(currentTheme());
    const on = () => setT(currentTheme());
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return [t, setTheme];
}

/** Resolved value of a CSS custom property (for canvas/chart code that can't use var()). */
export function cssVar(name: string, fallback = ''): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
