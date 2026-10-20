'use client';
import Link from 'next/link';
import { useState } from 'react';
import { AuthCard, Input, post } from '@/components/AuthCard';

export default function ResetPage() {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    try { await post('/api/auth/reset', { token: new URLSearchParams(location.search).get('token') || '', password: pw }); setOk(true); } catch (er: any) { setErr(er.message); }
  };
  return (
    <AuthCard title={ok ? 'Password changed' : 'New password'} sub={ok ? 'Every device was signed out. Log in with the new password.' : 'Choose a new password.'}
      foot={<Link href="/login" className="font-semibold text-accent hover:underline">Log in</Link>}>
      {!ok && <form onSubmit={submit} className="space-y-2.5">
        <Input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" autoComplete="new-password" />
        <button disabled={!pw} className="btn-primary w-full justify-center disabled:opacity-40">Save password</button>
        {err && <p className="text-[12.5px] text-down">{err}</p>}
      </form>}
    </AuthCard>
  );
}
