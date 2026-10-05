import type { Domain } from '../../shared/types';
import { SYMBOLS } from '../../shared/symbols';

// ------------------------------------------------------------------ entities
const EQUITY_TICKERS = new Set(SYMBOLS.filter((s) => s.assetClass === 'equity' || s.assetClass === 'etf').map((s) => s.symbol));
const COINS = new Set(SYMBOLS.filter((s) => s.assetClass === 'crypto').map((s) => s.symbol));
/** tickers that are also common words/abbreviations: only accept them as $cashtags */
const AMBIGUOUS = new Set(['ARM', 'DIS', 'BA', 'GS', 'LINK', 'DOT', 'ADA', 'SOL', 'COIN', 'ALL', 'IT']);

const aliasList: { re: RegExp; symbol: string }[] = [];
for (const s of SYMBOLS) {
  for (const a of s.aliases ?? []) {
    aliasList.push({ re: new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, a === a.toUpperCase() ? '' : 'i'), symbol: s.symbol });
  }
}

const CCY_CODES = 'EUR|USD|JPY|GBP|CHF|AUD|CAD|NZD|MXN|ZAR|TRY|CNH|CNY|INR|BRL|XAU';
const PAIR_RE = new RegExp(`\\b(${CCY_CODES})\\s?[/\\-]?\\s?(${CCY_CODES})\\b`, 'g');
const CCY_NAMES: [RegExp, string][] = [
  [/\baustralian dollar|\baussie\b/i, 'AUD'],
  [/\bcanadian dollar|\bloonie\b/i, 'CAD'],
  [/\bnew zealand dollar|\bkiwi\b/i, 'NZD'],
  [/\b(u\.s\. )?dollar\b|\bgreenback\b|\bDXY\b/i, 'USD'],
  [/\beuro\b|\beurozone\b/i, 'EUR'],
  [/\byen\b/i, 'JPY'],
  [/\bsterling\b|\bthe pound\b|\bcable\b/i, 'GBP'],
  [/\bswiss franc|\bfranc\b/i, 'CHF'],
  [/\byuan\b|\brenminbi\b/i, 'CNH'],
  [/\bmexican peso|\bpeso\b/i, 'MXN'],
  [/\brand\b(?! paul)/i, 'ZAR'],
  [/\blira\b/i, 'TRY'],
  [/\brupee\b/i, 'INR'],
  [/\bbrazilian real\b/i, 'BRL'],
  [/\bgold\b/i, 'XAU'],
];

export const BANK_PATTERNS: { id: string; ccy: string; re: RegExp }[] = [
  { id: 'FED', ccy: 'USD', re: /\b(Fed|FOMC|Federal Reserve|Powell)\b/ },
  { id: 'ECB', ccy: 'EUR', re: /\b(ECB|European Central Bank|Lagarde)\b/ },
  { id: 'BOE', ccy: 'GBP', re: /\b(BoE|BOE|Bank of England|MPC)\b/ },
  { id: 'BOJ', ccy: 'JPY', re: /\b(BoJ|BOJ|Bank of Japan|Ueda)\b/ },
  { id: 'SNB', ccy: 'CHF', re: /\b(SNB|Swiss National Bank)\b/ },
  { id: 'RBA', ccy: 'AUD', re: /\b(RBA|Reserve Bank of Australia)\b/ },
  { id: 'BOC', ccy: 'CAD', re: /\b(BoC|BOC|Bank of Canada)\b/ },
];

// ------------------------------------------------------------------ domains
const DOMAIN_RULES: [Domain, RegExp][] = [
  ['crypto', /\b(crypto|bitcoin|ethereum|stablecoin|blockchain|token|defi|on-chain|altcoin|memecoin|spot etf flows?|miners?|halving|web3|exchange outflows?)\b/i],
  ['options', /\b(options?|implied vol(atility)?|VIX|puts?|calls?|gamma|skew|straddle|open interest|0DTE|put\/call|vol(atility)? (spike|crush))\b/i],
  ['macro', /\b(CPI|PPI|PCE|GDP|payrolls|NFP|inflation|PMI|jobless|retail sales|unemployment|recession|yields?|treasur(y|ies)|bund|gilts?|JGBs?|tariffs?|trade deficit|consumer confidence|housing starts|ISM)\b/i],
  ['centralbanks', /\b(central bank|rate decision|policy rate|rate (hike|cut)s?|hawkish|dovish|minutes|monetary policy)\b/i],
  ['regulation', /\b(SEC|CFTC|regulator|regulatory|lawsuit|sues?|charges?|charged|indictment|ban(s|ned)?|MiCA|legislation|bill|probe|investigation|fine[sd]?|settlement|compliance|antitrust)\b/],
  ['equities', /\b(stocks?|shares|equities|earnings|EPS|revenue|guidance|S&P 500|Nasdaq|Dow|Russell|IPO|buyback|dividend|downgrade|upgrade|price target|market cap)\b/i],
  ['fx', /\b(forex|FX|currenc(y|ies)|exchange rate|intervention|carry trade|pips?)\b/],
];

