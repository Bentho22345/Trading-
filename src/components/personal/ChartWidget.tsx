'use client';
import { useEffect, useRef, useState } from 'react';
import { createChart, LineSeries, ColorType, createSeriesMarkers, type IChartApi, type ISeriesApi, type UTCTimestamp, type IPriceLine } from 'lightweight-charts';
import type { HistoryPoint } from '@shared/types';
import type { JournalEntry, Level } from '@shared/v2';
import { useDocs, useV2 } from '@/lib/v2';
import { useStore } from '@/lib/store';
import { useSettings } from '@/lib/settings';
import type { WidgetProps } from '../layout/registry';
import { Panel } from '../ui';
import { addNote } from './Journal';

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';

/** Mini chart: click "Level" then click the chart to draw a horizontal level (feeds alerts & the brief); shift-click adds a note. */
export function ChartWidget({ config }: WidgetProps) {
  const symbol = String(config.symbol ?? 'EURUSD');
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Line'> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const [mode, setMode] = useState<'none' | 'level'>('none');
  const levels = useDocs<Level>('levels').filter((l) => l.symbol === symbol);
  const notes = useDocs<JournalEntry>('journal_entries').filter((n) => n.links.some((l) => l.kind === 'chart' && l.ref === symbol));
  const quote = useStore((s) => s.quotes[symbol]);
  const meta = useStore((s) => s.symbols[symbol]);
  const theme = useSettings((s) => s.theme);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, { autoSize: true, layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--text-faint'), attributionLogo: false, fontSize: 10 }, grid: { vertLines: { visible: false }, horzLines: { color: css('--border') } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true } });
    series.current = c.addSeries(LineSeries, { color: css('--accent'), lineWidth: 2, priceLineVisible: false });
    chart.current = c;
    c.subscribeClick((p) => {
      if (!p.point || !series.current) return;
      const price = series.current.coordinateToPrice(p.point.y);
      if (price === null) return;
      const ev = p.sourceEvent as unknown as { shiftKey?: boolean } | undefined;
      if (modeRef.current === 'level') {
        void useV2.getState().putDoc('levels', { symbol, price: +Number(price).toFixed(meta?.decimals ?? 4), label: 'Chart level', alert: true, createdAt: Date.now() } satisfies Omit<Level, 'id'>);
        setMode('none');
      } else if (ev?.shiftKey) {
        const text = prompt(`Note at ${Number(price).toFixed(meta?.decimals ?? 4)}`);
        if (text) void addNote({ kind: 'chart', ref: symbol, label: symbol, ts: (p.time as number) * 1000, price: Number(price) }, text.slice(0, 80), text);
      }
    });
    return () => { c.remove(); chart.current = null; series.current = null; };
  }, [symbol, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    void fetch(`/api/history/${symbol}?minutes=1440`).then((r) => r.json()).then((pts: HistoryPoint[]) => {
      if (!alive || !series.current || !Array.isArray(pts)) return;
      series.current.setData(pts.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.c })));
      chart.current?.timeScale().fitContent();
    }).catch(() => {});
    return () => { alive = false; };
  }, [symbol]);

  useEffect(() => {
    if (quote && series.current) series.current.update({ time: Math.floor(quote.ts / 60_000) * 60 as UTCTimestamp, value: quote.price });
  }, [quote]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = levels.map((l) => s.createPriceLine({ price: l.price, color: l.color ?? css('--warn'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.label }));
    createSeriesMarkers(s, notes.map((n) => n.links.find((x) => x.kind === 'chart')).filter((x) => x?.ts).map((x) => ({ time: Math.floor(x!.ts! / 1000) as UTCTimestamp, position: 'aboveBar' as const, color: css('--accent'), shape: 'circle' as const, text: '✎' })));
  }, [levels, notes]);

  return (
    <Panel title={`Chart · ${symbol}`} accent="var(--accent)" right={<>
      <button onClick={() => setMode(mode === 'level' ? 'none' : 'level')} className={`rounded px-1.5 text-[10px] ${mode === 'level' ? 'bg-warn/20 text-warn' : 'text-faint hover:text-text'}`} title="Click, then click the chart to place a level (creates an alert)">{mode === 'level' ? 'click chart…' : '+ level'}</button>
      <span className="text-[10px] text-faint" title="Shift-click the chart to pin a note">⇧click = note</span>
    </>} bodyClass="p-1">
      <div ref={el} className="h-full min-h-40 w-full" />
    </Panel>
  );
}
