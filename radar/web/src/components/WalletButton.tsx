'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { short } from '@/lib/format';
import { clearWalletError, connect, disconnect, useWallet, watchAddress } from '@/lib/wallet';
import { Icon } from './Icon';
import { AnimatePresence, motion } from './motion';

const GET = [
  { name: 'Phantom', url: 'https://phantom.com/download' },
  { name: 'Solflare', url: 'https://solflare.com/download' },
  { name: 'Backpack', url: 'https://backpack.app/download' },
];

/** Top-bar wallet control. Read-only: connecting shares the public address, nothing is ever signed. */
export function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [paste, setPaste] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', off); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc); };
  }, [open]);

  const icon = w.via && w.via !== 'address' ? w.wallets.find((x) => x.name === w.via)?.icon : null;

  return (
    <div ref={ref} className="relative">
      <button onClick={() => { setOpen((o) => !o); clearWalletError(); }}
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium transition active:scale-95 ${w.address
          ? 'border-white/10 bg-white/[0.05] hover:border-accent/50'
          : 'border-accent/40 bg-gradient-to-r from-accent/20 to-accent2/20 text-fg hover:border-accent shadow-[0_0_20px_-8px_var(--color-accent)]'}`}>
        {icon ? <img src={icon} alt="" className="h-4 w-4 rounded" /> : <Icon name="wallet" size={14} className={w.address ? 'text-accent2' : ''} />}
        {w.address ? <span className="num">{short(w.address)}</span> : <span className="num">Connect<span className="hidden sm:inline"> wallet</span></span>}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.16 }}
            className="glass fixed inset-x-3 top-14 z-50 rounded-2xl !bg-panel/95 backdrop-blur-xl p-3 text-[12px] shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+8px)] sm:w-[300px]">
            {w.address ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {icon ? <img src={icon} alt="" className="h-6 w-6 rounded-md" /> : <span className="flex h-6 w-6 items-center justify-center rounded-md bg-white/5"><Icon name="eye" size={14} /></span>}
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{w.via === 'address' ? 'Watching address' : w.via}</div>
                    <div className="num truncate text-[11px] text-mute" title={w.address}>{w.address}</div>
                  </div>
                </div>
                <p className="text-[11px] text-mute">Read-only. Radar sees your public balances and never asks your wallet to sign anything.</p>
                <div className="flex gap-2">
                  <Link href="/wallet" onClick={() => setOpen(false)} className="flex-1 rounded-lg bg-accent/20 px-3 py-1.5 text-center text-accent hover:bg-accent/30">View holdings</Link>
                  <button onClick={() => disconnect().then(() => setOpen(false))} className="rounded-lg border border-white/10 px-3 py-1.5 text-mute hover:border-down/50 hover:text-down">Disconnect</button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-[13px] font-semibold">Connect a Solana wallet</div>
                <p className="text-[11px] text-mute">Read-only: Radar only reads your public address to show holdings and run Rug Shield on them. No signing, no transactions.</p>
                {w.wallets.length ? (
                  <div className="space-y-1">
                    {w.wallets.map((x) => (
                      <button key={x.name} disabled={!!w.connecting} onClick={() => connect(x.name).then(() => setOpen(false)).catch(() => {})}
                        className="flex w-full items-center gap-2.5 rounded-xl border border-white/5 bg-white/[0.03] px-2.5 py-2 text-left transition hover:border-accent/50 hover:bg-white/[0.06] disabled:opacity-50">
                        <img src={x.icon} alt="" className="h-6 w-6 rounded-md" />
                        <span className="flex-1 font-medium">{x.name}</span>
                        {w.connecting === x.name ? <span className="text-[11px] text-accent">approve in wallet…</span> : <span className="text-[10px] text-mute">detected</span>}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-white/5 bg-white/[0.03] p-2.5 text-[11px] text-mute">
                    No wallet extension found in this browser. Install one, or paste your address below.
                    <div className="mt-1.5 flex gap-2">{GET.map((g) => <a key={g.name} href={g.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{g.name}</a>)}</div>
                  </div>
                )}
                <form className="flex gap-1.5 border-t border-white/5 pt-2" onSubmit={(e) => { e.preventDefault(); watchAddress(paste).then(() => { setPaste(''); setOpen(false); }).catch(() => {}); }}>
                  <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="…or paste a public address"
                    className="num min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 py-1.5 outline-none focus:border-accent" />
                  <button disabled={!paste.trim() || !!w.connecting} className="rounded-lg bg-white/5 px-2.5 text-fg hover:bg-white/10 disabled:opacity-40">Watch</button>
                </form>
              </div>
            )}
            {w.error && <p className="mt-2 rounded-lg bg-down/10 px-2 py-1 text-[11px] text-down">{w.error}</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
