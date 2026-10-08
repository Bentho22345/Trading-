'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** The old smart-money leaderboard was replaced by Top Traders. */
export default function SmartMoneyRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/traders'); }, [router]);
  return <p className="p-10 text-white/40">Smart money moved to Top Traders…</p>;
}
