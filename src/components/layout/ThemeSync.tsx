'use client';
import { useEffect } from 'react';
import { useSettings } from '@/lib/settings';

export function ThemeSync() {
  const theme = useSettings((s) => s.theme);
  const cb = useSettings((s) => s.colorblind);
  const calm = useSettings((s) => s.calm);
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = theme;
    el.dataset.cb = String(cb);
    el.classList.toggle('calm', calm);
  }, [theme, cb, calm]);
  return null;
}
