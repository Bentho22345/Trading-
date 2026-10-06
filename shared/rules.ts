// Smart-feed rules engine: a small query language, its parser, evaluator and serializer.
//   (asset_class = FX AND currency IN [JPY, CHF]) OR (tag = "Central Banks" AND impact > 60) NOT source = X
// Adjacent terms are ANDed; "NOT x" negates the next term. Shared by server (alerts, briefs) and browser (builder).
import type { ClusterLike } from './v2';

export type Field =
  | 'asset_class' | 'currency' | 'ticker' | 'tag' | 'source' | 'impact' | 'sentiment' | 'breaking' | 'sources' | 'text' | 'watch' | 'book';
export type Op = '=' | '!=' | '>' | '<' | '>=' | '<=' | '~';
export type Value = string | number | boolean;

export type Node =
  | { type: 'and'; items: Node[] }
  | { type: 'or'; items: Node[] }
  | { type: 'not'; item: Node }
  | { type: 'cmp'; field: Field; op: Op; value: Value }
  | { type: 'in'; field: Field; values: Value[] };

export const FIELDS: { id: Field; label: string; kind: 'enum' | 'number' | 'bool' | 'text'; options?: string[] }[] = [
  { id: 'asset_class', label: 'Asset class', kind: 'enum', options: ['FX', 'Crypto', 'Equities', 'Options', 'Rates', 'Commodities', 'Macro', 'Central Banks', 'Regulation'] },
  { id: 'currency', label: 'Currency', kind: 'enum', options: ['USD', 'EUR', 'JPY', 'GBP', 'CHF', 'AUD', 'CAD', 'NZD', 'CNH', 'MXN', 'XAU'] },
  { id: 'ticker', label: 'Ticker', kind: 'text' },
  { id: 'tag', label: 'Tag', kind: 'text' },
  { id: 'source', label: 'Source', kind: 'text' },
  { id: 'impact', label: 'Impact', kind: 'number' },
  { id: 'sentiment', label: 'Sentiment', kind: 'number' },
  { id: 'sources', label: 'Source count', kind: 'number' },
  { id: 'breaking', label: 'Breaking', kind: 'bool' },
  { id: 'watch', label: 'On watchlist', kind: 'bool' },
  { id: 'book', label: 'In my book', kind: 'bool' },
  { id: 'text', label: 'Text contains', kind: 'text' },
];

const ALIASES: Record<string, Field> = {
  asset_class: 'asset_class', assetclass: 'asset_class', class: 'asset_class', domain: 'asset_class', market: 'asset_class',
  currency: 'currency', ccy: 'currency', ticker: 'ticker', symbol: 'ticker', tag: 'tag', tags: 'tag', source: 'source',
  impact: 'impact', score: 'impact', sentiment: 'sentiment', breaking: 'breaking', sources: 'sources', count: 'sources',
  text: 'text', headline: 'text', watch: 'watch', watchlist: 'watch', book: 'book', portfolio: 'book',
};

// ------------------------------------------------------------------ tokenizer
type Tok = { t: 'lp' | 'rp' | 'lb' | 'rb' | 'comma' | 'op' | 'word' | 'str' | 'num'; v: string; pos: number };

