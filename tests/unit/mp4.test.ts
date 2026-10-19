import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractSamples, readMp4Info } from '../../src/video/mp4';

it('reads mp4 metadata and extracts every sample in range', async () => {
  const blob = new Blob([readFileSync('tests/fixtures/clip120.mp4')]);
  const { info } = await readMp4Info(blob);
  expect(Math.round(info.fps)).toBe(120);
  expect(info.nbSamples).toBe(240);
  expect(info.description?.length).toBeGreaterThan(10);
  const { samples } = await extractSamples(blob, 0, 2);
  expect(samples.length).toBe(240);
  expect(samples[0].key).toBe(true);
  const part = await extractSamples(blob, 1, 1.5);
  // from the keyframe at or before 1.0 s through 1.5 s
  expect(part.samples[0].key).toBe(true);
  expect(part.samples.at(-1)!.ts).toBeGreaterThanOrEqual(1.5e6 - 1e4);
});

it('variable frame rate: reports the real capture rate, not the average', async () => {
  // 60 fps recording with every 5th frame dropped after the first second (average ≈ 51 fps)
  const blob = new Blob([readFileSync('tests/fixtures/vfr60.mp4')]);
  const { info } = await readMp4Info(blob);
  expect(info.vfr).toBe(true);
  expect(Math.round(info.fps)).toBe(60);
  expect(info.nbSamples / info.durationS).toBeLessThan(56);
});