// ------------------------------------------------------------------ severity + tags
export const SEVERITY: [RegExp, number, string][] = [
  [/\bemergency\b/i, 35, 'Emergency'],
  [/\b(defaults?|defaulted)\b/i, 32, 'Default'],
  [/\b(bankruptcy|chapter 11|insolven)/i, 32, 'Bankruptcy'],
  [/\b(hack(ed)?|exploit(ed)?|drained|breach)\b/i, 32, 'Hack'],
  [/\b(trading halt|halted|halts?)\b/i, 30, 'Halt'],
  [/\bflash crash\b/i, 30, 'Flash crash'],
  [/\b(de-?peg(ged|s)?)\b/i, 30, 'Depeg'],
  [/\bSEC (charges|sues)|\bcharged\b|\bindict/i, 30, 'SEC charges'],
  [/\b(rate decision|raises (interest )?rates|cuts (interest )?rates|hikes|holds rates|leaves rates|rate (hike|cut))\b/i, 30, 'Rate decision'],
  [/\bintervention|intervene/i, 28, 'Intervention'],
  [/\bunexpected(ly)?|surprise/i, 20, 'Surprise'],
  [/\b(sanctions?)\b/i, 20, 'Sanctions'],
  [/\btariffs?\b/i, 18, 'Tariffs'],
  [/\b(ETF (approval|approved|inflows?|outflows?)|spot ETF)\b/i, 18, 'ETF flows'],
  [/\bliquidat(ion|ed)s?\b/i, 18, 'Liquidations'],
  [/\b(CPI|payrolls|NFP|PCE|GDP)\b/, 18, 'Data release'],
  [/\b(plunges?|crash(es)?|tumbles?|soars?|surges?|spikes?)\b/i, 16, 'Big move'],
  [/\b(policy statement|meeting minutes|minutes of|press conference|testimony)\b/i, 14, 'Central bank'],
  [/\b(earnings|beats?|miss(es)?|guidance|outlook)\b/i, 14, 'Earnings'],
  [/\b(acquire[sd]?|acquisition|merger|takeover|buyout)\b/i, 16, 'M&A'],
  [/\brecord high|all-time high|ATH\b/i, 12, 'Record'],
  [/\b(downgrade[sd]?|upgrade[sd]?|price target)\b/i, 10, 'Analyst'],
  [/\b(unusual (options )?activity|block trade|sweep)\b/i, 10, 'Flow'],
];

const POS = /\b(surges?|soars?|jumps?|rall(y|ies)|beats?|record high|upgrades?|approv(al|es|ed)|gains?|rises?|climbs?|rebounds?|strong(er)?|bullish|inflows?|tops?|boosts?|raises guidance|hawkish)\b/gi;
const NEG = /\b(plunges?|slumps?|tumbles?|falls?|drops?|sinks?|miss(es)?|hack(ed)?|defaults?|charges?|halt(ed)?|downgrades?|weak(er)?|bearish|outflows?|fears?|cuts guidance|crash(es)?|slides?|losses|lawsuit|probe|warns?|dovish|liquidat)/gi;

export interface TagResult {
  domains: Domain[];
  tickers: string[];
  currencies: string[];
  tags: string[];
  sentiment: number;
  severity: number;
  banks: string[];
}

