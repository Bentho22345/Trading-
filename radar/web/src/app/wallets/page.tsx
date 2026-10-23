'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** The old top-wallets leaderboard was replaced by Top Traders. */
export default function WalletsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/traders'); }, [router]);
  return <p className="p-10 text-white/40">Top wallets moved to Top Traders…</p>;
}
