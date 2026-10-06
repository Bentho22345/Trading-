// "Does this story touch the user's book?" — held tickers, FX pairs and simple correlated proxies.
export function touchesHeld(c: { tickers: string[]; currencies: string[] }, held: Set<string>): boolean {
  if (!held.size) return false;
  if (c.tickers.some((t) => held.has(t))) return true;
  for (const p of held) {
    if (/^[A-Z]{6}$/.test(p) && (c.currencies.includes(p) || (c.currencies.includes(p.slice(0, 3)) && c.currencies.includes(p.slice(3))))) return true;
  }
  if (held.has('BTC') && c.tickers.some((t) => t === 'COIN' || t === 'MSTR')) return true;
  if ((held.has('GOLD') || held.has('XAUUSD')) && c.currencies.includes('XAU')) return true;
  if ([...held].some((h) => /^US\d+Y$/.test(h)) && c.tickers.some((t) => /^US\d+Y$/.test(t))) return true;
  return false;
}
