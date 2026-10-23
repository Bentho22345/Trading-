'use client';
import Link from 'next/link';
import { AuthCard } from '@/components/AuthCard';

// Email verification is gone — old links from earlier sign-ups land here and go straight to log in.
export default function VerifyPage() {
  return (
    <AuthCard title="No verification needed" sub="Accounts are ready the moment they're created. Just log in."
      foot={<Link href="/signup" className="font-semibold text-accent hover:underline">Create an account</Link>}>
      <Link href="/login" className="btn-primary w-full justify-center">Log in</Link>
    </AuthCard>
  );
}
