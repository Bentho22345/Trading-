import type { JournalEntry, PlaybookOutcome, Position } from '../shared/v2';
import { sqlite } from './db/client';
import { docs } from './docs';
import type { Hub } from './hub';
import type { NewsPipeline } from './news/pipeline';
import { computeExposure } from './portfolio';
import { enqueueType } from './integrations';
import { bad, notFound, type Router } from './router';
import type { V2Feature } from './v2';
import { homeTz } from './brief/service';
import { localDate } from './scheduler';

/** Daily journal pre-fill (top stories, alerts fired, playbook outcomes, P&L) and Notion export. */
export function journalFeature(hub: Hub, pipeline: NewsPipeline): V2Feature {
  return {
    routes(r: Router) {
      r.get('/api/journal/prefill', ({ url }) => {
        const tz = homeTz();
        const date = url.searchParams.get('date') ?? localDate(Date.now(), tz);
        const inDay = (ts: number) => localDate(ts, tz) === date;
        const stories = pipeline.archive(Date.now() + 1, 400).filter((c) => inDay(c.receivedAt)).sort((a, b) => b.impact - a.impact).slice(0, 5);
        const alerts = (sqlite.prepare('SELECT message, ts FROM alert_events WHERE ts > ? ORDER BY ts').all(Date.now() - 2 * 86400_000) as { message: string; ts: number }[]).filter((a) => inDay(a.ts));
        const outcomes = (sqlite.prepare('SELECT data FROM playbook_outcomes WHERE fired_at > ?').all(Date.now() - 2 * 86400_000) as { data: string }[]).map((x) => JSON.parse(x.data) as PlaybookOutcome).filter((o) => inDay(o.firedAt));
        const exp = computeExposure(docs.list<Position>('positions'), hub);
        const md = [
          `## Top stories`, ...stories.map((s) => `- [${s.headline}](${s.url}) — ${s.source} (impact ${s.impact})`),
          '', `## Alerts fired`, ...(alerts.length ? alerts.map((a) => `- ${new Date(a.ts).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })} ${a.message}`) : ['- none']),
          '', `## Playbooks`, ...(outcomes.length ? outcomes.map((o) => `- ${o.playbookName}: ${o.scenarioLabel ?? 'no scenario'} · ${o.checks.map((c) => `${c.symbol} ${c.hits.m30 === undefined ? '…' : c.hits.m30 ? '✓' : '✗'}`).join(' ')}`) : ['- none fired']),
          '', `## P&L`, exp.rows.length ? `- Day P&L ${exp.pnlDay >= 0 ? '+' : '−'}$${Math.abs(exp.pnlDay).toLocaleString()} · total ${exp.pnlTotal >= 0 ? '+' : '−'}$${Math.abs(exp.pnlTotal).toLocaleString()}` : '- no positions imported',
          '', '## Reflections', '_What did you learn today?_', '',
        ].join('\n');
        return { date, markdown: md, stories: stories.map((s) => ({ id: s.id, headline: s.headline, url: s.url })), alerts, outcomes: outcomes.length, pnlDay: exp.pnlDay };
      });
      r.post('/api/journal/:id/notion', ({ params }) => {
        const e = docs.get<JournalEntry>('journal_entries', params[0]) ?? notFound('entry not found');
        const n = enqueueType('notion', { kind: 'journal', title: `${e.date} · ${e.title}`, text: e.body, markdown: e.body });
        if (!n) bad('connect Notion in Settings → Integrations first');
        return { queued: n };
      });
    },
  };
}
