import type { Adapter, AdapterContext, RawArticle } from '../types';
import { mockMarket } from './market';
import { config } from '../../config';

// Fictional "Demo" wires. Every mock item is flagged demo:true and shows a DEMO chip in the UI.
const SOURCES = ['Demo Wire', 'Demo Markets Desk', 'Demo FX Desk', 'Demo Chain Desk', 'Demo Policy Watch', 'Demo Street'];

const r = (lo: number, hi: number, d = 1) => (lo + Math.random() * (hi - lo)).toFixed(d);
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const chance = (p: number) => Math.random() < p;

interface Story {
  variants: string[];
  summary: string;
  symbol?: string;
  /** % move the related symbol should make in demo mode */
  move?: number;
  sources?: string[];
  weight?: number;
}

const COMPANIES: [string, string][] = [
  ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet'], ['META', 'Meta Platforms'],
  ['TSLA', 'Tesla'], ['AMD', 'AMD'], ['NFLX', 'Netflix'], ['JPM', 'JPMorgan'], ['LLY', 'Eli Lilly'], ['BA', 'Boeing'], ['ORCL', 'Oracle'],
  ['PLTR', 'Palantir'], ['INTC', 'Intel'], ['AVGO', 'Broadcom'], ['UNH', 'UnitedHealth'], ['WMT', 'Walmart'], ['XOM', 'Exxon'],
];
const COINS: [string, string][] = [['BTC', 'Bitcoin'], ['ETH', 'Ether'], ['SOL', 'Solana'], ['XRP', 'XRP'], ['DOGE', 'Dogecoin'], ['AVAX', 'Avalanche'], ['LINK', 'Chainlink']];
const PAIRS: [string, string, string][] = [
  ['EURUSD', 'euro', 'EUR/USD'], ['USDJPY', 'yen', 'USD/JPY'], ['GBPUSD', 'sterling', 'GBP/USD'], ['AUDUSD', 'Australian dollar', 'AUD/USD'],
  ['USDCAD', 'Canadian dollar', 'USD/CAD'], ['USDCHF', 'Swiss franc', 'USD/CHF'], ['NZDUSD', 'New Zealand dollar', 'NZD/USD'],
];
const BANKS = [
  { name: 'Fed', full: 'Federal Reserve', who: 'Powell', ccy: 'USD', pair: 'EURUSD', inv: true },
  { name: 'ECB', full: 'European Central Bank', who: 'Lagarde', ccy: 'EUR', pair: 'EURUSD', inv: false },
  { name: 'BoE', full: 'Bank of England', who: 'the MPC', ccy: 'GBP', pair: 'GBPUSD', inv: false },
  { name: 'BoJ', full: 'Bank of Japan', who: 'Ueda', ccy: 'JPY', pair: 'USDJPY', inv: true },
  { name: 'SNB', full: 'Swiss National Bank', who: 'the SNB board', ccy: 'CHF', pair: 'USDCHF', inv: true },
  { name: 'RBA', full: 'Reserve Bank of Australia', who: 'the RBA board', ccy: 'AUD', pair: 'AUDUSD', inv: false },
  { name: 'BoC', full: 'Bank of Canada', who: 'the BoC', ccy: 'CAD', pair: 'USDCAD', inv: true },
];

