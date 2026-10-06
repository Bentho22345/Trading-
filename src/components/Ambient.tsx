'use client';
import { useStore } from '@/lib/store';
import { useCalm } from '@/lib/hooks';
import { useV2 } from '@/lib/v2';

/**
 * Near-subliminal gradient mesh. The drift animates in coarse steps (~1 per second): the
 * gradients are so soft the steps are imperceptible, but it means the glass panels'
 * backdrop-filters only re-rasterize once a second instead of on every frame. Hue drifts toward
 * green or red with market breadth (advancers minus decliners), transitioning over 20s.
 */
export function Ambient() {
  const breadth = useStore((s) => s.analytics?.breadth ?? 0);
  // the cross-asset regime (risk-on/off) drives the tint when available, breadth otherwise
  const regime = useV2((s) => (s.intel.regime?.data as { score?: number } | null | undefined)?.score);
  const calm = useCalm();
  const b = Math.max(-1, Math.min(1, regime !== undefined ? regime / 100 : breadth));
  // 250 (violet) neutral → 150 (green) when broad rally, → 355 (red) when broad sell-off
  const hue = b >= 0 ? 250 - b * 100 : 250 + -b * 105;
  const anim = calm ? 'none' : undefined;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" style={{ ['--hue' as string]: hue }}>
      <div className="absolute inset-0" style={{ opacity: 'var(--ambient, 1)' }}>
      <div className="absolute inset-0 bg-bg" />
      <div
        className="absolute -left-[20%] -top-[30%] h-[90vh] w-[85vw] opacity-[0.14] [transition:background_20s_linear]"
        style={{ background: `radial-gradient(closest-side, hsl(${hue} 80% 55%), hsl(${hue} 80% 55% / 0.35) 45%, transparent)`, animation: anim ?? 'mesh-a 120s steps(90) infinite' }}
      />
      <div
        className="absolute -bottom-[35%] -right-[15%] h-[95vh] w-[80vw] opacity-[0.11] [transition:background_20s_linear]"
        style={{ background: `radial-gradient(closest-side, hsl(${(hue + 40) % 360} 75% 50%), hsl(${(hue + 40) % 360} 75% 50% / 0.3) 50%, transparent)`, animation: anim ?? 'mesh-b 150s steps(110) infinite' }}
      />
      <div
        className="absolute inset-0 opacity-[0.025]"
        style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")" }}
      />
      </div>
    </div>
  );
}
