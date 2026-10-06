// "What changed vs yesterday's brief" — pure diff between two briefs.
import type { Brief, BriefStory, ScoreRow } from './v2';
import type { EconEvent } from './types';

export interface BriefDiff {
  takeAdded: string[];
  takeRemoved: string[];
  storiesNew: BriefStory[];
  storiesDropped: BriefStory[];
  storiesKept: { story: BriefStory; rankFrom: number; rankTo: number }[];
  moves: { symbol: string; before: number; after: number; bp?: boolean }[];
  eventsNew: string[];
  eventsDropped: string[];
}

export const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function section<T>(b: Brief, type: string): T | null {
  const s = b.sections.find((x) => x.type === type && !x.empty);
  return (s?.data as T) ?? null;
}

export function diffBriefs(older: Brief, newer: Brief): BriefDiff {
  const a = sentences(older.take.text), b = sentences(newer.take.text);
  const an = new Set(a.map(norm)), bn = new Set(b.map(norm));
  const sa = section<{ stories: BriefStory[] }>(older, 'stories')?.stories ?? [];
  const sb = section<{ stories: BriefStory[] }>(newer, 'stories')?.stories ?? [];
  const keyOf = (s: BriefStory) => norm(s.headline).slice(0, 60);
  const ka = new Map(sa.map((s, i) => [keyOf(s), i])), kb = new Map(sb.map((s, i) => [keyOf(s), i]));
  const ra = section<{ rows: ScoreRow[] }>(older, 'scoreboard')?.rows ?? [];
  const rb = section<{ rows: ScoreRow[] }>(newer, 'scoreboard')?.rows ?? [];
  const ea = (section<{ events: EconEvent[] }>(older, 'calendar')?.events ?? []).map((e) => `${e.currency} ${e.title}`);
  const eb = (section<{ events: EconEvent[] }>(newer, 'calendar')?.events ?? []).map((e) => `${e.currency} ${e.title}`);
  return {
    takeAdded: b.filter((s) => !an.has(norm(s))),
    takeRemoved: a.filter((s) => !bn.has(norm(s))),
    storiesNew: sb.filter((s) => !ka.has(keyOf(s))),
    storiesDropped: sa.filter((s) => !kb.has(keyOf(s))),
    storiesKept: sb.filter((s) => ka.has(keyOf(s))).map((s) => ({ story: s, rankFrom: ka.get(keyOf(s))! + 1, rankTo: kb.get(keyOf(s))! + 1 })),
    moves: rb.map((r) => {
      const prev = ra.find((x) => x.symbol === r.symbol);
      return prev ? { symbol: r.symbol, before: prev.bp ? prev.change * 100 : prev.changePct, after: r.bp ? r.change * 100 : r.changePct, bp: r.bp } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x),
    eventsNew: eb.filter((e) => !ea.includes(e)),
    eventsDropped: ea.filter((e) => !eb.includes(e)),
  };
}
