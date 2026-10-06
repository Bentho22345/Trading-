import type { BriefKind, BriefProfile, BriefSectionConfig, BriefSectionType } from '../../shared/v2';

export const SECTION_TITLES: Record<BriefSectionType, string> = {
  take: 'The take', scoreboard: 'Overnight scoreboard', stories: 'Top stories', calendar: "Today's calendar", book: 'Your book',
  levels: 'Key levels to watch', ratePath: 'Rates path', sentiment: 'Sentiment snapshot', weekAhead: 'Week ahead', scorecard: "Yesterday's scorecard",
  smartFeed: 'Smart feed', movers: 'Biggest movers', journal: 'Journal prompt', themes: 'Top themes', nextUp: "What's next", risks: 'Open risks',
  structure: 'Market structure', activity: 'Activity heatmap',
};

const sec = (type: BriefSectionType, size: BriefSectionConfig['size'] = 'full', options: BriefSectionConfig['options'] = {}, enabled = true): BriefSectionConfig => ({ id: type, type, enabled, size, options });

export const KIND_SECTIONS: Record<BriefKind, BriefSectionConfig[]> = {
  morning: [
    sec('take'), sec('scoreboard'), sec('stories', 'full', { topN: 5 }), sec('calendar', 'half', { minImportance: 2 }), sec('book', 'half'),
    sec('levels', 'half'), sec('ratePath', 'half'), sec('sentiment', 'half'), sec('structure', 'half'), sec('weekAhead'), sec('scorecard'),
  ],
  handoff: [sec('take'), sec('scoreboard', 'full', { title: 'What moved' }), sec('nextUp', 'half'), sec('risks', 'half')],
  eod: [
    sec('take'), sec('scoreboard', 'full', { title: 'Closing scoreboard' }), sec('movers'), sec('scorecard', 'half', { title: 'Best & worst calls' }),
    sec('journal', 'half'), sec('calendar', 'full', { title: "Tomorrow's calendar", minImportance: 2 }),
  ],
  weekly: [
    sec('take'), sec('scoreboard', 'full', { title: 'Cumulative moves' }), sec('themes'), sec('scorecard', 'half', { title: 'Playbook hit rate' }),
    sec('activity', 'half'), sec('weekAhead', 'full', { title: 'Next week' }),
  ],
};

const weekdays = (t: string) => [null, t, t, t, t, t, null];

export function defaultProfiles(tz: string): BriefProfile[] {
  return [
    { id: 'morning', name: 'Morning Brief', kind: 'morning', sections: KIND_SECTIONS.morning, tone: 'analyst', length: 150, schedule: { enabled: true, tz, times: weekdays('06:30') }, destinations: [], assetClasses: ['fx', 'crypto', 'equities', 'rates', 'commodities'], autoOpen: true, order: 0 },
    { id: 'us-open', name: 'US Open', kind: 'morning', sections: [sec('take'), sec('stories', 'full', { topN: 5, myAssetsOnly: false }), sec('levels', 'half'), sec('calendar', 'half', { minImportance: 2 })], tone: 'terse', length: 50, schedule: { enabled: false, tz: 'America/New_York', times: weekdays('09:15') }, destinations: [], assetClasses: ['equities', 'rates'], autoOpen: false, order: 1 },
    { id: 'crypto-weekend', name: 'Crypto Weekend', kind: 'morning', sections: [sec('take'), sec('scoreboard'), sec('stories', 'full', { topN: 6, myAssetsOnly: true }), sec('sentiment')], tone: 'analyst', length: 150, schedule: { enabled: false, tz, times: ['10:00', null, null, null, null, null, '10:00'] }, destinations: [], assetClasses: ['crypto'], autoOpen: false, order: 2 },
    { id: 'handoff-asia-london', name: 'Asia → London handoff', kind: 'handoff', sections: KIND_SECTIONS.handoff, tone: 'terse', length: 50, schedule: { enabled: true, tz: 'Europe/London', times: weekdays('07:00') }, destinations: [], assetClasses: [], autoOpen: false, order: 3, handoff: { from: 'Asia', to: 'London' } },
    { id: 'handoff-london-ny', name: 'London → NY handoff', kind: 'handoff', sections: KIND_SECTIONS.handoff, tone: 'terse', length: 50, schedule: { enabled: true, tz: 'America/New_York', times: weekdays('08:00') }, destinations: [], assetClasses: [], autoOpen: false, order: 4, handoff: { from: 'London', to: 'New York' } },
    { id: 'eod', name: 'End-of-Day Wrap', kind: 'eod', sections: KIND_SECTIONS.eod, tone: 'analyst', length: 150, schedule: { enabled: true, tz: 'America/New_York', times: weekdays('17:05') }, destinations: [], assetClasses: [], autoOpen: false, order: 5 },
    { id: 'weekly', name: 'Weekly Review', kind: 'weekly', sections: KIND_SECTIONS.weekly, tone: 'analyst', length: 300, schedule: { enabled: true, tz: 'America/New_York', times: [null, null, null, null, null, '17:15', null] }, destinations: [], assetClasses: [], autoOpen: false, order: 6 },
  ];
}

