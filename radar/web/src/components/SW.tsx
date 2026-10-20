'use client';
import { useEffect } from 'react';

/** Registers the service worker (installable app on phones, instant opens). */
export function SW() {
  useEffect(() => {
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  return null;
}