const GENERATORS: (() => Story)[] = [
  // ---------------------------------------------------------------- equities
  () => {
    const [t, n] = pick(COMPANIES);
    const beat = chance(0.6);
    const pct = r(3, 11);
    return {
      symbol: t, move: beat ? +pct : -pct,
      variants: beat
        ? [`${n} beats quarterly earnings estimates, raises full-year guidance; shares jump ${pct}% after hours`,
           `${n} tops Q3 earnings forecasts and lifts outlook, stock up ${pct}% in extended trade`,
           `${n} shares jump after earnings beat and guidance raise`]
        : [`${n} misses quarterly earnings estimates, cuts guidance; shares slide ${pct}% after hours`,
           `${n} earnings miss forecasts as company cuts outlook, stock down ${pct}%`,
           `${n} shares slide after earnings miss and weaker guidance`],
      summary: `${n} reported results ${beat ? 'ahead of' : 'below'} consensus. Management ${beat ? 'raised' : 'lowered'} its full-year revenue outlook citing ${pick(['data-center demand', 'consumer spending', 'pricing', 'AI infrastructure orders', 'currency headwinds'])}.`,
    };
  },
  () => {
    const [t, n] = pick(COMPANIES);
    const up = chance(0.5);
    const bank = pick(['Morgan Stanley', 'Goldman Sachs', 'Citi', 'Bernstein', 'UBS', 'Jefferies']);
    return {
      symbol: t, move: up ? +r(1, 3) : -r(1, 3), weight: 1.2,
      variants: [`${bank} ${up ? 'upgrades' : 'downgrades'} ${n} to ${up ? 'overweight' : 'underweight'}, sets new price target`,
                 `${n} ${up ? 'upgraded' : 'downgraded'} at ${bank} on ${up ? 'margin upside' : 'valuation concerns'}`],
      summary: `${bank} analysts ${up ? 'upgraded' : 'downgraded'} ${n} ($${t}) citing ${up ? 'improving margins and product cycle' : 'stretched valuation and slowing growth'}.`,
    };
  },
  () => {
    const [t, n] = pick(COMPANIES);
    const pct = r(4, 9);
    return {
      symbol: t, move: -pct, weight: 0.25,
      variants: [`Trading halted in ${n} shares pending news after ${pct}% plunge`,
                 `${n} stock halted after sudden ${pct}% plunge`,
                 `NYSE/Nasdaq halts ${n} (${t}) trading pending news`],
      summary: `Trading in ${n} was halted following a sharp intraday move. No statement from the company yet.`,
    };
  },
  () => {
    const up = chance(0.55);
    return {
      symbol: 'SPY', move: up ? +r(0.3, 0.8) : -r(0.3, 0.8),
      variants: [`US stocks ${up ? 'rally' : 'slide'} as Treasury yields ${up ? 'ease' : 'climb'}; S&P 500 ${up ? 'up' : 'down'} ${r(0.4, 1.3)}%`,
                 `Wall Street ${up ? 'gains' : 'falls'}: S&P 500 and Nasdaq ${up ? 'rise' : 'drop'} as yields ${up ? 'ease' : 'climb'}`],
      summary: `Equities ${up ? 'advanced' : 'declined'} across sectors with ${pick(['tech', 'semiconductors', 'financials', 'energy'])} leading. The 10-year yield ${up ? 'fell' : 'rose'} ${r(3, 9, 0)} bps.`,
    };
  },
  () => {
    const [t, n] = pick(COMPANIES);
    const [, n2] = pick(COMPANIES.filter(([x]) => x !== t));
    return {
      symbol: t, move: +r(1, 4), weight: 0.4,
      variants: [`${n} in talks to acquire startup in multibillion-dollar acquisition deal, sources say`,
                 `${n} explores acquisition in deal said to value startup target at $${r(5, 30, 0)}B`],
      summary: `${n} is in advanced talks on an acquisition that would expand its ${pick(['cloud', 'AI', 'payments', 'healthcare', 'streaming'])} footprint, competing with ${n2}.`,
    };
  },
  // ---------------------------------------------------------------- options / vol
  () => {
    const [t, n] = pick(COMPANIES);
    const calls = chance(0.6);
    return {
      symbol: t, weight: 0.8,
      variants: [`Unusual options activity: ${n} ${calls ? 'call' : 'put'} volume ${r(3, 8, 0)}x average ahead of catalyst`,
                 `${n} ${calls ? 'call' : 'put'} sweeps lift options volume to ${r(3, 8, 0)} times normal`],
      summary: `Options traders bought ${calls ? 'upside calls' : 'downside puts'} in ${n} ($${t}), with implied volatility rising ${r(2, 8, 0)} points.`,
    };
  },
  () => {
    const up = chance(0.5);
    return {
      symbol: 'VIX', move: up ? +r(6, 14) : -r(4, 8), weight: 0.7,
      variants: [`VIX ${up ? 'spikes' : 'slides'} to ${r(14, 24)} as ${up ? 'hedging demand' : 'vol sellers'} ${up ? 'surges' : 'return'}; put/call ratio ${up ? 'jumps' : 'eases'}`,
                 `Volatility index ${up ? 'spikes' : 'slides'}: VIX term structure ${up ? 'flattens' : 'steepens'}`],
      summary: `Equity volatility ${up ? 'rose' : 'fell'} sharply. ${up ? 'Front-month VIX futures narrowed the gap to later expiries.' : 'Contango in VIX futures steepened.'}`,
    };
  },
  // ---------------------------------------------------------------- fx / macro
  () => {
    const [pair, name, disp] = pick(PAIRS);
    const up = chance(0.5);
    return {
      symbol: pair, move: up ? +r(0.2, 0.6, 2) : -r(0.2, 0.6, 2),
      variants: [`${disp} ${up ? 'climbs' : 'falls'} to ${up ? 'session high' : 'session low'} as ${name} ${up ? 'strengthens' : 'weakens'} on rate differentials`,
                 `${name[0].toUpperCase() + name.slice(1)} ${up ? 'strengthens' : 'weakens'}: ${disp} ${up ? 'climbs' : 'falls'} on shifting rate differentials`],
      summary: `${disp} moved ${r(30, 90, 0)} pips as traders repriced the rate path. Options show ${pick(['elevated', 'subdued', 'rising'])} demand for protection.`,
    };
  },
  () => {
    const b = pick(BANKS);
    return {
      symbol: b.pair, move: (b.inv ? -1 : 1) * +r(0.1, 0.3, 2), weight: 1.1,
      variants: [`${b.who.startsWith('the ') ? `${b.name} board` : `${b.name}'s ${b.who}`} says policy must stay ${pick(['restrictive', 'data dependent', 'flexible'])}; ${b.ccy} edges higher`,
                 `${b.who.startsWith('the ') ? `${b.name} officials signal` : `${b.who} (${b.name}) signals`} patience on rates in speech, ${b.ccy} firms`],
      summary: `Speaking at a conference, ${b.who} said the ${b.full} will ${pick(['keep policy restrictive for some time', 'move carefully', 'respond to incoming data'])}. Markets trimmed bets on near-term easing.`,
    };
  },
  () => {
    const b = pick(BANKS);
    const act = pick(['cuts rates by 25 bps', 'holds rates steady', 'raises rates by 25 bps']);
    const dir = act.startsWith('cuts') ? -1 : act.startsWith('raises') ? 1 : 0;
    return {
      symbol: b.pair, move: (b.inv ? -1 : 1) * dir * +r(0.3, 0.7, 2), weight: 0.25,
      variants: [`${b.name} ${act} in rate decision; ${b.ccy} ${dir > 0 ? 'jumps' : dir < 0 ? 'slides' : 'steady'}`,
                 `${b.full} ${act}, statement flags ${pick(['upside inflation risks', 'slowing growth', 'balanced risks'])}`,
                 `Rate decision: ${b.name} ${act}`],
      summary: `The ${b.full} announced its policy rate decision. The statement pointed to ${pick(['sticky services inflation', 'cooling labour markets', 'tariff-related uncertainty'])}.`,
    };
  },
  () => {
    const hot = chance(0.5);
    const a = r(2.6, 3.4), c = (+a + (hot ? -0.1 : 0.1)).toFixed(1);
    return {
      symbol: 'EURUSD', move: hot ? -0.35 : +0.35, weight: 0.5,
      variants: [`US CPI rises ${a}% y/y vs ${c}% expected; Treasury yields ${hot ? 'jump' : 'fall'}, dollar ${hot ? 'rallies' : 'slides'}`,
                 `US inflation ${hot ? 'hotter' : 'cooler'} than expected: CPI ${a}% y/y (consensus ${c}%)`,
                 `CPI surprise: US consumer prices ${hot ? 'accelerate' : 'cool'} more than forecast, yields ${hot ? 'jump' : 'fall'}`],
      summary: `Headline CPI printed ${a}% against a ${c}% consensus. Core inflation ${hot ? 'also exceeded' : 'came in below'} forecasts, shifting Fed pricing.`,
    };
  },
  () => {
    const [pair, name, disp] = pick([PAIRS[1], PAIRS[5]]);
    return {
      symbol: pair, move: pair === 'USDJPY' ? -1.1 : -0.8, weight: 0.12,
      variants: [`${name === 'yen' ? 'Japan' : 'Switzerland'} suspected of FX intervention as ${disp} plunges`,
                 `${disp} plunges on suspected intervention; officials decline to comment`],
      summary: `A sharp, sudden move in ${disp} sparked speculation of official intervention to support the ${name}.`,
    };
  },
  () => ({
    weight: 0.8,
    variants: [`Eurozone PMI ${pick(['beats', 'misses'])} forecasts as ${pick(['manufacturing', 'services'])} ${pick(['stabilises', 'contracts'])}`],
    summary: `Flash PMI data for the euro area came in at ${r(46, 53)}, with Germany ${pick(['lagging', 'leading'])} the bloc.`,
    symbol: 'EURUSD',
  }),
  () => ({
    weight: 0.6,
    variants: [`US 10-year Treasury yield ${pick(['climbs', 'drops'])} to ${r(3.9, 4.6, 2)}% ahead of auction`, `Treasuries: 10-year yield ${pick(['climbs', 'drops'])} ahead of auction`],
    summary: `Bond markets moved ahead of supply and data. Curve ${pick(['steepened', 'flattened'])} with 2s10s at ${r(10, 60, 0)} bps.`,
  }),
  () => {
    const lvl = r(3700, 3950, 0);
    return {
    symbol: 'XAUUSD', move: +r(0.4, 1.2), weight: 0.6,
    variants: [`Gold rises to record high near $${lvl} as real yields ease`, `Gold hits record high near $${lvl} as dollar softens and real yields ease`],
    summary: `Spot gold extended gains with central-bank buying and ETF inflows cited as support.`,
  };
  },
  // ---------------------------------------------------------------- crypto
  () => {
    const [t, n] = pick(COINS);
    const up = chance(0.55);
    const pct = r(3, 9);
    const liq = r(150, 600, 0);
    return {
      symbol: t, move: up ? +pct : -pct,
      variants: [`${n} ${up ? 'surges' : 'tumbles'} ${pct}% as ${up ? 'short liquidations' : 'long liquidations'} top $${liq}M`,
                 `${n} ${up ? 'surges' : 'tumbles'} ${pct}% in an hour; liquidations top $${liq}M across exchanges`,
                 `Crypto liquidations top $${liq}M as ${n} ${up ? 'surges' : 'tumbles'} ${pct}%`],
      summary: `${n} (${t}) moved sharply with perpetual funding ${up ? 'flipping positive' : 'turning negative'} and open interest ${up ? 'rising' : 'falling'}.`,
    };
  },
  () => {
    const inflow = chance(0.6);
    const coin = chance(0.7) ? ['BTC', 'Bitcoin'] : ['ETH', 'Ether'];
    const amt = r(200, 900, 0);
    return {
      symbol: coin[0], move: inflow ? +r(0.5, 1.5) : -r(0.5, 1.5),
      variants: [`Spot ${coin[1]} ETFs log $${amt}M net ${inflow ? 'inflows' : 'outflows'}, ${inflow ? 'longest streak' : 'biggest day'} since ${pick(['July', 'March', 'January'])}`,
                 `Spot ${coin[1]} ETF net ${inflow ? 'inflows' : 'outflows'} hit $${amt}M in a day`],
      summary: `US-listed spot ${coin[1]} ETFs saw net ${inflow ? 'inflows' : 'outflows'} led by the largest issuers. Exchange balances ${inflow ? 'fell' : 'rose'}.`,
    };
  },
  () => {
    const [t, n] = pick(COINS.slice(2));
    const amt = r(40, 220, 0);
    return {
      symbol: t, move: -r(6, 14), weight: 0.12,
      variants: [`DeFi protocol on ${n} exploited, $${amt}M drained in hack`,
                 `Hack drains $${amt}M from ${n}-based DeFi protocol; ${t} slides`,
                 `${n} DeFi exploit: attackers drain funds, protocol pauses contracts`],
      summary: `Blockchain security firms flagged an exploit draining funds from a lending protocol on ${n}. The team has paused contracts.`,
    };
  },
  () => ({
    symbol: 'COIN', move: -r(3, 7), weight: 0.18,
    variants: [`SEC charges crypto exchange with operating unregistered securities platform`, `SEC sues crypto exchange over unregistered securities; industry shares fall`],
    summary: `The Securities and Exchange Commission filed charges against a crypto trading venue. Coinbase and crypto-linked equities traded lower.`,
  }),
  () => ({
    weight: 0.7,
    variants: ((b: string) => [`Stablecoin supply climbs to record $${b}B as USDC and USDT expand`, `Record stablecoin supply: USDT and USDC market cap hits $${b}B`])(r(280, 320, 0)),
    summary: `Aggregate stablecoin market capitalization reached a record, a sign of fresh liquidity entering crypto markets.`,
    symbol: 'BTC',
  }),
  () => ({
    weight: 0.6,
    variants: [`Bitcoin perpetual funding rates turn ${pick(['negative', 'elevated'])} on major exchanges`, `BTC funding rates ${pick(['flip negative', 'spike'])} as open interest climbs`],
    summary: `Derivatives data show positioning ${pick(['stretched long', 'leaning short'])} with open interest near record highs.`,
    symbol: 'BTC',
  }),
  () => ({
    weight: 0.5,
    variants: [`EU regulators publish MiCA guidance for stablecoin issuers`, `MiCA: European regulator issues new stablecoin guidance`],
    summary: `The guidance clarifies reserve and disclosure requirements for stablecoin issuers operating in the EU.`,
  }),
];

