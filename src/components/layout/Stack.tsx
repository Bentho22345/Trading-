'use client';
import type { Workspace } from '@shared/v2';
import { WIDGET_COMPONENTS } from './registry';

/** Narrow screens: the workspace's panels in reading order (top-to-bottom, left-to-right), feed excluded. */
export function WidgetStack({ ws }: { ws: Workspace }) {
  const items = ws.widgets.filter((w) => w.type !== 'news').sort((a, b) => a.y - b.y || a.x - b.x);
  return (
    <div className="space-y-3">
      {items.map((w) => {
        const C = WIDGET_COMPONENTS[w.type];
        return <div key={w.id} id={`panel-${w.type}`} className="max-h-[70vh] overflow-hidden [&>section]:max-h-[70vh] [&>section>div:last-child]:overflow-y-auto">{C ? <C config={w.config} instanceId={w.id} /> : null}</div>;
      })}
    </div>
  );
}
