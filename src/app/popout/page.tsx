import type { Metadata } from 'next';
import { PopoutShell } from '@/components/layout/Popout';

export const metadata: Metadata = { title: 'PULSE — panel' };

export default async function Popout({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const p = await searchParams;
  const one = (k: string) => (Array.isArray(p[k]) ? p[k]![0] : (p[k] as string | undefined)) ?? '';
  return <PopoutShell type={one('w')} cfg={one('c')} title={one('t')} />;
}
