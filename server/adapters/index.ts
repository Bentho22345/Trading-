import type { Adapter } from './types';
import { providers, keys, MODE } from '../config';
import { mockQuoteAdapter, mockMarket } from './mock/market';
import { mockCalendarAdapter, mockCryptoMarketAdapter, mockVolAdapter, mockOptionsAdapter, mockEarningsAdapter } from './mock/panels';
import { banksAdapter } from './banks';
import { coinbaseAdapter, binanceAdapter } from './live/crypto';
import { alpacaAdapter } from './live/alpaca';
import { finnhubEquityAdapter, finnhubNewsAdapter, finnhubEarningsAdapter } from './live/finnhub';
import { twelveDataAdapter, finnhubFxAdapter } from './live/fx';
import { rssAdapter, cryptoPanicAdapter } from './live/news';
import { publicCryptoMarketAdapter, cboeVolAdapter, forexFactoryAdapter } from './live/panels';
import { cboeOptionsAdapter } from './live/options';
import { stooqEquityAdapter, stooqFxAdapter, stooqMacroAdapter, nasdaqEarningsAdapter, okxLiquidationsAdapter } from './live/keyless';

type Factory = () => Adapter;

/** provider name -> factory, per stream. Add a provider by implementing Adapter and registering it here. */
const REGISTRY: Record<string, Record<string, Factory>> = {
  crypto: { mock: () => mockQuoteAdapter('crypto'), coinbase: coinbaseAdapter, binance: () => binanceAdapter(false), binanceus: () => binanceAdapter(true) },
  equities: { mock: () => mockQuoteAdapter('equities'), alpaca: alpacaAdapter, finnhub: finnhubEquityAdapter, stooq: stooqEquityAdapter },
  fx: { mock: () => mockQuoteAdapter('fx'), twelvedata: twelveDataAdapter, finnhub: finnhubFxAdapter, stooq: stooqFxAdapter },
  news: { rss: rssAdapter, finnhub: finnhubNewsAdapter, cryptopanic: cryptoPanicAdapter },
  calendar: { mock: mockCalendarAdapter, forexfactory: forexFactoryAdapter },
  earnings: { mock: mockEarningsAdapter, finnhub: finnhubEarningsAdapter, nasdaq: nasdaqEarningsAdapter },
  cryptoMarket: { mock: mockCryptoMarketAdapter, public: publicCryptoMarketAdapter },
  vol: { mock: mockVolAdapter, cboe: cboeVolAdapter },
  options: { mock: mockOptionsAdapter, cboe: cboeOptionsAdapter },
  macro: { mock: () => mockQuoteAdapter('macro'), stooq: stooqMacroAdapter },
};

/** In live mode a missing key or unknown provider falls back to the keyless real source, never to demo data. */
const KEYLESS: Record<string, string> = { crypto: 'coinbase', equities: 'stooq', fx: 'stooq', news: 'rss', calendar: 'forexfactory', earnings: 'nasdaq', cryptoMarket: 'public', vol: 'cboe', options: 'cboe', macro: 'stooq' };
const fallbackFor = (stream: string) => (MODE === 'live' || stream === 'news' ? KEYLESS[stream] : 'mock');

const NEEDS_KEY: Record<string, () => boolean> = {
  alpaca: () => !!(keys.alpacaKey && keys.alpacaSecret),
  finnhub: () => !!keys.finnhub,
  twelvedata: () => !!keys.twelvedata,
  cryptopanic: () => !!keys.cryptopanic,
};

export function buildAdapters(log: { warn: (m: string) => void }): Adapter[] {
  const out: Adapter[] = [banksAdapter()];
  const add = (stream: string, name: string) => {
    let factory = REGISTRY[stream]?.[name];
    if (factory && NEEDS_KEY[name] && !NEEDS_KEY[name]()) {
      const fallback = fallbackFor(stream);
      log.warn(`[config] ${stream}: provider "${name}" needs an API key — falling back to ${fallback}`);
      factory = REGISTRY[stream][fallback];
    }
    if (!factory) {
      const fallback = fallbackFor(stream);
      log.warn(`[config] ${stream}: unknown provider "${name}" — using ${fallback}`);
      factory = REGISTRY[stream][fallback];
    }
    out.push(factory());
  };
  add('crypto', providers.crypto);
  add('equities', providers.equities);
  add('fx', providers.fx);
  const news = providers.news.length ? providers.news : ['rss'];
  for (const n of news) add('news', n);
  add('calendar', providers.calendar);
  add('earnings', providers.earnings);
  add('cryptoMarket', providers.cryptoMarket);
  if (providers.cryptoMarket === 'public') out.push(okxLiquidationsAdapter());
  add('vol', providers.vol);
  add('options', providers.options);
  add('macro', providers.macro);
  if (out.some((a) => a.id === 'cboe')) mockMarket.skip.add('VIX');
  return out;
}

/** Runtime switching (admin console): build the adapter(s) for one stream with a given provider. */
export function buildStream(stream: string, provider: 'mock' | 'live'): Adapter[] {
  const reg = REGISTRY[stream];
  if (!reg) return [];
  if (provider === 'mock') return reg.mock ? [reg.mock()] : [];
  const name = stream === 'news' ? 'rss' : (providers as Record<string, string | string[]>)[stream] as string;
  const pickName = name && name !== 'mock' && reg[name] && (!NEEDS_KEY[name] || NEEDS_KEY[name]()) ? name : KEYLESS[stream];
  return reg[pickName] ? [reg[pickName]()] : [];
}
