import type { Metadata } from 'next';
import { MobileCompanion } from '@/components/power/Mobile';

export const metadata: Metadata = { title: 'PULSE' };
export default function Mobile() {
  return <MobileCompanion />;
}
