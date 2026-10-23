'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { price, short, usd } from '@/lib/format';
import { Icon } from './Icon';
import { AnimatePresence, motion } from './motion';
import { LINKS } from './Nav';
import { TokenIcon } from './ui';

type Item = { kind: 'page' | 'token' | 'narrative'; label: string; sub?: string; href: string; icon?: string; image?: string };

/** ⌘K: jump to any page, coin (local DB + live DexScreener search) or narrative. Paste a CA to open it directly. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ tokens: any[]; narratives: any[] }>({ tokens: [], narratives: [] });
  const [sel, setSel] = useState(0);
  const inp = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inp.current?.focus(), 30); } }, [open]);
  useEffect(() => {
    if (!q.trim()) { setRes({ tokens: [], narratives: [] }); return; }
    const t = setTimeout(() => api(`/api/search?q=${encodeURIComponent(q.trim())}`).then(setRes).catch(() => {}), 160);
    return () => clearTimeout(t);
  }, [q]);

  const items: Item[] = useMemo(() => {
    const ql = q.toLowerCase().trim();
    const out: Item[] = [];
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q.trim()) || /^0x[a-fA-F0-9]{40}$/.test(q.trim()))
      out.push({ kind: 'token', label: `Open ${short(q.trim(), 6)}`, sub: 'contract address', href: `/token?a=${q.trim()}`, icon: 'link' });
    for (const t of res.tokens) out.push({ kind: 'token', label: `${t.symbol || short(t.address)}`, sub: `${t.name || ''} · ${price(t.price_usd)} · liq ${usd(t.liquidity_usd)}${t.remote ? ' · DexScreener' : ''}`, href: `/token?a=${t.address}`, image: t.image });
    for (const n of res.narratives) out.push({ kind: 'narrative', label: n.title, sub: `${n.category} · ${n.stage}`, href: `/narratives?n=${n.id}`, icon: 'narrative' });
    for (const l of LINKS) if (!ql || l.label.toLowerCase().includes(ql)) out.push({ kind: 'page', label: l.label, sub: `page · ${l.key}`, href: l.href, icon: l.icon });
    return out.slice(0, 30);
  }, [res, q]);

  const go = (it?: Item) => { if (!it) return; onClose(); router.push(it.href); };
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-3 pt-[12vh] backdrop-blur-sm"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div className="glass w-full max-w-xl overflow-hidden rounded-2xl" onClick={(e) => e.stopPropagation()}
            initial={{ y: -12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: -8, scale: 0.98 }} transition={{ type: 'spring', stiffness: 420, damping: 32 }}>
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <Icon name="search" className="text-mute" />
              <input ref={inp} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} placeholder="Ticker, name, contract address, narrative, page…"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
                  if (e.key === 'Enter') go(items[sel]);
                  if (e.key === 'Escape') onClose();
                }}
                className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-mute/70" />
              <kbd className="rounded-md border border-white/10 px-1.5 text-[10px] text-mute">esc</kbd>
            </div>
            <ul className="max-h-[50vh] overflow-y-auto p-1.5">
              {items.map((it, i) => (
                <li key={`${it.kind}-${it.href}-${i}`}>
                  <button onMouseEnter={() => setSel(i)} onClick={() => go(it)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${i === sel ? 'bg-white/[0.07]' : ''}`}>
                    {it.kind === 'token' && it.image !== undefined ? <TokenIcon src={it.image} symbol={it.label} size={22} />
                      : <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-white/5 text-mute"><Icon name={it.icon || 'dashboard'} size={13} /></span>}
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{it.label}</span>
                      {it.sub && <span className="block truncate text-[11px] text-mute">{it.sub}</span>}</span>
                    <span className="text-[10px] uppercase tracking-wider text-mute/70">{it.kind}</span>
                  </button>
                </li>
              ))}
              {!items.length && <li className="p-6 text-center text-mute">No matches</li>}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
