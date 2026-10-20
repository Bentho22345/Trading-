'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthCard, Input, post } from '@/components/AuthCard';

function goNext() {
  const next = new URLSearchParams(location.search).get('next') || '/';
  location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<any>(null);
  const [legacy, setLegacy] = useState(false);
  useEffect(() => { fetch('/api/auth/me').then((r) => r.json()).then((m) => { setMeta(m); if (m.user) goNext(); if (!m.has_users && m.legacy_password) setLegacy(true); }).catch(() => {}); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setInfo('');
    try {
      if (legacy) await post('/api/login', { password: pw });
      else await post('/api/auth/login', { email, password: pw, remember });
      goNext();
    } catch (er: any) { setErr(er.message); setBusy(false); }
  };
  return (
    <AuthCard title={legacy ? 'Owner password' : 'Log in'} sub={legacy ? 'The RADAR_PASSWORD set on your server.' : 'Welcome back.'}
      foot={!legacy && <>No account? <Link href="/signup" className="font-semibold text-accent hover:underline">Create one</Link>
        {meta?.legacy_password && <> · <button onClick={() => setLegacy(true)} className="hover:text-white">Use the owner password</button></>}</>}>
      <form onSubmit={submit} className="space-y-2.5">
        {!legacy && <Input type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />}
        <Input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" autoFocus={legacy} />
        {!legacy && (
          <div className="flex items-center justify-between text-[12.5px]">
            <label className="flex items-center gap-2 text-white/65"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-[var(--color-accent)]" />Remember me for 30 days</label>
            <button type="button" onClick={() => email ? post('/api/auth/forgot', { email }).then(() => setInfo('If that email has an account, a reset link is on its way.')).catch((x) => setErr(x.message)) : setErr('Type your email first')}
              className="text-white/55 hover:text-white">Forgot password?</button>
          </div>
        )}
        <button disabled={busy || !pw || (!legacy && !email)} className="btn-primary w-full justify-center disabled:opacity-40">{busy ? 'Checking…' : 'Log in'}</button>
        {err && <p className="text-[12.5px] text-down">{err}{err.includes('Verify') && <> · <button type="button" onClick={() => post('/api/auth/resend', { email }).then(() => setInfo('Verification email sent again.'))} className="underline">resend link</button></>}</p>}
        {info && <p className="text-[12.5px] text-up">{info}</p>}
        {legacy && <button type="button" onClick={() => setLegacy(false)} className="w-full text-[12px] text-white/50 hover:text-white">Log in with email instead</button>}
      </form>
    </AuthCard>
  );
}
