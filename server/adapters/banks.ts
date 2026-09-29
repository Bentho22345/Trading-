import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CentralBank, NewsCluster } from '../../shared/types';
import type { Adapter } from './types';
import { BANK_PATTERNS } from '../news/tagger';
import { hub } from '../hub';

interface RefBank extends Omit<CentralBank, 'nextMeeting' | 'asOf' | 'source'> {
  meetings: string[];
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Central bank watch. Policy rates and meeting calendars come from an editable reference file
 * (no reliable free API exists); the latest statement headline is filled from the news pipeline
 * whenever a cluster mentions the bank (central-bank RSS in live mode, demo wires in mock mode).
 */
export function banksAdapter(): Adapter {
  let timer: NodeJS.Timeout | null = null;
  let banks: CentralBank[] = [];
  let meetings: Record<string, number[]> = {};

  const refresh = () => {
    const now = Date.now();
    for (const b of banks) b.nextMeeting = (meetings[b.id] ?? []).find((t) => t > now - 2 * 3600_000) ?? null;
    hub.setBanks(banks.map((b) => ({ ...b })));
  };

  return {
    id: 'banks-reference',
    stream: 'banks',
    provider: 'Reference file + news',
    mock: false,
    delayedMin: 0,
    staleAfterMs: 7 * 86400_000,
    start(ctx) {
      try {
        const raw = JSON.parse(readFileSync(join(here, '../data/central-banks.json'), 'utf8')) as { asOf: string; banks: RefBank[] };
        meetings = Object.fromEntries(raw.banks.map((b) => [b.id, b.meetings.map((m) => Date.parse(m)).sort((a, c) => a - c)]));
        banks = raw.banks.map(({ meetings: _m, ...b }) => ({ ...b, nextMeeting: null, asOf: raw.asOf, source: `Reference data (as of ${raw.asOf})` }));
        refresh();
        timer = setInterval(refresh, 60_000);
      } catch (e) {
        ctx.log.error('[banks] failed to load reference data', e);
        ctx.hub.setState('banks', 'down', 'reference file unreadable');
      }
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

/** Called for every news cluster: keeps each bank's "latest headline" current. */
export function updateBankHeadline(c: NewsCluster) {
  if (!c.domains.includes('centralbanks')) return;
  let changed = false;
  for (const p of BANK_PATTERNS) {
    if (!p.re.test(c.headline)) continue;
    const b = hub.banks.find((x) => x.id === p.id);
    if (b && (!b.latest || b.latest.ts < c.publishedAt)) {
      b.latest = { title: c.headline, url: c.url, ts: c.publishedAt, source: c.source };
      changed = true;
    }
  }
  if (changed) hub.setBanks(hub.banks.map((b) => ({ ...b })));
}
