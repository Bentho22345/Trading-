'use client';
import { useEffect, useState } from 'react';
import { getTopFlash, onTopFlash, setTopFlash, type TopFlashPrefs } from '@/lib/topflash';

/** Controls for the full-screen flash shown when a top-ranked wallet trades. */
export function FlashPrefs() {
  const [prefs, setPrefs] = useState<TopFlashPrefs>({ on: true, minSol: 0, side: 'all', sound: true });
  useEffect(() => { setPrefs(getTopFlash()); return onTopFlash(() => setPrefs(getTopFlash())); }, []);
  const save = (p: Partial<TopFlashPrefs>) => setTopFlash({ ...prefs, ...p });
  return (
    <span className="flex items-center gap-1.5">
      <button onClick={() => save({ on: !prefs.on })} title="Flash the screen when a top-500 wallet trades"
        className={`rounded-xl border px-3 py-1.5 text-[12px] transition ${prefs.on ? 'border-warn/50 bg-warn/10 text-warn' : 'border-white/10 text-white/60 hover:text-white'}`}>⚡ Flash {prefs.on ? 'on' : 'off'}</button>
      <select value={prefs.minSol} onChange={(e) => save({ minSol: +e.target.value })} className="rounded-xl border border-white/10 bg-panel2 px-2 py-1.5 text-[12px]" title="Only flash trades at least this big">
        {[0, 0.5, 1, 5, 10].map((v) => <option key={v} value={v}>{v ? `≥ ${v} SOL` : 'any size'}</option>)}
      </select>
      <select value={prefs.side} onChange={(e) => save({ side: e.target.value as TopFlashPrefs['side'] })} className="rounded-xl border border-white/10 bg-panel2 px-2 py-1.5 text-[12px]">
        <option value="all">buys + sells</option><option value="buy">buys only</option><option value="sell">sells only</option>
      </select>
      <button onClick={() => save({ sound: !prefs.sound })} className="px-1 text-[13px] text-white/60 hover:text-white" title="Sound">{prefs.sound ? '🔔' : '🔕'}</button>
    </span>
  );
}