export class RuleError extends Error {
  constructor(msg: string, public pos: number) {
    super(msg);
  }
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { out.push({ t: 'lp', v: ch, pos: i++ }); continue; }
    if (ch === ')') { out.push({ t: 'rp', v: ch, pos: i++ }); continue; }
    if (ch === '[') { out.push({ t: 'lb', v: ch, pos: i++ }); continue; }
    if (ch === ']') { out.push({ t: 'rb', v: ch, pos: i++ }); continue; }
    if (ch === ',') { out.push({ t: 'comma', v: ch, pos: i++ }); continue; }
    const two = src.slice(i, i + 2);
    if (['>=', '<=', '!=', '=='].includes(two)) { out.push({ t: 'op', v: two === '==' ? '=' : two, pos: i }); i += 2; continue; }
    if ('=<>~:'.includes(ch)) { out.push({ t: 'op', v: ch === ':' ? '=' : ch, pos: i++ }); continue; }
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw new RuleError('unterminated string', i);
      out.push({ t: 'str', v: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    const m = /^-?\d+(\.\d+)?(?![\w])/.exec(src.slice(i));
    if (m) { out.push({ t: 'num', v: m[0], pos: i }); i += m[0].length; continue; }
    const w = /^[\w.&$/-]+/.exec(src.slice(i));
    if (w) { out.push({ t: 'word', v: w[0], pos: i }); i += w[0].length; continue; }
    throw new RuleError(`unexpected “${ch}”`, i);
  }
  return out;
}

// ------------------------------------------------------------------ parser
export function parseRule(src: string): Node {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const kw = (k: string) => peek()?.t === 'word' && peek().v.toUpperCase() === k;
  const eat = (t: Tok['t']) => {
    const tok = toks[p];
    if (!tok || tok.t !== t) throw new RuleError(`expected ${t === 'rp' ? '“)”' : t === 'rb' ? '“]”' : t}`, tok?.pos ?? src.length);
    p++;
    return tok;
  };

  const value = (): Value => {
    const tok = toks[p++];
    if (!tok) throw new RuleError('expected a value', src.length);
    if (tok.t === 'num') return Number(tok.v);
    if (tok.t === 'str') return tok.v;
    if (tok.t === 'word') {
      const u = tok.v.toLowerCase();
      if (u === 'true' || u === 'yes') return true;
      if (u === 'false' || u === 'no') return false;
      // allow unquoted multi-word values: tag = Central Banks AND ...
      let v = tok.v;
      while (peek()?.t === 'word' && !['AND', 'OR', 'NOT', 'IN'].includes(peek().v.toUpperCase()) && toks[p + 1]?.t !== 'op' && !(toks[p + 1]?.t === 'word' && toks[p + 1].v.toUpperCase() === 'IN')) v += ` ${toks[p++].v}`;
      return v;
    }
    throw new RuleError('expected a value', tok.pos);
  };

  const primary = (): Node => {
    const tok = peek();
    if (!tok) throw new RuleError('unexpected end of query', src.length);
    if (tok.t === 'lp') {
      p++;
      const n = orExpr();
      eat('rp');
      return n;
    }
    if (tok.t === 'word' || tok.t === 'str') {
      const fieldName = tok.v.toLowerCase();
      const field = ALIASES[fieldName];
      const next = toks[p + 1];
      if (field && next && (next.t === 'op' || (next.t === 'word' && next.v.toUpperCase() === 'IN'))) {
        p += 2;
        if (next.t === 'word') {
          eat('lb');
          const values: Value[] = [];
          while (peek() && peek().t !== 'rb') {
            values.push(value());
            if (peek()?.t === 'comma') p++;
          }
          eat('rb');
          return { type: 'in', field, values };
        }
        return { type: 'cmp', field, op: next.v as Op, value: value() };
      }
      // bare term → text contains
      p++;
      return { type: 'cmp', field: 'text', op: '~', value: tok.v };
    }
    throw new RuleError(`unexpected “${tok.v}”`, tok.pos);
  };

  const notExpr = (): Node => {
    if (kw('NOT')) {
      p++;
      return { type: 'not', item: notExpr() };
    }
    return primary();
  };

  const andExpr = (): Node => {
    const items = [notExpr()];
    while (peek() && peek().t !== 'rp' && !kw('OR')) {
      if (kw('AND')) p++;
      items.push(notExpr());
    }
    return items.length === 1 ? items[0] : { type: 'and', items };
  };

  const orExpr = (): Node => {
    const items = [andExpr()];
    while (kw('OR')) {
      p++;
      items.push(andExpr());
    }
    return items.length === 1 ? items[0] : { type: 'or', items };
  };

  if (!toks.length) throw new RuleError('empty query', 0);
  const n = orExpr();
  if (p < toks.length) throw new RuleError(`unexpected “${toks[p].v}”`, toks[p].pos);
  return n;
}

// ------------------------------------------------------------------ evaluator
const norm = (s: unknown) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const DOMAIN_NORM: Record<string, string> = { fx: 'fx', forex: 'fx', crypto: 'crypto', equities: 'equities', equity: 'equities', stocks: 'equities', options: 'options', rates: 'rates', bonds: 'rates', commodities: 'commodities', macro: 'macro', centralbanks: 'centralbanks', cb: 'centralbanks', regulation: 'regulation' };

export interface EvalCtx { inBook?: boolean; watch?: boolean }

function fieldValues(c: ClusterLike, f: Field, ctx: EvalCtx): (string | number | boolean)[] {
  switch (f) {
    case 'asset_class': return c.domains.map(norm);
    case 'currency': return c.currencies.filter((x) => x.length === 3).map(norm);
    case 'ticker': return c.tickers.map(norm);
    case 'tag': return [...c.tags, ...c.domains].map(norm);
    case 'source': return [c.source, ...c.articles.map((a) => a.source)].map(norm);
    case 'impact': return [c.impact];
    case 'sentiment': return [c.sentiment];
    case 'sources': return [new Set(c.articles.map((a) => a.source)).size];
    case 'breaking': return [!!c.breaking];
    case 'watch': return [!!ctx.watch];
    case 'book': return [!!ctx.inBook];
    case 'text': return [`${c.headline} ${c.summary}`.toLowerCase()];
  }
}

function cmpOne(have: string | number | boolean, op: Op, want: Value, field: Field): boolean {
  if (typeof have === 'number') {
    const w = Number(want);
    if (!Number.isFinite(w)) return false;
    return op === '>' ? have > w : op === '<' ? have < w : op === '>=' ? have >= w : op === '<=' ? have <= w : op === '!=' ? have !== w : have === w;
  }
  if (typeof have === 'boolean') {
    const w = want === true || String(want).toLowerCase() === 'true';
    return op === '!=' ? have !== w : have === w;
  }
  if (field === 'text') return have.includes(String(want).toLowerCase());
  let w = norm(want);
  if (field === 'asset_class') w = DOMAIN_NORM[w] ?? w;
  if (op === '~') return have.includes(w);
  return op === '!=' ? have !== w : have === w;
}

export function evaluate(n: Node, c: ClusterLike, ctx: EvalCtx = {}): boolean {
  switch (n.type) {
    case 'and': return n.items.every((x) => evaluate(x, c, ctx));
    case 'or': return n.items.some((x) => evaluate(x, c, ctx));
    case 'not': return !evaluate(n.item, c, ctx);
    case 'in': {
      const have = fieldValues(c, n.field, ctx);
      return n.values.some((v) => have.some((h) => cmpOne(h, '=', v, n.field)));
    }
    case 'cmp': {
      const have = fieldValues(c, n.field, ctx);
      // "!=" on a multi-valued field means "none of them equals"
      if (n.op === '!=') return !have.some((h) => cmpOne(h, '=', n.value, n.field));
      return have.some((h) => cmpOne(h, n.op, n.value, n.field));
    }
  }
}

// ------------------------------------------------------------------ serializer
const fmtVal = (v: Value) => (typeof v === 'string' ? (/^[\w.&$/-]+$/.test(v) && !['AND', 'OR', 'NOT', 'IN'].includes(v.toUpperCase()) ? v : `"${v.replace(/"/g, "'")}"`) : String(v));

export function serialize(n: Node, parentPrec = 0): string {
  switch (n.type) {
    case 'cmp': return `${n.field} ${n.op} ${fmtVal(n.value)}`;
    case 'in': return `${n.field} IN [${n.values.map(fmtVal).join(', ')}]`;
    case 'not': return `NOT ${serialize(n.item, 3)}`;
    case 'and': {
      const s = n.items.map((x) => serialize(x, 2)).join(' AND ');
      // parenthesise inside OR as well, for readability
      return parentPrec === 1 || parentPrec > 2 ? `(${s})` : s;
    }
    case 'or': {
      const s = n.items.map((x) => serialize(x, 1)).join(' OR ');
      return parentPrec > 1 ? `(${s})` : s;
    }
  }
}

/** Cached compile for hot paths (every incoming cluster × every feed). */
const compiled = new Map<string, Node | null>();
export function compile(query: string): Node | null {
  if (compiled.has(query)) return compiled.get(query)!;
  let n: Node | null = null;
  try {
    n = parseRule(query);
  } catch {
    n = null;
  }
  if (compiled.size > 500) compiled.clear();
  compiled.set(query, n);
  return n;
}

export function matches(query: string, c: ClusterLike, ctx: EvalCtx = {}): boolean {
  const n = compile(query);
  return n ? evaluate(n, c, ctx) : false;
}
