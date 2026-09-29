import 'dotenv/config';

const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== '' && process.env[k] !== undefined ? v : d;
};

/**
 * PULSE_MODE:
 *   mock (default) – every stream uses the demo adapters unless a provider is set explicitly
 *                    or an API key for a keyed provider is present ("auto").
 *   live           – "auto" streams also pick keyless live providers (Coinbase, RSS, Cboe…).
 */
export const MODE = env('PULSE_MODE', 'mock') === 'live' ? 'live' : 'mock';

export const keys = {
  finnhub: env('FINNHUB_API_KEY'),
  twelvedata: env('TWELVEDATA_API_KEY'),
  alpacaKey: env('ALPACA_API_KEY_ID'),
  alpacaSecret: env('ALPACA_API_SECRET_KEY'),
  cryptopanic: env('CRYPTOPANIC_API_KEY'),
  anthropic: env('ANTHROPIC_API_KEY'),
};

function pick(name: string, auto: () => string): string {
  const v = env(name, 'auto').toLowerCase();
  return v === 'auto' || v === '' ? auto() : v;
}

export const providers = {
  crypto: pick('CRYPTO_PROVIDER', () => (MODE === 'live' ? 'coinbase' : 'mock')),
  equities: pick('EQUITY_PROVIDER', () =>
    keys.alpacaKey && keys.alpacaSecret ? 'alpaca' : keys.finnhub ? 'finnhub' : 'mock'),
  fx: pick('FX_PROVIDER', () => (keys.twelvedata ? 'twelvedata' : keys.finnhub ? 'finnhub' : 'mock')),
  news: env('NEWS_PROVIDERS', 'auto').toLowerCase() === 'auto'
    ? [
        ...(MODE === 'live' ? ['rss'] : []),
        ...(keys.finnhub ? ['finnhub'] : []),
        ...(keys.cryptopanic ? ['cryptopanic'] : []),
      ].concat(MODE === 'live' || keys.finnhub || keys.cryptopanic ? [] : ['mock'])
    : env('NEWS_PROVIDERS').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
  calendar: pick('CALENDAR_PROVIDER', () => (MODE === 'live' ? 'forexfactory' : 'mock')),
  earnings: pick('EARNINGS_PROVIDER', () => (keys.finnhub ? 'finnhub' : 'mock')),
  cryptoMarket: pick('CRYPTO_MARKET_PROVIDER', () => (MODE === 'live' ? 'public' : 'mock')),
  vol: pick('VOL_PROVIDER', () => (MODE === 'live' ? 'cboe' : 'mock')),
  options: pick('OPTIONS_PROVIDER', () => 'mock'),
};

export const config = {
  port: num('PORT', num('PULSE_WORKER_PORT', 4000)),
  host: env('PULSE_WORKER_HOST', '0.0.0.0'),
  dbPath: env('DATABASE_PATH', './data/pulse.db'),
  corsOrigin: env('CORS_ORIGIN', '*'),
  breakingThreshold: num('BREAKING_THRESHOLD', 75),
  retentionDays: num('NEWS_RETENTION_DAYS', 7),
  rssFeeds: env('RSS_FEEDS'),
  rssIntervalSec: num('RSS_POLL_SECONDS', 60),
  finnhubNewsIntervalSec: num('FINNHUB_NEWS_POLL_SECONDS', 60),
  twelvedataIntervalSec: num('TWELVEDATA_POLL_SECONDS', 120),
  equityDelayMin: num('EQUITY_DELAY_MINUTES', 0),
  fxDelayMin: num('FX_DELAY_MINUTES', 0),
  cboeDelayMin: 15,
  aiModel: env('ANTHROPIC_MODEL', 'claude-opus-5-5'),
  aiMinImpact: num('AI_MIN_IMPACT', 50),
  aiMaxPerHour: num('AI_MAX_PER_HOUR', 40),
  mockNewsRate: num('MOCK_NEWS_RATE', 1),
};
