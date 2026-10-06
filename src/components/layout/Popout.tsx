'use client';
import { useEffect } from 'react';
import type { WidgetType } from '@shared/v2';
import { connect } from '@/lib/socket';
import { useSettings } from '@/lib/settings';
import { WIDGETS } from '@/lib/workspaces';
import { ConnectionStatus } from '../ConnectionStatus';
import { Toasts } from '../Toasts';
import { WIDGET_COMPONENTS } from './registry';
import { ThemeSync } from './ThemeSync';

/** A single panel in its own window (multi-monitor). Shares the main window's socket via BroadcastChannel. */
export function PopoutShell({ type, cfg, title }: { type: string; cfg: string; title: string }) {
  const hydrate = useSettings((s) => s.hydrate);
  useEffect(() => {
    hydrate();
    return connect();
  }, [hydrate]);
  let config: Record<string, unknown> = {};
  try {
    config = cfg ? JSON.parse(atob(decodeURIComponent(cfg))) : {};
  } catch {
    config = {};
  }
  const C = WIDGET_COMPONENTS[type as WidgetType];
  useEffect(() => {
    document.title = `PULSE — ${title || WIDGETS[type as WidgetType]?.label || 'panel'}`;
  }, [title, type]);
  return (
    <>
      <ThemeSync />
      <div className="flex h-dvh flex-col bg-bg">
        <div className="flex h-8 items-center justify-between border-b border-line px-3 text-[11px] text-faint">
          <span className="font-bold tracking-[0.28em] text-text">PULSE</span>
          <span className="truncate">{title || WIDGETS[type as WidgetType]?.label}</span>
          <ConnectionStatus />
        </div>
        <div className="widget-fill min-h-0 flex-1 p-2">{C ? <C config={config} instanceId={`popout-${type}`} /> : <p className="p-4 text-sm text-faint">Unknown panel.</p>}</div>
        <div className="border-t border-line px-3 py-1 text-[10px] text-faint">Informational only — not investment advice.</div>
      </div>
      <Toasts />
    </>
  );
}
