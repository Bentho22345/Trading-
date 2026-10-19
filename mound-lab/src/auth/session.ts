// Who is signed in on this device. Kept tiny and dependency-free: db.ts and the settings read it at startup
// to open the signed-in person's own library and preferences.

export interface Session {
  /** null for guest mode (the original, account-less library). */
  userId: string | null;
  name: string;
  email?: string;
  color: string;
  guest: boolean;
  /** Stay signed in after the browser closes. */
  remember: boolean;
  at: number;
}

const KEY = 'mound-session';
const REMEMBER_DAYS = 30;

function read(store: Storage | undefined): Session | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s || typeof s.name !== 'string') return null;
    // remembered sign-ins last 30 days from the last visit
    if (s.remember && Date.now() - s.at > REMEMBER_DAYS * 86400000) { store?.removeItem(KEY); return null; }
    return s;
  } catch { return null; }
}

const ls = () => { try { return window.localStorage; } catch { return undefined; } };
const ss = () => { try { return window.sessionStorage; } catch { return undefined; } };

export function currentSession(): Session | null {
  return read(ss()) ?? read(ls());
}

export function saveSession(s: Session) {
  const v = JSON.stringify({ ...s, at: Date.now() });
  try {
    ss()?.setItem(KEY, v);
    if (s.remember) ls()?.setItem(KEY, v); else ls()?.removeItem(KEY);
  } catch { /* storage blocked: the session lasts until reload */ }
}

/** Refresh the remembered sign-in's 30-day window. */
export function touchSession() {
  const s = currentSession();
  if (s) saveSession(s);
}

export function clearSession() {
  try { ss()?.removeItem(KEY); ls()?.removeItem(KEY); } catch { /* ignore */ }
}

/** IndexedDB database holding this person's clips, athletes, sessions and analyses. */
export function dbName(s: Session | null = currentSession()): string {
  return s && !s.guest && s.userId ? `mound-lab-u-${s.userId}` : 'mound-lab';
}

/** localStorage key of this person's settings. */
export function settingsKey(s: Session | null = currentSession()): string {
  return s && !s.guest && s.userId ? `mound-settings-${s.userId}` : 'mound-settings';
}
