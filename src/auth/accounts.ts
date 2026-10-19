// Accounts stored on this device. Each person gets their own library (IndexedDB database) and settings.
// Passwords are never stored: only a salted PBKDF2-SHA-256 hash (WebCrypto, 210,000 iterations).
// There is no server, so accounts don't sync between devices — the sign-in screen says so.

import Dexie, { type Table } from 'dexie';
import { SCHEMA_V1 } from '../db/schema';
import { clearSession, saveSession, type Session } from './session';

export type Role = 'pitcher' | 'coach' | 'parent' | 'other';

export interface Account {
  id: string;
  name: string;
  email: string;
  /** lower-cased email, unique */
  emailKey: string;
  role: Role;
  color: string;
  salt: string; // base64
  hash: string; // base64
  iterations: number;
  createdAt: number;
  lastLogin: number;
  /** Failed sign-in attempts in a row (slows down guessing). */
  failures?: number;
}

class AccountsDB extends Dexie {
  users!: Table<Account, string>;
  constructor() {
    super('mound-lab-accounts');
    this.version(1).stores({ users: 'id, &emailKey, lastLogin' });
  }
}

let adb: AccountsDB | null = null;
const accountsDb = () => (adb ??= new AccountsDB());

const ITERATIONS = 210_000;
const COLORS = ['#2463d6', '#d6532a', '#1f9d6b', '#8a4fd8', '#c2410c', '#0e7490', '#be185d', '#4d7c0f'];

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  if (!crypto?.subtle) throw new Error('Secure sign-in needs HTTPS (or localhost). Open the app from its https:// address.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return b64(bits);
}

/** Constant-time string compare (hashes are equal length). */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const normEmail = (e: string) => e.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Problems with a new password, or null if it's acceptable. */
export function passwordProblem(p: string): string | null {
  if (p.length < 8) return 'Use at least 8 characters.';
  if (/^(.)\1+$/.test(p) || /^(password|12345678|qwerty)/i.test(p)) return 'That password is too easy to guess.';
  return null;
}

export async function listAccounts(): Promise<Account[]> {
  try { return await accountsDb().users.orderBy('lastLogin').reverse().toArray(); } catch { return []; }
}

function sessionFor(a: Account, remember: boolean): Session {
  return { userId: a.id, name: a.name, email: a.email, color: a.color, guest: false, remember, at: Date.now() };
}

export async function createAccount(input: { name: string; email: string; password: string; role: Role; remember: boolean }): Promise<Account> {
  const name = input.name.trim();
  const emailKey = normEmail(input.email);
  if (!name) throw new Error('Enter your name.');
  if (!EMAIL_RE.test(emailKey)) throw new Error('Enter a valid email address.');
  const bad = passwordProblem(input.password);
  if (bad) throw new Error(bad);
  if (await accountsDb().users.where('emailKey').equals(emailKey).first()) throw new Error('An account with that email already exists on this device. Sign in instead.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const count = await accountsDb().users.count();
  const acc: Account = {
    id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36),
    name, email: input.email.trim(), emailKey, role: input.role, color: COLORS[count % COLORS.length],
    salt: b64(salt), hash: await derive(input.password, salt, ITERATIONS), iterations: ITERATIONS,
    createdAt: Date.now(), lastLogin: Date.now(),
  };
  await accountsDb().users.add(acc);
  saveSession(sessionFor(acc, input.remember));
  return acc;
}

export async function signIn(email: string, password: string, remember: boolean): Promise<Account> {
  const acc = await accountsDb().users.where('emailKey').equals(normEmail(email)).first();
  // same message either way: don't reveal which emails have accounts
  const fail = 'Email or password is not right.';
  if (!acc) { await new Promise((r) => setTimeout(r, 400)); throw new Error(fail); }
  // back off after repeated failures
  const failures = acc.failures ?? 0;
  if (failures >= 5) await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** (failures - 5))));
  const hash = await derive(password, unb64(acc.salt), acc.iterations);
  if (!same(hash, acc.hash)) {
    await accountsDb().users.update(acc.id, { failures: failures + 1 });
    throw new Error(fail);
  }
  await accountsDb().users.update(acc.id, { lastLogin: Date.now(), failures: 0 });
  saveSession(sessionFor(acc, remember));
  return acc;
}

export async function changePassword(id: string, oldPw: string, newPw: string) {
  const acc = await accountsDb().users.get(id);
  if (!acc) throw new Error('Account not found.');
  if (!same(await derive(oldPw, unb64(acc.salt), acc.iterations), acc.hash)) throw new Error('Current password is not right.');
  const bad = passwordProblem(newPw);
  if (bad) throw new Error(bad);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await accountsDb().users.update(id, { salt: b64(salt), hash: await derive(newPw, salt, ITERATIONS), iterations: ITERATIONS });
}

export async function renameAccount(id: string, name: string) {
  if (!name.trim()) throw new Error('Enter a name.');
  await accountsDb().users.update(id, { name: name.trim() });
}

export function continueAsGuest(remember: boolean) {
  saveSession({ userId: null, name: 'Guest', color: '#6b7280', guest: true, remember, at: Date.now() });
}

export function signOut() {
  clearSession();
}

/** Remove an account and its whole library from this device. */
export async function deleteAccount(id: string) {
  await accountsDb().users.delete(id);
  await Dexie.delete(`mound-lab-u-${id}`);
  try { localStorage.removeItem(`mound-settings-${id}`); } catch { /* ignore */ }
}

/** Number of clips saved in guest mode (offered for moving into a new account). */
export async function guestClipCount(): Promise<number> {
  try {
    if (!(await Dexie.exists('mound-lab'))) return 0;
    const g = new Dexie('mound-lab');
    await g.open();
    const n = g.tables.some((t) => t.name === 'clips') ? await g.table('clips').count() : 0;
    g.close();
    return n;
  } catch { return 0; }
}

/** Move everything saved in guest mode into an account's library (then empty the guest library). */
export async function moveGuestData(toUserId: string, onProgress?: (msg: string) => void) {
  const src = new Dexie('mound-lab');
  await src.open();
  const dst = new Dexie(`mound-lab-u-${toUserId}`);
  dst.version(1).stores(SCHEMA_V1);
  await dst.open();
  for (const t of src.tables) {
    if (!dst.tables.some((d) => d.name === t.name)) continue;
    onProgress?.(`Moving ${t.name}…`);
    // one row at a time: videos and frame caches can be large
    const keys = await t.toCollection().primaryKeys();
    for (const k of keys) {
      const row = await t.get(k);
      if (row !== undefined) await dst.table(t.name).put(row);
    }
  }
  for (const t of src.tables) await t.clear();
  src.close(); dst.close();
  // guest settings become the account's settings
  try {
    const s = localStorage.getItem('mound-settings');
    if (s && !localStorage.getItem(`mound-settings-${toUserId}`)) localStorage.setItem(`mound-settings-${toUserId}`, s);
  } catch { /* ignore */ }
}
