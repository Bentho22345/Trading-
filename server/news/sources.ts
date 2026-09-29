/**
 * Source credibility (0..1) feeds the impact score. Official primary sources rank highest.
 * Unknown sources default to 0.55.
 */
const CREDIBILITY: Record<string, number> = {
  fed: 1, ecb: 1, boe: 1, boj: 1, snb: 1, rba: 1, boc: 1, sec: 0.95, cftc: 0.9, bls: 1, bea: 1,
  reuters: 0.92, bloomberg: 0.92, 'wall street journal': 0.9, wsj: 0.9, 'financial times': 0.9, cnbc: 0.8,
  marketwatch: 0.75, 'yahoo': 0.65, 'seeking alpha': 0.6, benzinga: 0.62, coindesk: 0.78, 'the block': 0.75,
  cointelegraph: 0.65, decrypt: 0.65, fxstreet: 0.65, forexlive: 0.72,
  // demo-mode wires (clearly marked DEMO in the UI)
  'demo wire': 0.9, 'demo markets desk': 0.8, 'demo fx desk': 0.78, 'demo chain desk': 0.7, 'demo policy watch': 0.95, 'demo street': 0.6,
};

export function credibility(source: string, sourceId?: string): number {
  const keys = [sourceId, source].filter(Boolean).map((s) => s!.toLowerCase());
  for (const k of keys) {
    if (CREDIBILITY[k] !== undefined) return CREDIBILITY[k];
    for (const [name, v] of Object.entries(CREDIBILITY)) if (k.includes(name)) return v;
  }
  return 0.55;
}
