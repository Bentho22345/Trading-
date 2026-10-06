'use client';
import { useEffect } from 'react';
import { useSettings } from '@/lib/settings';
import { applyTheme } from '@/lib/theme';

/** Applies light/dark, colour-blind palette, calm mode and the theme editor's tokens to <html>. */
export function ThemeSync() {
  const theme = useSettings((s) => s.theme);
  const cb = useSettings((s) => s.colorblind);
  const calm = useSettings((s) => s.calm);
  const tc = useSettings((s) => s.themeConfig);
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = theme;
    el.dataset.cb = String(cb);
    el.classList.toggle('calm', calm);
    applyTheme(tc, { colorblind: cb });
  }, [theme, cb, calm, tc]);
  return null;
}
