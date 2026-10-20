'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthCard, Input, post } from '@/components/AuthCard';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<any>(null);
  useEffect(() => { fetch('/api/auth/me').then((r) => r.json()).then(setMeta).catch(() => {}); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (pw !== pw2) { setErr("Passwords don't match"); return; }
    setBusy(true);
    try {
      await post('/api/auth/signup', { email, password: pw, name: name || undefined, remember: true });
      const next = new URLSearchParams(location.search).get('next') || '/';
      location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch (er: any) { setErr(er.message); setBusy(false); }
  };
  return (
    <AuthCard title="Create account" sub={meta && !meta.has_users ? 'The first account becomes the owner of this Radar.' : 'Email and password — you’re signed in straight away, and this device stays remembered.'}
      foot={<>Already have one? <Link href="/login" className="font-semibold text-accent hover:underline">Log in</Link></>}>
      {meta && meta.has_users && !meta.signup_open ? (
        <p className="text-[13px] text-white/65">Sign-ups are closed on this Radar. Ask the owner to open them from their Account page.</p>
      ) : (
        <form onSubmit={submit} className="space-y-2.5">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" autoComplete="name" />
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoComplete="email" />
          <Input type="password" required value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password (10+ characters, a number or capital)" autoComplete="new-password" />
          <Input type="password" required value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Repeat password" autoComplete="new-password" />
          <button disabled={busy || !email || !pw} className="btn-primary w-full justify-center disabled:opacity-40">{busy ? 'Creating…' : 'Create account'}</button>
          {err && <p className="text-[12.5px] text-down">{err}</p>}
        </form>
      )}
    </AuthCard>
  );
}
