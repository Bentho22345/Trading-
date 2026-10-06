import type { EconEvent } from '../../shared/types';
import type { BriefKind, BriefLength, BriefStory, BriefTone, ScoreRow } from '../../shared/v2';
import { aiJson, BudgetExceeded, hashKey } from '../ai/client';
import { config } from '../config';

export interface NarrativeInput {
  kind: BriefKind;
  tone: BriefTone;
  length: BriefLength;
  tz: string;
  rows: ScoreRow[];
  stories: BriefStory[];
  events: EconEvent[];
  regime?: { label: string; score: number } | null;
  handoff?: { from: string; to: string };
}

const fmtMove = (r: ScoreRow) => (r.bp ? `${r.change >= 0 ? '+' : '−'}${Math.abs(r.change * 100).toFixed(0)}bp` : `${r.changePct >= 0 ? '+' : '−'}${Math.abs(r.changePct).toFixed(r.group === 'FX' ? 2 : 1)}%`);
const verb = (r: ScoreRow, tone: BriefTone) => {
  const up = r.change >= 0;
  if (tone === 'eli5') return up ? 'went up' : 'went down';
  const big = Math.abs(r.changePct) > (r.group === 'FX' ? 0.5 : 1.5);
  return up ? (big ? 'jumped' : 'edged up') : big ? 'slid' : 'eased';
};
const name = (r: ScoreRow, tone: BriefTone) => (tone === 'terse' ? r.symbol : r.group === 'FX' && r.symbol.length === 6 ? `${r.symbol.slice(0, 3)}/${r.symbol.slice(3)}` : r.name.replace(/ yield$/, ' yields'));

function timeIn(ts: number, tz: string) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz, hour12: false });
}

/**
 * Deterministic, data-driven narrative used when there is no ANTHROPIC_API_KEY, when the
 * daily budget is spent, or as the first draft before the AI version arrives.
 */
export function templateTake(i: NarrativeInput): { headline: string; text: string } {
  const moved = [...i.rows].filter((r) => !r.mock || true).sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  const top = moved.slice(0, 3);
  const dxy = i.rows.find((r) => r.symbol === 'DXY');
  const tenY = i.rows.find((r) => r.symbol === 'US10Y');
  const story = i.stories[0];
  const event = i.events.filter((e) => e.importance === 3)[0] ?? i.events[0];
  const s: string[] = [];
  const when = i.kind === 'eod' ? 'Today' : i.kind === 'weekly' ? 'This week' : i.kind === 'handoff' ? `Into the ${i.handoff?.to ?? 'next'} session` : 'Overnight';

  if (top.length) {
    const parts = top.map((r) => (i.tone === 'terse' ? `${r.symbol} ${fmtMove(r)}` : `${name(r, i.tone)} ${verb(r, i.tone)} ${fmtMove(r)}`));
    s.push(i.tone === 'terse' ? `${when}: ${parts.join(', ')}.` : `${when}, ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' and ' : ''}${parts[parts.length - 1]}.`);
  } else {
    s.push(`${when}, markets were quiet while data streams connected.`);
  }
  if (dxy || tenY) {
    const bits = [dxy && `the dollar index ${verb(dxy, i.tone)} ${fmtMove(dxy)}`, tenY && `US 10-year yields ${tenY.change >= 0 ? 'rose' : 'fell'} ${fmtMove(tenY)}`].filter(Boolean);
    s.push(i.tone === 'terse' ? `${bits.join('; ')}.` : `In macro, ${bits.join(' while ')}.`);
  }
  if (story) {
    s.push(i.tone === 'eli5'
      ? `The biggest story: ${story.headline}. Why it matters: ${story.why}`
      : i.tone === 'terse' ? `Top story: ${story.headline}.` : `The lead story is “${story.headline}” — ${story.why.charAt(0).toLowerCase()}${story.why.slice(1)}`);
  }
  if (i.regime) s.push(i.tone === 'eli5' ? `Overall, investors look ${i.regime.label === 'risk-on' ? 'confident' : i.regime.label === 'risk-off' ? 'nervous' : 'undecided'}.` : `Cross-asset regime: ${i.regime.label}.`);
  if (event) {
    const t = timeIn(event.time, i.tz);
    const cons = event.consensus !== null ? ` (consensus ${event.consensus}${event.unit})` : '';
    s.push(i.kind === 'eod' ? `Tomorrow's key print: ${event.currency} ${event.title} at ${t}${cons}.` : i.tone === 'terse' ? `Watch: ${event.currency} ${event.title} ${t}${cons}.` : `The day's key release is ${event.currency} ${event.title} at ${t}${cons}.`);
  }
  for (const st of i.stories.slice(1, 4)) s.push(i.tone === 'terse' ? `Also: ${st.headline}.` : `Also in focus: ${st.headline}.`);
  if (i.tone === 'eli5') s.push('Nothing here is advice — it is a summary of what moved and why.');

  const maxSentences = i.length === 50 ? 3 : i.length === 150 ? 5 : 9;
  const text = trimWords(s.slice(0, maxSentences).join(' '), i.length * 1.2);
  const lead = top[0];
  // story-led headline when there is a meaningful story, otherwise a market-led one
  const storyHead = story && story.impact >= 45 ? story.headline.split(/[;:—]| - /)[0].trim().slice(0, 90) : null;
  const moveHead = lead ? `${lead.name.replace(/ yield$/, ' yields')} ${verb(lead, 'analyst')} ${fmtMove(lead).replace(/^\+/, '')}` : null;
  const headline = storyHead ?? (moveHead && event ? `${moveHead}; ${event.title} ahead` : moveHead) ?? 'Markets briefing';
  return { headline, text };
}

