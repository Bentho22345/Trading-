import type { Metadata } from 'next';
import { AdminConsole } from '@/components/power/Admin';

export const metadata: Metadata = { title: 'PULSE — admin' };
export default function Admin() {
  return <AdminConsole />;
}
