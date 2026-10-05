import type { Adapter } from './types';
import { providers, keys } from '../config';
import { mockQuoteAdapter, mockMarket } from './mock/market';
import { mockNewsAdapter } from './mock/news';
import { mockCalendarAdapter, mockCryptoMarketAdapter, mockVolAdapter, mockOptionsAdapter, mockEarningsAdapter } from './mock/panels';
import { banksAdapter } from './banks';
import { coinbaseAdapter, binanceAdapter } from './live/crypto';
import { alpacaAdapter } from './live/alpaca';
import { finnhubEquityAdapter, finnhubNewsAdapter, finnhubEarningsAdapter } from './live/finnhub';
import { twelveDataAdapter, finnhubFxAdapter } from './live/fx';
import { rssAdapter, cryptoPanicAdapter } from './live/news';
import { publicCryptoMarketAdapter, cboeVolAdapter, forexFactoryAdapter } from './live/panels';
import { stooqEquityAdapter, stooqFxAdapter, nasdaqEarningsAdapter, okxLiquidationsAdapter } from './live/keyless';

type Factory = () => Adapter;

/** provider name -> factory, per stream. Add a provider by implementing Adapter and registering it here. */
const REGISTRY: Record<string, Record<string, Factory>> = {
  crypto: { mock: () => mockQuoteAdapter('crypto'), coinbase: coinbaseAdapter, binance: () => binanceAdapter(false), binanceus: () => binanceAdapter(true) },
  equities: { mock: () => mockQuoteAdapter('equities'), alpaca: alpacaAdapter, finnhub: finnhubEquityAdapter, stooq: stooqEquityAdapter },
  fx: { mock: () => mockQuoteAdapter('fx'), twelvedata: twelveDataAdapter, finnhub: finnhubFxAdapter, stooq: stooqFxAdapter },
  news: { mock: mockNewsAdapter, rss: rssAdapter, finnhub: finnhubNewsAdapter, cryptopanic: cryptoPanicAdapter },
  calendar: { mock: mockCalendarAdapter, forexfactory: forexFactoryAdapter },
  earnings: { mock: mockEarningsAdapter, finnhub: finnhubEarningsAdapter, nasdaq: nasdaqEarningsAdapter },
  cryptoMarket: { mock: mockCryptoMarketAdapter, public: publicCryptoMarketAdapter },
  vol: { mock: mockVolAdapter, cboe: cboeVolAdapter },
  options: { mock: mockOptionsAdapter },
};

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
      log.warn(`[config] ${stream}: provider "${name}" needs an API key — falling back to mock`);
      factory = REGISTRY[stream].mock;
    }
    if (!factory) {
      log.warn(`[config] ${stream}: unknown provider "${name}" — using mock`);
      factory = REGISTRY[stream].mock;
    }
    out.push(factory());
  };
  add('crypto', providers.crypto);
  add('equities', providers.equities);
  add('fx', providers.fx);
  const news = providers.news.length ? providers.news : ['mock'];
  for (const n of news) add('news', n);
  add('calendar', providers.calendar);
  add('earnings', providers.earnings);
  add('cryptoMarket', providers.cryptoMarket);
  if (providers.cryptoMarket === 'public') out.push(okxLiquidationsAdapter());
  add('vol', providers.vol);
  add('options', providers.options);
  if (out.some((a) => a.id === 'cboe')) mockMarket.skip.add('VIX');
  return out;
}