function trimWords(t: string, max: number) {
  const w = t.split(/\s+/);
  return w.length <= max ? t : `${w.slice(0, Math.round(max)).join(' ').replace(/[,;:]$/, '')}…`;
}

const TONES: Record<BriefTone, string> = {
  terse: 'Write like a terse sell-side trader: clipped, numbers-first, no filler.',
  analyst: 'Write like a calm macro analyst: precise, connective, plain English.',
  eli5: 'Explain for someone new to markets: define jargon briefly, short sentences.',
};

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'A newspaper-style headline, at most 12 words.' },
    take: { type: 'string', description: 'The narrative paragraph.' },
  },
  required: ['headline', 'take'],
  additionalProperties: false,
} as const;

/** AI narrative over the same structured data. Returns null to fall back to the template. */
export async function aiTake(i: NarrativeInput): Promise<{ headline: string; text: string; model: string } | null> {
  const data = {
    kind: i.kind,
    handoff: i.handoff,
    moves: i.rows.map((r) => ({ s: r.symbol, n: r.name, move: fmtMove(r) })),
    stories: i.stories.slice(0, 5).map((s) => ({ h: s.headline, why: s.why, impact: s.impact, inBook: s.inBook })),
    events: i.events.slice(0, 6).map((e) => ({ t: timeIn(e.time, i.tz), ccy: e.currency, title: e.title, cons: e.consensus, prev: e.previous, actual: e.actual, imp: e.importance })),
    regime: i.regime,
  };
  const sentences = i.length === 50 ? '2–3 sentences' : i.length === 150 ? '3–5 sentences' : '6–9 sentences';
  try {
    const out = await aiJson<{ headline: string; take: string }>({
      kind: `brief:${i.kind}`,
      system: `You write the opening paragraph of a markets briefing. ${TONES[i.tone]} Use only the provided data; never invent numbers, quotes or events. No investment advice or recommendations. Times are already in the reader's time zone.`,
      user: `Write ${sentences} (about ${i.length} words) summarising ${i.kind === 'eod' ? 'the session' : i.kind === 'weekly' ? 'the week' : i.kind === 'handoff' ? 'the session handoff' : 'what happened overnight and what matters today'}.\nDATA: ${JSON.stringify(data)}`,
      schema: SCHEMA,
      maxTokens: 2048,
      effort: 'low',
      cacheKey: hashKey('take', i.tone, i.length, data),
      cacheMaxAgeMs: 6 * 3600_000,
    });
    if (!out?.take) return null;
    return { headline: out.headline.slice(0, 120), text: out.take.slice(0, 3000), model: config.aiModel };
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) console.warn('[brief] AI narrative failed:', (e as Error).message);
    return null;
  }
}
