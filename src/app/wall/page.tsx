import type { Metadata } from 'next';
import { WallShell } from '@/components/layout/Wall';

export const metadata: Metadata = { title: 'PULSE — wall' };

export default async function Wall({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const p = await searchParams;
  const w = typeof p.w === 'string' ? p.w : '';
  const s = typeof p.s === 'string' ? Number(p.s) : 20;
  return <WallShell widgets={w} seconds={Number.isFinite(s) ? s : 20} />;
}
