'use client';
/**
 * Read-only wallet connection over the Solana Wallet Standard (Phantom, Solflare, Backpack, Glow, …).
 *
 * Radar only ever asks a wallet for its PUBLIC address (`standard:connect`). It never requests a
 * signature or a transaction, so connecting can't move funds. The address is saved to the backend's
 * "wallet" connector, which powers holdings, Rug Shield on held tokens and P&L.
 *
 * The discovery handshake below is the Wallet Standard protocol itself (what @wallet-standard/app
 * does), inlined so the app needs no wallet SDK.
 */
import { useSyncExternalStore } from 'react';
import { api } from './api';

type WsAccount = { address: string; chains: readonly string[] };
type WsWallet = {
  name: string; icon: string; chains: readonly string[]; accounts: readonly WsAccount[];
  features: Record<string, any>;
};

export type WalletInfo = { name: string; icon: string };
export type WalletState = {
  wallets: WalletInfo[];            // detected Solana wallets in this browser
  address: string | null;           // the address Radar is watching
  via: string | null;               // wallet name, or 'address' when pasted watch-only
  connecting: string | null;
  error: string | null;
};

const KEY = 'radar:wallet';
const found = new Map<string, WsWallet>();
let state: WalletState = { wallets: [], address: null, via: null, connecting: null, error: null };
const subs = new Set<() => void>();
let started = false;
let offChange: (() => void) | null = null;

function set(p: Partial<WalletState>) {
  state = { ...state, ...p };
  subs.forEach((f) => f());
}

const isSolana = (w: WsWallet) => w.chains?.some((c) => c.startsWith('solana:')) && !!w.features?.['standard:connect'];

function register(...ws: WsWallet[]) {
  for (const w of ws) if (isSolana(w) && !found.has(w.name)) found.set(w.name, w);
  set({ wallets: [...found.values()].map((w) => ({ name: w.name, icon: w.icon })) });
  return () => {};
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  // Wallets that load after us announce themselves with this event…
  window.addEventListener('wallet-standard:register-wallet', ((e: CustomEvent) => {
    try { e.detail({ register }); } catch { /* a misbehaving extension shouldn't break the app */ }
  }) as EventListener);
  // …and wallets that loaded before us listen for this one.
  try {
    window.dispatchEvent(Object.assign(new Event('wallet-standard:app-ready'), { detail: { register } }));
  } catch { /* */ }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved?.address) set({ address: saved.address, via: saved.via });
  } catch { /* */ }
  // The backend is the source of truth for which address is watched (it may have been set on Connectors).
  api<{ connectors: any[] }>('/api/connectors').then((r) => {
    const c = r.connectors?.find((x: any) => x.id === 'wallet');
    const addr = c?.fields?.find((f: any) => f.name === 'address')?.value || null;
    if (addr && addr !== state.address) remember(addr, 'address');
    if (!addr && state.address) remember(null, null);
  }).catch(() => {});
  // Reconnect silently to a wallet the user approved before, so account switches are followed.
  setTimeout(() => {
    if (state.via && state.via !== 'address' && found.has(state.via)) connect(state.via, true).catch(() => {});
  }, 400);
}

function remember(address: string | null, via: string | null) {
  set({ address, via, error: null });
  try {
    if (address) localStorage.setItem(KEY, JSON.stringify({ address, via }));
    else localStorage.removeItem(KEY);
  } catch { /* */ }
}

async function save(address: string, via: string) {
  const r = await api<{ status?: string; message?: string }>('/api/connectors/wallet', { method: 'POST', body: JSON.stringify({ values: { address } }) });
  if (r.status === 'error') throw new Error(r.message || 'Address rejected');
  remember(address, via);
  window.dispatchEvent(new Event('radar:wallet'));
}

function pickAccount(w: WsWallet, accounts: readonly WsAccount[]): string | null {
  const sol = accounts.filter((a) => !a.chains?.length || a.chains.some((c) => c.startsWith('solana:')));
  return (sol[0] || accounts[0])?.address || null;
}

/** Ask a wallet for its public address. `silent` only succeeds if the user already approved this site. */
export async function connect(name: string, silent = false) {
  const w = found.get(name);
  if (!w) throw new Error(`${name} not found`);
  if (!silent) set({ connecting: name, error: null });
  try {
    const res = await w.features['standard:connect'].connect(silent ? { silent: true } : undefined);
    const addr = pickAccount(w, res?.accounts?.length ? res.accounts : w.accounts);
    if (!addr) { if (!silent) throw new Error('The wallet returned no Solana account'); return; }
    if (addr !== state.address || state.via !== name) await save(addr, name);
    offChange?.();
    offChange = w.features['standard:events']?.on?.('change', (p: { accounts?: readonly WsAccount[] }) => {
      if (!p.accounts || state.via !== name) return;
      const next = pickAccount(w, p.accounts);
      if (next && next !== state.address) save(next, name).catch(() => {});
    }) || null;
  } catch (e: any) {
    if (!silent) set({ error: e?.message?.includes('reject') ? 'Request cancelled in the wallet' : e?.message || String(e) });
    if (!silent) throw e;
  } finally {
    if (!silent) set({ connecting: null });
  }
}

/** Watch any public address without a wallet extension (e.g. on a phone or a cold wallet). */
export async function watchAddress(address: string) {
  const a = address.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) { set({ error: 'That is not a valid Solana address' }); throw new Error('invalid'); }
  set({ connecting: 'address', error: null });
  try { await save(a, 'address'); } catch (e: any) { set({ error: e?.message || String(e) }); throw e; } finally { set({ connecting: null }); }
}

export async function disconnect() {
  const w = state.via ? found.get(state.via) : undefined;
  offChange?.(); offChange = null;
  try { await w?.features['standard:disconnect']?.disconnect(); } catch { /* */ }
  await api('/api/connectors/wallet', { method: 'DELETE' }).catch(() => {});
  remember(null, null);
  window.dispatchEvent(new Event('radar:wallet'));
}

const SERVER: WalletState = { wallets: [], address: null, via: null, connecting: null, error: null };

export function useWallet(): WalletState {
  return useSyncExternalStore(
    (f) => { start(); subs.add(f); return () => { subs.delete(f); }; },
    () => state,
    () => SERVER,
  );
}

export function clearWalletError() { set({ error: null }); }