function weightedPick(): Story {
  // weights stored on the story itself; sample a few and choose proportionally
  const cands = Array.from({ length: 3 }, () => pick(GENERATORS)());
  const total = cands.reduce((s, c) => s + (c.weight ?? 1), 0);
  let x = Math.random() * total;
  for (const c of cands) if ((x -= c.weight ?? 1) <= 0) return c;
  return cands[0];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);

export function mockNewsAdapter(): Adapter {
  let timer: NodeJS.Timeout | null = null;
  const pending = new Set<NodeJS.Timeout>();
  let stopped = false;

  const emitStory = (ctx: AdapterContext, s: Story, at?: number, apply = true) => {
    const srcs = [...SOURCES].sort(() => Math.random() - 0.5);
    const followers = chance(0.4) ? 1 + Math.floor(Math.random() * Math.min(4, s.variants.length + 2)) : 0;
    const emitOne = (i: number, receivedAt?: number) => {
      const headline = s.variants[i % s.variants.length] + (i >= s.variants.length ? ` — ${pick(['update', 'report', 'sources'])}` : '');
      const now = receivedAt ?? Date.now();
      const a: RawArticle = {
        sourceId: slug(srcs[i % srcs.length]), source: srcs[i % srcs.length], headline, summary: s.summary,
        url: `https://example.com/pulse-demo/${slug(headline)}-${now.toString(36)}`, publishedAt: now - Math.floor(Math.random() * 20_000),
        demo: true, receivedAt,
      };
      ctx.emitNews(a);
    };
    emitOne(0, at);
    if (apply && s.symbol && s.move) mockMarket.impulse(s.symbol, s.move * 0.5, 30 + Math.floor(Math.random() * 40));
    for (let i = 1; i <= followers; i++) {
      if (at) {
        emitOne(i, at + i * 40_000);
        continue;
      }
      const t = setTimeout(() => {
        pending.delete(t);
        if (!stopped) emitOne(i);
      }, 4000 + Math.random() * 60_000 * i);
      pending.add(t);
    }
  };

  return {
    id: 'mock-news',
    stream: 'news',
    provider: 'Demo headline generator',
    mock: true,
    delayedMin: 0,
    staleAfterMs: 120_000,
    start(ctx) {
      stopped = false;
      // Backfill the last ~2 hours so the feed is populated on first load.
      const now = Date.now();
      if (ctx.newsCount() < 15) for (let i = 30; i > 0; i--) emitStory(ctx, weightedPick(), Math.round(now - i * 4 * 60_000 - Math.random() * 60_000), false);
      ctx.hub.touch('news');
      const loop = () => {
        if (stopped) return;
        emitStory(ctx, weightedPick());
        ctx.hub.touch('news');
        timer = setTimeout(loop, (4000 + Math.random() * 9000) / Math.max(0.1, config.mockNewsRate));
      };
      timer = setTimeout(loop, 2500);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      pending.forEach(clearTimeout);
      pending.clear();
    },
  };
}