export function tagText(text: string, hints: { tickers?: string[]; category?: string } = {}): TagResult {
  const domains = new Set<Domain>();
  const tickers = new Set<string>();
  const currencies = new Set<string>();
  const tags = new Set<string>();
  const banks: string[] = [];

  for (const m of text.matchAll(/\$([A-Z]{1,5})\b/g)) if (EQUITY_TICKERS.has(m[1]) || COINS.has(m[1])) tickers.add(m[1]);
  for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) {
    const t = m[1];
    if (AMBIGUOUS.has(t)) continue;
    if (EQUITY_TICKERS.has(t) || COINS.has(t)) tickers.add(t);
  }
  for (const { re, symbol } of aliasList) if (re.test(text)) tickers.add(symbol);
  for (const t of hints.tickers ?? []) if (EQUITY_TICKERS.has(t) || COINS.has(t)) tickers.add(t);

  for (const m of text.matchAll(PAIR_RE)) {
    if (m[1] === m[2]) continue;
    currencies.add(m[1] + m[2]);
    currencies.add(m[1]);
    currencies.add(m[2]);
  }
  let rest = text;
  for (const [re, c] of CCY_NAMES) {
    if (re.test(rest)) {
      currencies.add(c);
      rest = rest.replace(re, ' ');
    }
  }
  for (const b of BANK_PATTERNS) {
    if (b.re.test(text)) {
      banks.push(b.id);
      currencies.add(b.ccy);
      domains.add('centralbanks');
      domains.add('macro');
    }
  }

  for (const [d, re] of DOMAIN_RULES) if (re.test(text)) domains.add(d);
  for (const t of tickers) domains.add(COINS.has(t) ? 'crypto' : 'equities');
  const hasPair = [...currencies].some((c) => c.length === 6);
  if (hasPair || (currencies.size && !['XAU'].includes([...currencies][0]) && domains.has('centralbanks'))) domains.add('fx');
  if (hints.category === 'crypto') domains.add('crypto');
  if (hints.category === 'forex') domains.add('fx');
  if (hints.category === 'merger') tags.add('M&A');
  if (domains.has('options')) domains.add('equities');
  if (!domains.size) domains.add('macro');

  let severity = 0;
  for (const [re, w, label] of SEVERITY) {
    if (re.test(text)) {
      severity = Math.max(severity, w);
      tags.add(label);
    }
  }
  if (banks.length) tags.add(banks[0]);

  const pos = text.match(POS)?.length ?? 0;
  const neg = text.match(NEG)?.length ?? 0;
  const sentiment = pos + neg ? (pos - neg) / (pos + neg) : 0;

  return {
    domains: [...domains],
    tickers: [...tickers].slice(0, 8),
    currencies: [...currencies].slice(0, 8),
    tags: [...tags].slice(0, 5),
    sentiment: Math.round(sentiment * 100) / 100,
    severity,
    banks,
  };
}

// ------------------------------------------------------------------ similarity
const STOP = new Set(
  'the a an and or of to in on for at by with from as is are was were be been it its this that after before over under amid into than says said say will could would may might new more most less up down vs per report reports reported sources source according us u.s. year week day today amid ahead'.split(' '),
);

/** Canonicalise multi-word entity names so "Bank of Japan" and "BoJ" compare equal. */
const SYNONYMS: [RegExp, string][] = [
  [/\bfederal reserve\b|\bfomc\b/g, 'fed'],
  [/\beuropean central bank\b/g, 'ecb'],
  [/\bbank of england\b/g, 'boe'],
  [/\bbank of japan\b/g, 'boj'],
  [/\bswiss national bank\b/g, 'snb'],
  [/\breserve bank of australia\b/g, 'rba'],
  [/\bbank of canada\b/g, 'boc'],
  [/\bsecurities and exchange commission\b/g, 'sec'],
  [/\bconsumer prices?\b|\binflation\b/g, 'cpi'],
  [/\bbitcoin\b/g, 'btc'],
  [/\bether(eum)?\b/g, 'eth'],
  [/\bs&p 500\b/g, 'spx'],
];

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  let t = text.toLowerCase();
  for (const [re, rep] of SYNONYMS) t = t.replace(re, rep);
  for (let w of t.replace(/[^a-z0-9%$. ]/g, ' ').split(/\s+/)) {
    w = w.replace(/^\$|\.$/g, '');
    if (w.length < 3 || STOP.has(w)) continue;
    // light stemming: raises→raise, rates→rate, jumped→jump, falling→fall
    if (w.length > 5) w = w.replace(/(ing|ed)$/, '');
    if (w.length > 3 && !w.endsWith('ss')) w = w.replace(/s$/, '');
    out.add(w);
  }
  return out;
}

/** Headline similarity: Jaccard, or a damped overlap coefficient so a short headline can match a longer rewrite. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return Math.max(inter / (a.size + b.size - inter), (0.8 * inter) / Math.min(a.size, b.size));
}