/** Repair a profile coming from the editor or an imported template. */
export function sanitizeProfile(p: Partial<BriefProfile> & { id?: string }, tz: string): BriefProfile {
  const kind: BriefKind = (['morning', 'handoff', 'eod', 'weekly'] as const).includes(p.kind as BriefKind) ? (p.kind as BriefKind) : 'morning';
  const sections = (Array.isArray(p.sections) ? p.sections : KIND_SECTIONS[kind])
    .filter((s) => s && SECTION_TITLES[s.type as BriefSectionType])
    .slice(0, 30)
    .map((s, i) => ({
      id: String(s.id || `${s.type}-${i}`).slice(0, 40), type: s.type, enabled: s.enabled !== false,
      size: (['full', 'half', 'third'] as const).includes(s.size) ? s.size : 'full',
      options: {
        topN: s.options?.topN ? Math.max(1, Math.min(20, Number(s.options.topN))) : undefined,
        myAssetsOnly: !!s.options?.myAssetsOnly, includeCrypto: s.options?.includeCrypto !== false,
        smartFeedId: s.options?.smartFeedId ? String(s.options.smartFeedId) : undefined,
        minImportance: [1, 2, 3].includes(Number(s.options?.minImportance)) ? (Number(s.options!.minImportance) as 1 | 2 | 3) : undefined,
        title: s.options?.title ? String(s.options.title).slice(0, 60) : undefined,
      },
    }));
  const times = Array.from({ length: 7 }, (_, i) => {
    const t = p.schedule?.times?.[i];
    return typeof t === 'string' && /^\d{1,2}:\d{2}$/.test(t) ? t : null;
  });
  return {
    id: p.id ?? '', name: String(p.name ?? 'Brief').slice(0, 60), kind, sections,
    tone: (['terse', 'analyst', 'eli5'] as const).includes(p.tone as never) ? p.tone! : 'analyst',
    length: ([50, 150, 300] as const).includes(Number(p.length) as never) ? (Number(p.length) as 50 | 150 | 300) : 150,
    schedule: { enabled: !!p.schedule?.enabled, tz: validTz(p.schedule?.tz) ? p.schedule!.tz : tz, times },
    destinations: Array.isArray(p.destinations) ? p.destinations.map(String).slice(0, 10) : [],
    assetClasses: Array.isArray(p.assetClasses) ? p.assetClasses.map(String).slice(0, 8) : [],
    autoOpen: !!p.autoOpen, order: Number(p.order) || 0,
    ...(p.handoff ? { handoff: { from: String(p.handoff.from).slice(0, 30), to: String(p.handoff.to).slice(0, 30) } } : {}),
  };
}

export function validTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
