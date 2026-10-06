'use client';
import { useEffect, useMemo, useState } from 'react';
import type { WidgetType } from '@shared/v2';
import { connect } from '@/lib/socket';
import { useSettings } from '@/lib/settings';
import { useNow, useCalm } from '@/lib/hooks';
import { WIDGETS } from '@/lib/workspaces';
import { TickerStrip } from '../TickerStrip';
import { BreakingBanner } from '../BreakingBanner';
import { ConnectionStatus } from '../ConnectionStatus';
import { WIDGET_COMPONENTS } from './registry';
import { ThemeSync } from './ThemeSync';

const DEFAULT: WidgetType[] = ['news', 'heatmap', 'crypto', 'rates', 'regime', 'calendar', 'prediction'];

/** Wall / kiosk mode: oversized, auto-cycling display for a TV on the desk. ?w=news,heatmap&s=20 */
export function WallShell({ widgets, seconds }: { widgets: string; seconds: number }) {
  const hydrate = useSettings((s) => s.hydrate);
  const now = useNow(1000);
  const calm = useCalm();
  const list = useMemo(() => {
    const req = widgets.split(',').map((x) => x.trim()).filter((x): x is WidgetType => x in WIDGETS);
    return req.length ? req : DEFAULT;
  }, [widgets]);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    hydrate();
    return connect();
  }, [hydrate]);
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setI((x) => (x + 1) % list.length), Math.max(5, seconds) * 1000);
    return () => clearInterval(id);
  }, [list.length, seconds, paused]);
  const type = list[i];
  const next = list[(i + 1) % list.length];
  const C = WIDGET_COMPONENTS[type];
  return (
    <>
      <ThemeSync />
      <div className="flex h-dvh flex-col bg-bg" onClick={() => setPaused((p) => !p)}>
        <div className="flex items-center justify-between px-8 py-4">
          <span className="text-2xl font-bold tracking-[0.35em] text-text">PULSE</span>
          <span className="num text-4xl font-light text-text" suppressHydrationWarning>{now ? new Date(now).toLocaleTimeString([], { hour12: false }) : ''}</span>
          <span className="scale-125"><ConnectionStatus /></span>
        </div>
        <div className="text-lg"><TickerStrip /></div>
        <div className="relative min-h-0 flex-1 px-8 py-6">
          <BreakingBanner />
          <div key={type} className={`widget-fill h-full ${calm ? '' : 'fade-in'}`} style={{ zoom: 1.45 } as React.CSSProperties}>
            <C config={{}} instanceId={`wall-${type}`} />
          </div>
        </div>
        <div className="flex items-center justify-between px-8 pb-4 text-sm text-faint">
          <span>{WIDGETS[type].label}{paused ? ' · paused (click to resume)' : ` · next: ${WIDGETS[next].label}`}</span>
          <span className="flex gap-1.5">{list.map((t, k) => <span key={t} className={`h-1.5 w-6 rounded-full ${k === i ? 'bg-accent' : 'bg-line-strong'}`} />)}</span>
          <span>Informational only — not investment advice.</span>
        </div>
      </div>
    </>
  );
}
