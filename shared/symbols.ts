import type { SymbolMeta } from './types';

export const MAJORS = ['USD', 'EUR', 'JPY', 'GBP', 'CHF', 'AUD', 'CAD', 'NZD'] as const;
export type Major = (typeof MAJORS)[number];

/** Market-convention order: the currency listed first is the base. */
const PRIORITY: Major[] = ['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY'];

/** All 28 crosses of the eight majors, in market convention. */
export const MAJOR_PAIRS: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < PRIORITY.length; i++)
    for (let j = i + 1; j < PRIORITY.length; j++) out.push(PRIORITY[i] + PRIORITY[j]);
  return out;
})();

/** Pairs shown in the ticker strip / heatmap headline set */
export const HEADLINE_FX = ['EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURJPY', 'GBPJPY', 'EURGBP'];
export const EM_FX = ['USDMXN', 'USDZAR', 'USDTRY', 'USDCNH', 'USDINR', 'USDBRL'];

const FX_NAMES: Record<string, string> = {
  USD: 'US Dollar', EUR: 'Euro', JPY: 'Japanese Yen', GBP: 'British Pound', CHF: 'Swiss Franc',
  AUD: 'Australian Dollar', CAD: 'Canadian Dollar', NZD: 'New Zealand Dollar', MXN: 'Mexican Peso',
  ZAR: 'South African Rand', TRY: 'Turkish Lira', CNH: 'Offshore Yuan', INR: 'Indian Rupee', BRL: 'Brazilian Real',
};

export const CCY_COUNTRY: Record<string, string> = {
  USD: 'US', EUR: 'EU', JPY: 'JP', GBP: 'GB', CHF: 'CH', AUD: 'AU', CAD: 'CA', NZD: 'NZ', CNY: 'CN', CNH: 'CN',
};

/** Approximate USD value of one unit of each currency; seeds the mock FX engine. */
export const MOCK_USD_PER: Record<string, number> = {
  USD: 1, EUR: 1.168, GBP: 1.342, AUD: 0.661, NZD: 0.588, CAD: 1 / 1.384, CHF: 1 / 0.797, JPY: 1 / 148.6,
  MXN: 1 / 18.45, ZAR: 1 / 17.55, TRY: 1 / 42.1, CNH: 1 / 7.12, INR: 1 / 88.4, BRL: 1 / 5.34, XAU: 3780,
};

function fxDecimals(pair: string): number {
  if (pair === 'XAUUSD') return 2;
  if (pair.endsWith('JPY') || ['USDINR', 'USDTRY', 'USDMXN', 'USDZAR'].includes(pair)) return pair.endsWith('JPY') ? 3 : 4;
  return 5;
}

export interface MockParams {
  base: number;
  /** annualised volatility, used by the mock random walk */
  vol: number;
}

export interface SymbolDef extends SymbolMeta {
  mock: MockParams;
  coinbase?: string;
  binance?: string;
  finnhub?: string;
  twelvedata?: string;
  alpaca?: string;
  /** Aliases the news tagger uses to link text to this symbol */
  aliases?: string[];
}

const equities: [string, string, number, number, string[]][] = [
  ['AAPL', 'Apple', 232, 0.26, ['Apple', 'iPhone']],
  ['MSFT', 'Microsoft', 512, 0.24, ['Microsoft', 'Azure']],
  ['NVDA', 'Nvidia', 184, 0.48, ['Nvidia']],
  ['AMZN', 'Amazon', 228, 0.32, ['Amazon', 'AWS']],
  ['GOOGL', 'Alphabet', 246, 0.3, ['Alphabet', 'Google']],
  ['META', 'Meta Platforms', 765, 0.36, ['Meta Platforms', 'Facebook', 'Instagram']],
  ['TSLA', 'Tesla', 438, 0.62, ['Tesla']],
  ['AVGO', 'Broadcom', 342, 0.45, ['Broadcom']],
  ['AMD', 'AMD', 162, 0.52, ['Advanced Micro Devices']],
  ['NFLX', 'Netflix', 1210, 0.38, ['Netflix']],
  ['JPM', 'JPMorgan Chase', 312, 0.22, ['JPMorgan', 'JP Morgan']],
  ['GS', 'Goldman Sachs', 790, 0.28, ['Goldman Sachs', 'Goldman']],
  ['BAC', 'Bank of America', 51, 0.26, ['Bank of America']],
  ['XOM', 'Exxon Mobil', 114, 0.24, ['Exxon']],
  ['LLY', 'Eli Lilly', 760, 0.34, ['Eli Lilly', 'Lilly']],
  ['UNH', 'UnitedHealth', 342, 0.34, ['UnitedHealth']],
  ['WMT', 'Walmart', 102, 0.2, ['Walmart']],
  ['BA', 'Boeing', 224, 0.38, ['Boeing']],
  ['DIS', 'Walt Disney', 114, 0.28, ['Disney']],
  ['INTC', 'Intel', 34, 0.5, ['Intel']],
  ['COIN', 'Coinbase Global', 355, 0.75, ['Coinbase']],
  ['MSTR', 'Strategy', 338, 0.85, ['MicroStrategy', 'Strategy Inc']],
  ['PLTR', 'Palantir', 182, 0.7, ['Palantir']],
  ['ARM', 'Arm Holdings', 148, 0.6, ['Arm Holdings']],
  ['SMCI', 'Super Micro', 46, 0.9, ['Super Micro', 'Supermicro']],
  ['ORCL', 'Oracle', 292, 0.4, ['Oracle']],
];

