'use client';
import { useEffect, useRef } from 'react';
import {
  createChart, AreaSeries, LineSeries, ColorType, CrosshairMode, LineStyle, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type UTCTimestamp, type SeriesMarker, type Time,
} from 'lightweight-charts';
import type { HistoryPoint } from '@shared/types';
import { useSettings } from '@/lib/settings';

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

function withAlpha(color: string, a: number) {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}

/** Tiny area sparkline (lightweight-charts, no axes). */
export function Sparkline({ data, up, height = 28 }: { data: number[]; up: boolean; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Area'> | null>(null);
  const theme = useSettings((s) => s.theme);
  const cb = useSettings((s) => s.colorblind);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: 'transparent', attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false, borderVisible: false },
      crosshair: { mode: CrosshairMode.Hidden },
      handleScroll: false,
      handleScale: false,
    });
    series.current = c.addSeries(AreaSeries, { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, [height]);

  useEffect(() => {
    const color = cssVar(up ? '--up' : '--down');
    series.current?.applyOptions({ lineColor: color, topColor: withAlpha(color, 0.28), bottomColor: withAlpha(color, 0) });
  }, [up, theme, cb]);

  useEffect(() => {
    if (!series.current || !data.length) return;
    series.current.setData(data.map((v, i) => ({ time: (i * 300) as UTCTimestamp, value: v })));
    chart.current?.timeScale().fitContent();
  }, [data]);

  return <div ref={el} style={{ height }} className="w-full" />;
}

function baseOptions(height: number) {
  const text = cssVar('--text-faint');
  const border = cssVar('--border');
  return {
    autoSize: true,
    height,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: text, fontFamily: 'var(--font-geist-mono), monospace', fontSize: 10, attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: border, style: LineStyle.Dotted } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: { mode: CrosshairMode.Magnet },
  } as const;
}

/** Price chart used by the ticker drawer and story timeline. */
export function PriceChart({ points, live, up, height = 200, markers, decimals = 2 }: { points: HistoryPoint[]; live?: { t: number; c: number }; up: boolean; height?: number; markers?: { t: number; label: string }[]; decimals?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Area'> | null>(null);
  const theme = useSettings((s) => s.theme);
  const cb = useSettings((s) => s.colorblind);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, baseOptions(height));
    const color = cssVar(up ? '--up' : '--down');
    series.current = c.addSeries(AreaSeries, {
      lineColor: color, topColor: withAlpha(color, 0.25), bottomColor: withAlpha(color, 0), lineWidth: 2,
      priceFormat: { type: 'price', precision: decimals, minMove: 1 / 10 ** decimals },
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, [height, up, theme, cb, decimals]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const data = points.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.c }));
    s.setData(data);
    if (markers?.length && data.length) {
      const first = data[0].time as number, last = data[data.length - 1].time as number;
      const ms: SeriesMarker<Time>[] = markers
        .map((m) => Math.floor(m.t / 60_000) * 60)
        .map((t, i) => ({ time: Math.min(last, Math.max(first, t)) as UTCTimestamp, position: 'aboveBar' as const, shape: 'circle' as const, color: cssVar('--accent'), text: markers[i].label }))
        .sort((a, b) => (a.time as number) - (b.time as number));
      createSeriesMarkers(s, ms);
    }
    chart.current?.timeScale().fitContent();
  }, [points, markers, theme, cb, up, decimals]);

  useEffect(() => {
    if (!live || !series.current || !points.length) return;
    const t = Math.floor(live.t / 60_000) * 60;
    const lastT = Math.floor(points[points.length - 1].t / 1000);
    if (t < lastT) return;
    try {
      series.current.update({ time: t as UTCTimestamp, value: live.c });
    } catch {
      /* out-of-order update — ignore */
    }
  }, [live, points]);

  return <div ref={el} style={{ height }} className="w-full" />;
}

/** VIX term structure line */
export function TermChart({ points, height = 90 }: { points: { t: number; v: number; label: string }[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    if (!el.current || points.length < 2) return;
    const c = createChart(el.current, {
      ...baseOptions(height),
      timeScale: { borderVisible: false, visible: true, tickMarkFormatter: (t: Time) => points.find((p) => Math.floor(p.t / 1000) === t)?.label ?? '' },
      handleScroll: false,
      handleScale: false,
      crosshair: { mode: CrosshairMode.Hidden },
    });
    const s = c.addSeries(LineSeries, { color: cssVar('--eq'), lineWidth: 2, pointMarkersVisible: true, priceLineVisible: false, lastValueVisible: false });
    const uniq = new Map<number, number>();
    for (const p of points) uniq.set(Math.floor(p.t / 1000), p.v);
    s.setData([...uniq].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t as UTCTimestamp, value: v })));
    c.timeScale().fitContent();
    return () => c.remove();
  }, [points, height, theme]);
  return <div ref={el} style={{ height }} className="w-full" />;
}
