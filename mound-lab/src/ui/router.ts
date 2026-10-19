// Minimal hash router (static hosting friendly).
import { useSyncExternalStore } from 'react';

const subscribe = (cb: () => void) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); };
const snapshot = () => window.location.hash.replace(/^#/, '') || '/';

export function useRoute(): { path: string; parts: string[]; query: URLSearchParams } {
  const h = useSyncExternalStore(subscribe, snapshot, () => '/');
  const [path, q] = h.split('?');
  return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(q ?? '') };
}

export const go = (path: string) => { window.location.hash = path; };
