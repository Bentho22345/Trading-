// Prints the synthetic-pitcher accuracy table used in VALIDATION.md (run: npm run validate).
import { it } from 'vitest';
import { GOOD_DAY, OFF_DAY, generatePitch } from '../../src/core/synthetic';
import { analyzeTrack } from '../../src/core/analyze';
import { resolvedEvents, EVENT_CODES } from '../../src/core/types';

it('synthetic accuracy report', () => {
  const rows: string[] = ['| fps | ' + EVENT_CODES.map((k) => `${k} mean / max (ms)`).join(' | ') + ' | stride err (% ht) | front knee FS err (°) | trunk BR err (°) | forearm FS err (°) |', '|' + '---|'.repeat(EVENT_CODES.length + 5)];
  for (const fps of [240, 120, 60, 30]) {
    const err: Record<string, number[]> = {};
    const m: Record<string, number[]> = { stride: [], knee: [], trunk: [], forearm: [] };
    for (const base of [GOOD_DAY, OFF_DAY]) for (let seed = 1; seed <= 10; seed++) {
      const s = generatePitch({ ...base, fps, seed, noise: 0.003 });
      const { analysis: a } = analyzeTrack(s.track);
      const ev = resolvedEvents(a);
      for (const k of EVENT_CODES) (err[k] ??= []).push((Math.abs(ev[k] - s.truth[k]) / fps) * 1000);
      m.stride.push(Math.abs((a.metrics.stride.value ?? NaN) - base.stride * 100));
      m.knee.push(Math.abs((a.metrics.leadKneeFS.value ?? NaN) - base.leadKneeFS));
      m.trunk.push(Math.abs((a.metrics.trunkTiltBR.value ?? NaN) - base.trunkTiltBR));
      const f = (Math.asin(Math.sin((base.throwForearmFS * Math.PI) / 180)) * 180) / Math.PI;
      m.forearm.push(Math.abs((a.metrics.forearmFS.value ?? NaN) - f));
    }
    const mm = (a: number[]) => `${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)} / ${Math.max(...a).toFixed(1)}`;
    rows.push(`| ${fps} | ${EVENT_CODES.map((k) => mm(err[k])).join(' | ')} | ${mm(m.stride)} | ${mm(m.knee)} | ${mm(m.trunk)} | ${mm(m.forearm)} |`);
  }
  process.stdout.write('\n' + rows.join('\n') + '\n');
});
