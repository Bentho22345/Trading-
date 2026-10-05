import type { NewsCluster } from '@shared/types';
import { Terminal } from '@/components/Terminal';

// Render per request so the first screen of headlines is in the HTML (fast LCP); the live
// WebSocket snapshot takes over as soon as the client connects.
export const dynamic = 'force-dynamic';

async function initialNews(): Promise<NewsCluster[]> {
  const worker = process.env.PULSE_WORKER_URL || 'http://127.0.0.1:4000';
  try {
    const res = await fetch(`${worker}/api/news?limit=12`, { cache: 'no-store', signal: AbortSignal.timeout(600) });
    return res.ok ? ((await res.json()) as NewsCluster[]) : [];
  } catch {
    return []; // worker not up yet — the client shows skeletons and connects on its own
  }
}

export default async function Page() {
  return <Terminal initialClusters={await initialNews()} />;
}
