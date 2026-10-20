'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthCard, post } from '@/components/AuthCard';

export default function VerifyPage() {
  const [st, setSt] = useState<'busy' | 'ok' | 'err'>('busy');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const token = new URLSearchParams(location.search).get('token') || '';
    post('/api/auth/verify', { token }).then(() => setSt('ok')).catch((e) => { setSt('err'); setMsg(e.message); });
  }, []);
  return (
    <AuthCard title={st === 'ok' ? 'Email verified' : st === 'err' ? 'Link problem' : 'Verifying…'}
      sub={st === 'ok' ? 'Your account is ready.' : st === 'err' ? msg : 'One moment.'}
      foot={<Link href="/login" className="font-semibold text-accent hover:underline">{st === 'ok' ? 'Log in →' : 'Back to log in'}</Link>}>
      {st === 'ok' && <Link href="/login" className="btn-primary w-full justify-center">Log in</Link>}
    </AuthCard>
  );
}
