'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';

export async function post<T = any>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
  return j as T;
}

export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className={`w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-[14px] outline-none transition focus:border-accent focus:bg-white/[0.05] ${p.className || ''}`} />
);

export function AuthCard({ title, sub, children, foot }: { title: string; sub?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="mx-auto mt-16 max-w-md">
      <div className="mb-6 flex items-center justify-center gap-2">
        <span className="relative flex h-9 w-9 items-center justify-center">
          <span className="absolute inset-0 rounded-full border-2 border-white/90" />
          <span className="absolute inset-[6px] rounded-full bg-accent shadow-[0_0_18px_var(--color-accent)]" />
        </span>
        <span className="display text-[28px] tracking-wide">Radar</span>
      </div>
      <div className="glass rounded-[28px] border border-accent/25 p-7 shadow-[0_0_80px_-30px_var(--color-accent)]">
        <h1 className="display text-[34px]">{title}</h1>
        {sub && <p className="mb-5 mt-1 text-[13px] text-white/55">{sub}</p>}
        {children}
      </div>
      {foot && <div className="mt-4 text-center text-[13px] text-white/55">{foot}</div>}
      <p className="mt-6 text-center text-[11px] text-white/30"><Link href="/">Memecoin Radar</Link> · not financial advice</p>
    </div>
  );
}
