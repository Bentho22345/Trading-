import type Anthropic from '@anthropic-ai/sdk';
import type { Copilot, Position } from '../shared/v2';
import { SYMBOL_MAP } from '../shared/symbols';
import { anthropic, budgetLeft, recordUsage, SUPPORTS_FALLBACK, cacheGet, cacheSet, hashKey } from './ai/client';
import { config } from './config';
import { docs } from './docs';
import type { Hub } from './hub';
import type { NewsPipeline } from './news/pipeline';
import type { BriefService } from './brief/service';
import { bad, type Router } from './router';
import type { V2Feature } from './v2';

type Cite = NonNullable<Copilot['citations']>[number];

const TOOLS = [
  { name: 'search_articles', description: 'Search PULSE news clusters (headline, summary, tickers, tags). Returns id, headline, source, url, time, impact, tldr.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'keywords, ticker or currency' }, hours: { type: 'number', description: 'look-back window in hours (default 24)' } }, required: ['query'], additionalProperties: false } },
  { name: 'get_quotes', description: 'Latest quotes for symbols (price, change vs reference, source, delay).', input_schema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'], additionalProperties: false } },
  { name: 'get_history', description: 'Minute price history for a symbol (downsampled), for describing intraday moves.', input_schema: { type: 'object', properties: { symbol: { type: 'string' }, minutes: { type: 'number' } }, required: ['symbol'], additionalProperties: false } },
  { name: 'get_calendar', description: 'Economic calendar events in a window, optionally filtered by currency.', input_schema: { type: 'object', properties: { hoursAhead: { type: 'number' }, hoursBack: { type: 'number' }, currency: { type: 'string' } }, additionalProperties: false } },
  { name: 'get_intel', description: 'PULSE intelligence blocks: regime, ratePaths, themes, cot, prediction, social, correlation, surprise, auctions, filings.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } },
  { name: 'get_positions', description: "The user's imported positions and current exposure.", input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_brief', description: "Today's latest morning brief (headline, take, top stories).", input_schema: { type: 'object', properties: {}, additionalProperties: false } },
] as const;

const SYSTEM = `You are "Ask Pulse", the copilot inside the PULSE markets terminal.
Answer ONLY from data returned by your tools (PULSE's own articles, quotes, calendar and intelligence). If the tools don't contain the answer, say so plainly.
Cite every factual claim inline with [c:ID] using the id fields from tool results (article ids, "quote:SYMBOL", "event:ID", "intel:KEY"). Mention timestamps for prices and note delayed data.
Be concise (≤ 180 words unless asked for more), use short paragraphs or bullets. Never give investment advice or trade recommendations.`;

export function copilotFeature(hub: Hub, pipeline: NewsPipeline, briefs: BriefService): V2Feature {
  async function runTool(name: string, input: Record<string, unknown>, cites: Map<string, Cite>): Promise<unknown> {
    switch (name) {
      case 'search_articles': {
        const q = String(input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const since = Date.now() - (Number(input.hours) || 24) * 3600_000;
        const res = pipeline.recent(1500).filter((c) => c.receivedAt >= since).filter((c) => {
          const hay = `${c.headline} ${c.summary} ${c.tickers.join(' ')} ${c.currencies.join(' ')} ${c.tags.join(' ')}`.toLowerCase();
          return q.every((w) => hay.includes(w.replace(/^\$/, '')));
        }).sort((a, b) => b.impact - a.impact).slice(0, 12);
        for (const c of res) cites.set(c.id, { id: c.id, label: c.headline, url: c.url, ts: c.publishedAt, kind: 'story' });
        return res.map((c) => ({ id: c.id, headline: c.headline, source: c.source, sources: c.articles.length, url: c.url, time: new Date(c.publishedAt).toISOString(), impact: c.impact, tldr: c.tldr ?? c.summary.slice(0, 200), tickers: c.tickers, currencies: c.currencies }));
      }
      case 'get_quotes': {
        return (input.symbols as string[] ?? []).slice(0, 20).map((s) => String(s).toUpperCase().replace('/', '')).map((s) => {
          const q = hub.quotes.get(s);
          if (!q) return { symbol: s, error: 'no quote' };
          cites.set(`quote:${s}`, { id: `quote:${s}`, label: `${s} quote`, ts: q.ts, kind: 'quote' });
          return { id: `quote:${s}`, symbol: s, price: q.price, changePct: +q.changePct.toFixed(3), change: q.change, ref: q.ref, time: new Date(q.ts).toISOString(), source: q.source, delayedMin: q.delayedMin, demo: !!q.mock, basisPoints: SYMBOL_MAP[s]?.bp ? +(q.change * 100).toFixed(1) : undefined };
        });
      }
      case 'get_history': {
        const s = String(input.symbol ?? '').toUpperCase();
        const pts = hub.historySince(s, Date.now() - Math.min(1560, Number(input.minutes) || 240) * 60_000, 60);
        cites.set(`quote:${s}`, { id: `quote:${s}`, label: `${s} history`, ts: Date.now(), kind: 'quote' });
        return { id: `quote:${s}`, symbol: s, points: pts.map((p) => [new Date(p.t).toISOString().slice(11, 16), p.c]) };
      }
      case 'get_calendar': {
        const now = Date.now();
        const ev = hub.calendar.filter((e) => e.time >= now - (Number(input.hoursBack) || 12) * 3600_000 && e.time <= now + (Number(input.hoursAhead) || 48) * 3600_000 && (!input.currency || e.currency === String(input.currency).toUpperCase())).slice(0, 40);
        for (const e of ev) cites.set(`event:${e.id}`, { id: `event:${e.id}`, label: `${e.currency} ${e.title}`, ts: e.time, kind: 'event' });
        return ev.map((e) => ({ id: `event:${e.id}`, time: new Date(e.time).toISOString(), currency: e.currency, title: e.title, importance: e.importance, consensus: e.consensus, previous: e.previous, actual: e.actual, unit: e.unit }));
      }
      case 'get_intel': {
        const b = hub.intel.get(String(input.key) as never);
        if (!b) return { error: 'no such intel block yet' };
        cites.set(`intel:${b.key}`, { id: `intel:${b.key}`, label: `${b.key} (${b.source})`, ts: b.ts, kind: 'intel' });
        return { id: `intel:${b.key}`, source: b.source, cadence: b.cadence, demo: !!b.mock, asOf: b.asOf, note: b.note, data: JSON.stringify(b.data).slice(0, 6000) };
      }
      case 'get_positions': return docs.list<Position>('positions').map((p) => ({ symbol: p.symbol, qty: p.qty, avgPrice: p.avgPrice, price: hub.quotes.get(p.symbol)?.price ?? null }));
      case 'get_brief': {
        const m = briefs.latest('morning');
        const b = m ? briefs.get(m.id) : null;
        if (!b) return { error: 'no brief yet' };
        cites.set(`brief:${b.id}`, { id: `brief:${b.id}`, label: `Brief: ${b.headline}`, ts: b.createdAt, kind: 'brief' });
        return { id: `brief:${b.id}`, headline: b.headline, take: b.take.text, date: b.date };
      }
    }
    return { error: 'unknown tool' };
  }

  async function ask(history: Copilot[], explain?: { kind: string; ref: string; label: string }): Promise<Copilot & { usage?: unknown }> {
    if (!anthropic) return { role: 'assistant', text: '', citations: [] };
    if (budgetLeft() < 4000) return { role: 'assistant', text: "Today's AI token budget is used up. Raise it in Settings → AI & budget, or try again tomorrow.", citations: [] };
    const cites = new Map<string, Cite>();
    const msgs: Anthropic.MessageParam[] = history.slice(-10).map((m) => ({ role: m.role, content: m.text }));
    if (explain) msgs.push({ role: 'user', content: `Explain this ${explain.kind} in plain English: what it is, why it matters now, and what to watch. Item: ${explain.label} (ref ${explain.ref}).` });
    const cacheKey = hashKey('copilot', msgs, Math.floor(Date.now() / 120_000));
    const hit = cacheGet<Copilot>(cacheKey, 120_000);
    if (hit) return hit;
    for (let turn = 0; turn < 6; turn++) {
      const params: Record<string, unknown> = {
        model: config.aiModel, max_tokens: 4000, system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }], tools: TOOLS, tool_choice: { type: 'auto' }, messages: msgs,
        output_config: { effort: 'low' },
      };
      if (SUPPORTS_FALLBACK.test(config.aiModel)) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
      const res = (await anthropic.beta.messages.create(params as never)) as Anthropic.Beta.BetaMessage;
      recordUsage('copilot', config.aiModel, res.usage);
      if (res.stop_reason === 'refusal') return { role: 'assistant', text: "I can't help with that one.", citations: [] };
      msgs.push({ role: 'assistant', content: res.content as never });
      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) {
        const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
        const used = [...text.matchAll(/\[c:([^\]]+)\]/g)].map((m) => m[1]);
        const out: Copilot = { role: 'assistant', text, citations: [...new Set(used)].map((id) => cites.get(id)).filter((x): x is Cite => !!x) };
        cacheSet(cacheKey, out);
        return out;
      }
      const results = await Promise.all(uses.map(async (u) => {
        try {
          return { type: 'tool_result' as const, tool_use_id: u.id, content: JSON.stringify(await runTool(u.name, u.input as Record<string, unknown>, cites)).slice(0, 20_000) };
        } catch (e) {
          return { type: 'tool_result' as const, tool_use_id: u.id, content: `error: ${(e as Error).message}`, is_error: true };
        }
      }));
      msgs.push({ role: 'user', content: results });
    }
    return { role: 'assistant', text: 'That took too many steps — try a narrower question.', citations: [] };
  }

  return {
    routes(r: Router) {
      r.get('/api/copilot/status', () => ({ enabled: !!anthropic, budgetLeft: budgetLeft(), model: config.aiModel }));
      r.post('/api/copilot', async ({ body }) => {
        const b = await body<{ messages?: Copilot[]; explain?: { kind: string; ref: string; label: string } }>();
        if (!anthropic) return { connect: true, message: { role: 'assistant', text: '', citations: [] } };
        if (!b.messages?.length && !b.explain) bad('ask a question');
        return { message: await ask(b.messages ?? [], b.explain) };
      });
    },
  };
}
