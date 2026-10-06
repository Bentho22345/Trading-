import type { NewsCluster } from '../../shared/types';
import type { Filing, ThemeItem } from '../../shared/v2';
import type { Hub } from '../hub';
import type { NewsPipeline } from '../news/pipeline';
import { aiJson, hashKey } from '../ai/client';
import { scheduler } from '../scheduler';
import { bad, type Router } from '../router';
import type { V2Feature } from '../v2';
import { intelModes, jobHealth, runJob, setIntelMode, type IntelJob, type IntelMode } from './framework';
import { auctionsJob, cotJob, cryptoFlowsJob, filingsJob, predictionJob, ratePathsJob, realYieldsJob } from './sources';
import { CORR_DEFAULT, correlationJob, reactionsJob, regimeJob, socialJob, speakersJob, statementsJob, structureJob, surpriseJob, themesJob } from './derived';
import * as M from './mock';
import { kvGet, kvSet } from '../kv';

export function intelFeature(hub: Hub, pipeline: NewsPipeline, watch: () => string[], onTheme: (t: ThemeItem) => void): V2Feature {
  const clusters = (): NewsCluster[] => pipeline.recent(1500);
  const oneLiner = async (f: Filing) => (await aiJson<{ line: string }>({
    kind: 'filings', small: true, system: 'Write a neutral one-line description (max 18 words) of what this SEC filing type typically signals for the company. No speculation about contents you cannot see.',
    user: `${f.form} filed by ${f.company} (${f.ticker ?? ''})`, schema: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'], additionalProperties: false }, maxTokens: 200, cacheKey: hashKey('filing', f.id),
  }))?.line ?? null;

  const withMock = (job: IntelJob, mock: IntelJob['mock']): IntelJob => ({ ...job, mock });
  const jobs: IntelJob[] = [
    withMock(auctionsJob, () => ({ data: M.mockAuctions(), source: 'US Treasury auctions' })),
    withMock(realYieldsJob, () => ({ data: M.mockRealYields(), source: 'FRED real yields' })),
    withMock(ratePathsJob((s) => hub.quotes.get(s)?.price ?? null), () => ({ data: M.mockRatePaths(), source: 'Rate-path probabilities', note: 'Demo values — not market data.' })),
    withMock(cotJob, () => ({ data: M.mockCot(), source: 'CFTC COT', note: 'Weekly, as of Tuesday.', asOf: new Date(Date.now() - 4 * 86400_000).toISOString().slice(0, 10) })),
    withMock(cryptoFlowsJob, () => ({ data: M.mockCryptoFlows(), source: 'Crypto flows' })),
    withMock(filingsJob(watch, oneLiner), () => ({ data: M.mockFilings(), source: 'SEC EDGAR' })),
    withMock(predictionJob, () => ({ data: M.mockPrediction(), source: 'Polymarket & Kalshi', note: 'Market odds, not forecasts.' })),
    withMock(reactionsJob(hub), () => ({ data: M.mockReactions(), source: 'Historical reactions' })),
    withMock(socialJob(clusters), () => ({ data: M.mockSocial(), source: 'Mention velocity' })),
    themesJob(clusters, onTheme), correlationJob(hub, () => kvGet<string[]>('corr.symbols', CORR_DEFAULT)), regimeJob(hub), surpriseJob(), structureJob, speakersJob(hub), statementsJob(clusters),
  ];
  // derived jobs that still support an explicit demo toggle
  const demoable = new Set(jobs.filter((j) => j.mock).map((j) => j.key));

  return {
    start() {
      jobs.forEach((j, i) => scheduler.every(`intel-${j.key}`, `Intel: ${j.label}`, j.everyMs, () => runJob(j, hub), {}));
      // first run staggered so start-up stays light
      jobs.forEach((j, i) => setTimeout(() => void runJob(j, hub), 2000 + i * 700));
    },
    routes(r: Router) {
      r.get('/api/intel', () => [...hub.intel.values()]);
      r.get('/api/intel/health', () => jobs.map((j) => ({ ...(jobHealth.get(j.key) ?? { key: j.key, label: j.label, runs: 0, errors: 0, lastOk: null, lastError: null, latencyMs: [] }), mode: intelModes()[j.key] ?? 'auto', demoable: demoable.has(j.key), derived: !!j.derived })));
      r.put('/api/intel/:key/mode', async ({ params, body }) => {
        const job = jobs.find((j) => j.key === params[0]);
        if (!job) bad('unknown intel key');
        const { mode } = await body<{ mode: IntelMode }>();
        if (!['auto', 'live', 'mock', 'off'].includes(mode)) bad('mode must be auto, live, mock or off');
        setIntelMode(job.key, mode);
        await runJob(job, hub);
        return hub.intel.get(job.key) ?? null;
      });
      r.put('/api/intel/correlation/symbols', async ({ body }) => {
        const { symbols } = await body<{ symbols: string[] }>();
        kvSet('corr.symbols', (symbols ?? []).slice(0, 12));
        const j = jobs.find((x) => x.key === 'correlation')!;
        await runJob(j, hub);
        return hub.intel.get('correlation');
      });
    },
  };
}
