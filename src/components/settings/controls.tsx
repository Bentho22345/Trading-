'use client';
import type { ReactNode } from 'react';

export function Section({ title, description, children, right }: { title: string; description?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text">{title}</h3>
          {description ? <p className="mt-0.5 max-w-2xl text-xs text-faint">{description}</p> : null}
        </div>
        {right}
      </div>
      <div className="divide-y divide-line rounded-xl border border-line bg-panel">{children}</div>
    </section>
  );
}

export function Row({ label, hint, children, warn }: { label: string; hint?: ReactNode; children: ReactNode; warn?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-setting={label.toLowerCase()}>
      <div className="min-w-0">
        <div className="text-xs font-medium text-text">{label}</div>
        {hint ? <div className="mt-0.5 text-[11px] text-faint">{hint}</div> : null}
        {warn ? <div className="mt-0.5 text-[11px] text-warn">{warn}</div> : null}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-line-strong'}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

export function Slider({ value, min, max, step = 1, onChange, label, format }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string; format?: (v: number) => string }) {
  return (
    <span className="flex items-center gap-2">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-40 accent-[var(--accent)]" aria-label={label} />
      <span className="num w-12 text-right text-[11px] text-dim">{format ? format(value) : value}</span>
    </span>
  );
}

export const inputCls = 'rounded-lg border border-line bg-bg-2/60 px-2 py-1 text-xs text-text focus:border-accent/60 focus:outline-none';
export const btnCls = 'rounded-lg border border-line px-2.5 py-1 text-xs text-dim hover:border-line-strong hover:text-text disabled:opacity-40';
export const primaryBtn = 'rounded-lg border border-accent/50 bg-accent/15 px-2.5 py-1 text-xs font-medium text-text hover:bg-accent/25 disabled:opacity-40';

export function download(name: string, data: string, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
