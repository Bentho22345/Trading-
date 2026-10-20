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
  const [done, setDone] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<any>(null);
  useEffect(() => { fetch('/api/auth/me').then((r) => r.json()).then(setMeta).catch(() => {}); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (pw !== pw2) { setErr("Passwords don't match"); return; }
    setBusy(true);
    try { setDone(await post('/api/auth/signup', { email, password: pw, name: name || undefined })); } catch (er: any) { setErr(er.message); }
    setBusy(false);
  };
  if (done) return (
    <AuthCard title="Check your email" sub={<>We sent a verification link to <b className="text-white">{email}</b>. Click it to finish.</>}
      foot={<Link href="/login" className="font-semibold text-accent hover:underline">Back to log in</Link>}>
      {done.role === 'owner' && <p className="text-[13px] text-white/70">You&apos;re the first account, so you&apos;re the <b className="text-accent">owner</b> — full control, including Autopilot.</p>}
      {!done.sent && <p className="mt-3 rounded-xl border border-warn/30 bg-warn/10 p-3 text-[12.5px] text-warn">Email isn&apos;t set up on this server yet, so the link was written to the server log
        (Render → your service → Logs, search &quot;EMAIL NOT CONFIGURED&quot;). Add an email provider on the Connectors page to send real emails.</p>}
      <button onClick={() => post('/api/auth/resend', { email }).then(() => setErr('Sent again.')).catch((x) => setErr(x.message))} className="mt-4 text-[12.5px] text-white/55 hover:text-white">Didn&apos;t get it? Resend</button>
      {err && <p className="mt-1 text-[12.5px] text-white/60">{err}</p>}
    </AuthCard>
  );
  return (
    <AuthCard title="Create account" sub={meta && !meta.has_users ? 'The first account becomes the owner of this Radar.' : 'Email and password. We’ll send a link to verify your email.'}
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
