'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { short, usd } from '@/lib/format';
import { getTopFlash, wantsFlash } from '@/lib/topflash';
import { useLive } from '@/lib/live';
import { Copy } from './ui';

/** Full-screen FLASH alert + browser notifications + toast stack for every alert. */
export function FlashOverlay() {
  const [flash, setFlash] = useState<any | null>(null);
  const [toasts, setToasts] = useState<any[]>([]);
  const [tops, setTops] = useState<any[]>([]);
  const lastNotif = useRef(0);
  const notifOk = useRef(false);
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().then((p) => { notifOk.current = p === 'granted'; });
    else notifOk.current = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  }, []);
  useLive(({ ch, data }) => {
    if (ch === 'top_trade') {
      const prefs = getTopFlash();
      if (!wantsFlash(data, prefs)) return;
      setTops((t) => (t.some((x) => x.signature === data.signature) ? t : [data, ...t].slice(0, 4)));
      setTimeout(() => setTops((t) => t.filter((x) => x.signature !== data.signature)), 9000);
      if (prefs.sound) beep(data.side === 'buy' ? 880 : 440);
      // background tab: OS notification, at most one every 3s so a burst doesn't bury the screen
      if (notifOk.current && document.visibilityState !== 'visible' && Date.now() - lastNotif.current > 3000) {
        lastNotif.current = Date.now();
        try {
          const n = new Notification(`Top #${data.rank} wallet ${data.side}s ${data.symbol || short(data.mint)}`, { body: `${(+data.sol || 0).toFixed(2)} SOL · ${short(data.wallet)}`, tag: 'top-trade' });
          n.onclick = () => { window.focus(); location.href = `/token?a=${data.mint}`; };
        } catch { /* */ }
      }
      return;
    }
    if (ch === 'alert' && data.kind === 'wallet') return; // already shown as a top-trade flash card
    if (ch === 'flash') {
      setFlash({ ...data, received: Date.now() / 1000 });
      try { new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=').play().catch(() => {}); } catch { /* */ }
    } else if (ch === 'flash_update') {
      setFlash((f: any) => (f && f.token_address === data.token_address ? { ...f, token: data.token, safety: data.safety } : f));
    } else if (ch === 'alert') {
      setToasts((t) => [data, ...t].slice(0, 5));
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== data.id)), data.kind === 'flash' || data.kind === 'rug' ? 30000 : 12000);
      if (notifOk.current && document.visibilityState !== 'visible' || (notifOk.current && (data.kind === 'flash' || data.kind === 'rug'))) {
        try {
          const n = new Notification(data.title, { body: data.body?.slice(0, 200), tag: data.dedupe, requireInteraction: data.kind === 'flash' });
          n.onclick = () => { window.focus(); if (data.token_address) location.href = `/token?a=${data.token_address}`; };
        } catch { /* */ }
      }
    }
  });
  return (
    <>
      {flash && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3" onClick={() => setFlash(null)}>
          <div className="flash-pulse w-full max-w-2xl rounded-lg border-2 border-flash bg-panel p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-black text-flash">⚡ FLASH</span>
              {flash.is_fixture ? <span className="rounded bg-warn/20 px-1 text-warn">TEST FIXTURE</span> : null}
              <span className="ml-auto text-[11px] text-mute num" title="post time → on your screen">
                {flash.latency_ms != null ? `post→screen ${(flash.latency_ms / 1000).toFixed(2)}s · internal ${flash.internal_ms}ms` : ''}
              </span>
              <button onClick={() => setFlash(null)} className="text-mute hover:text-fg">✕</button>
            </div>
            {flash.kind === 'vip_ca' ? (
              <>
                <p className="mt-2 text-sm"><b>{flash.author}</b> on {flash.source}: “{flash.text}”</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded bg-panel2 p-2">
                  <span className="num break-all text-base font-bold">{flash.token_address}</span>
                  <Copy text={flash.token_address} label="COPY CA" />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {Object.entries(flash.links || {}).map(([k, v]) => <a key={k} href={v as string} target="_blank" rel="noreferrer" className="rounded border border-flash/60 px-3 py-1 font-bold capitalize hover:bg-flash/20">{k} ↗</a>)}
                  <a href={`/token?a=${flash.token_address}`} className="rounded border border-line px-3 py-1">Radar detail →</a>
                </div>
                <div className="mt-3 text-[12px]">
                  {flash.safety ? (
                    <p className={flash.safety.mint_authority || flash.safety.freeze_authority || flash.safety.rugged ? 'text-down font-bold' : 'text-up'}>
                      Safety: mint {flash.safety.mint_authority ? 'ACTIVE ✕' : 'revoked ✓'} · freeze {flash.safety.freeze_authority ? 'ACTIVE ✕' : 'revoked ✓'} ·
                      LP {flash.safety.lp_locked_pct ?? '?'}% · top10 {flash.safety.top10_pct ?? '?'}% · RugCheck {flash.safety.score_normalised ?? '?'}
                    </p>
                  ) : <p className="text-mute">Running safety check…</p>}
                  {flash.token && <p className="num">Price ${flash.token.price_usd} · liq {usd(flash.token.liquidity_usd)} · mcap {usd(flash.token.market_cap)}</p>}
                  <p className="mt-1 text-warn">Copycats launch within seconds — verify the CA matches the official post before buying.</p>
                </div>
              </>
            ) : flash.kind === 'top_cluster' ? (
              <>
                <p className="mt-2 text-lg font-bold">{flash.wallets?.length} top wallets bought {flash.symbol} in {flash.minutes} minutes</p>
                <ul className="mt-2 space-y-0.5 text-[12px] num">
                  {(flash.wallets || []).map((w: any) => <li key={w.wallet} className="flex gap-2"><span className="w-10 text-warn">#{w.rank}</span><span className="flex-1">{short(w.wallet, 6)}</span><span className="text-up">{w.roi != null ? `${w.roi > 0 ? '+' : ''}${Math.round(w.roi * 100)}% ${w.period}` : ''}</span></li>)}
                </ul>
                <div className="mt-3 flex flex-wrap items-center gap-2"><Copy text={flash.token_address} label="COPY CA" /><a href={`/token?a=${flash.token_address}`} className="rounded border border-flash/60 px-3 py-1 font-bold">Open chart →</a></div>
                <p className="mt-2 text-[12px] text-warn">Top wallets also exit fast. Check safety and their sells on the chart before following.</p>
              </>
            ) : (
              <>
                <p className="mt-2 text-lg font-bold">Narrative breakout: {flash.title}</p>
                <p className="text-mute">{flash.vel_5m?.toFixed?.(1)} mentions/min · {flash.zscore}σ above baseline · {flash.sources?.join(', ')}</p>
                <div className="mt-2 flex flex-wrap gap-2">{(flash.tokens || []).map((t: string) => <a key={t} href={`/token?a=${t}`} className="rounded border border-line px-2 py-1 num">{t.slice(0, 6)}… →</a>)}</div>
                <a href="/narratives" className="mt-2 inline-block text-accent">Open narrative board →</a>
              </>
            )}
          </div>
        </div>
      )}
      <div className="pointer-events-none fixed right-3 top-16 z-40 flex w-72 max-w-[calc(100vw-24px)] flex-col gap-1.5">
        {tops.map((t) => (
          <a key={t.signature} href={`/token?a=${t.mint}`} style={{ animation: 'tapein .25s ease-out' }}
            className={`pointer-events-auto rounded-xl border-2 bg-panel/95 p-2 text-[12px] shadow-2xl backdrop-blur ${t.side === 'buy' ? 'border-up' : 'border-down'}`}>
            <div className="flex items-center gap-1.5">
              <span className="font-black text-warn">⚡ TOP #{t.rank}</span>
              {t.is_fixture ? <span className="rounded bg-warn/20 px-1 text-[9px] text-warn">TEST</span> : null}
              <span className={`rounded px-1 text-[10px] font-bold uppercase ${t.side === 'buy' ? 'bg-up/20 text-up' : 'bg-down/20 text-down'}`}>{t.side}</span>
              <b className="truncate">{t.symbol || short(t.mint)}</b>
              <span className="num ml-auto font-bold">{(+t.sol || 0).toFixed(2)} SOL</span>
            </div>
            <div className="num mt-0.5 flex justify-between text-[11px] text-mute"><span>{short(t.wallet)}{t.roi != null ? ` · ${t.roi > 0 ? '+' : ''}${Math.round(t.roi * 100)}% ${t.period}` : ''}</span><span>{t.mcap_usd ? `mcap ${usd(t.mcap_usd)}` : ''}</span></div>
          </a>
        ))}
      </div>
      <div className="fixed bottom-3 right-3 z-40 flex w-80 max-w-[calc(100vw-24px)] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded border bg-panel p-2 shadow-lg ${t.kind === 'rug' ? 'border-down' : t.kind === 'buy' ? 'border-up' : t.kind === 'flash' ? 'border-flash' : 'border-line'}`}>
            <div className="flex gap-2"><b className="flex-1">{t.title}</b><button onClick={() => { setToasts((x) => x.filter((y) => y.id !== t.id)); api(`/api/alerts/${t.id}/ack`, { method: 'POST' }); }} className="text-mute">✕</button></div>
            {t.body && <p className="mt-1 line-clamp-3 text-[11px] text-mute">{t.body}</p>}
            {t.token_address && <a href={`/token?a=${t.token_address}`} className="text-[11px] text-accent">open →</a>}
          </div>
        ))}
      </div>
    </>
  );
}

let ctx: AudioContext | null = null;
function beep(freq: number) {
  try {
    ctx ||= new AudioContext();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = freq; g.gain.setValueAtTime(0.06, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.16);
  } catch { /* autoplay blocked until the first click */ }
}