const etfs: [string, string, number, number][] = [
  ['SPY', 'S&P 500 ETF', 662, 0.15],
  ['QQQ', 'Nasdaq 100 ETF', 598, 0.2],
  ['DIA', 'Dow Jones ETF', 462, 0.14],
  ['IWM', 'Russell 2000 ETF', 243, 0.22],
];

const coins: [string, string, number, number, string[], number][] = [
  ['BTC', 'Bitcoin', 112400, 0.5, ['Bitcoin'], 2],
  ['ETH', 'Ethereum', 4150, 0.65, ['Ethereum', 'Ether'], 2],
  ['SOL', 'Solana', 208, 0.85, ['Solana'], 2],
  ['XRP', 'XRP', 2.84, 0.8, ['Ripple', 'XRP'], 4],
  ['BNB', 'BNB', 985, 0.55, ['BNB', 'Binance Coin'], 2],
  ['DOGE', 'Dogecoin', 0.236, 0.95, ['Dogecoin'], 5],
  ['ADA', 'Cardano', 0.81, 0.9, ['Cardano'], 4],
  ['AVAX', 'Avalanche', 29.4, 0.95, ['Avalanche'], 3],
  ['LINK', 'Chainlink', 21.6, 0.9, ['Chainlink'], 3],
  ['LTC', 'Litecoin', 107, 0.75, ['Litecoin'], 2],
  ['DOT', 'Polkadot', 4.02, 0.9, ['Polkadot'], 4],
  ['USDC', 'USD Coin', 1.0, 0.004, ['USDC', 'Circle'], 4],
];

function fxDef(pair: string, major: boolean): SymbolDef {
  const b = pair.slice(0, 3), q = pair.slice(3);
  const base = (MOCK_USD_PER[b] ?? 1) / (MOCK_USD_PER[q] ?? 1);
  const em = !MAJORS.includes(b as Major) || !MAJORS.includes(q as Major);
  return {
    symbol: pair,
    name: `${FX_NAMES[b] ?? b} / ${FX_NAMES[q] ?? q}`,
    assetClass: 'fx',
    decimals: fxDecimals(pair),
    group: HEADLINE_FX.includes(pair) || EM_FX.includes(pair) || pair === 'XAUUSD' ? 'FX' : undefined,
    major,
    mock: { base, vol: pair === 'XAUUSD' ? 0.16 : em ? 0.14 : 0.08 },
    finnhub: pair === 'XAUUSD' ? 'OANDA:XAU_USD' : `OANDA:${b}_${q}`,
    twelvedata: `${b}/${q}`,
  };
}

export const SYMBOLS: SymbolDef[] = [
  ...equities.map(([symbol, name, base, vol, aliases]): SymbolDef => ({
    symbol, name, assetClass: 'equity', decimals: 2, group: 'EQ', mock: { base, vol },
    alpaca: symbol, finnhub: symbol, aliases,
  })),
  ...etfs.map(([symbol, name, base, vol]): SymbolDef => ({
    symbol, name, assetClass: 'etf', decimals: 2, group: 'EQ', mock: { base, vol }, alpaca: symbol, finnhub: symbol,
  })),
  { symbol: 'VIX', name: 'Cboe Volatility Index', assetClass: 'vol', decimals: 2, group: 'EQ', mock: { base: 16.4, vol: 0.9 } },
  ...MAJOR_PAIRS.map((p) => fxDef(p, HEADLINE_FX.includes(p))),
  ...EM_FX.map((p) => fxDef(p, false)),
  fxDef('XAUUSD', false),
  ...coins.map(([symbol, name, base, vol, aliases, decimals]): SymbolDef => ({
    symbol, name, assetClass: 'crypto', decimals, group: 'CRYPTO', mock: { base, vol },
    coinbase: `${symbol}-USD`, binance: `${symbol}USDT`, aliases,
  })),
];

export const SYMBOL_MAP: Record<string, SymbolDef> = Object.fromEntries(SYMBOLS.map((s) => [s.symbol, s]));

export function toMeta(s: SymbolDef): SymbolMeta {
  const { symbol, name, assetClass, decimals, group, major } = s;
  return { symbol, name, assetClass, decimals, group, major };
}

export function isPair(s: string) {
  return SYMBOL_MAP[s]?.assetClass === 'fx';
}
