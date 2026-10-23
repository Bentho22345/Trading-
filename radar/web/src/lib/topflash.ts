/** Per-browser preferences for top-wallet trade flashes (the Top Traders toolbar edits them, FlashOverlay reads them). */
export type TopFlashPrefs = { on: boolean; minSol: number; side: 'all' | 'buy' | 'sell'; sound: boolean };
const KEY = 'radar:topflash';
const DEF: TopFlashPrefs = { on: true, minSol: 0, side: 'all', sound: true };

export function getTopFlash(): TopFlashPrefs {
  try { return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return DEF; }
}

export function setTopFlash(p: TopFlashPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ }
  window.dispatchEvent(new Event(KEY));
}

export function onTopFlash(fn: () => void) {
  window.addEventListener(KEY, fn);
  return () => window.removeEventListener(KEY, fn);
}

export function wantsFlash(t: any, p = getTopFlash()) {
  return p.on && (+t.sol || 0) >= p.minSol && (p.side === 'all' || p.side === t.side);
}
