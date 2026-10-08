'use client';
import { useState } from 'react';

export default function LoginPage() {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    if (r.ok) {
      const next = new URLSearchParams(location.search).get('next') || '/';
      location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } else {
      setErr((await r.json().catch(() => ({}))).detail || 'Login failed');
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto mt-24 max-w-sm rounded border border-line bg-panel p-5">
      <h1 className="mb-1 text-lg font-bold"><span className="text-accent">◉</span> Memecoin Radar</h1>
      <p className="mb-4 text-[11px] text-mute">Private terminal. Enter the password set in RADAR_PASSWORD.</p>
      <form onSubmit={submit} className="space-y-2">
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password"
          className="w-full rounded border border-line bg-panel2 px-2 py-2 outline-none focus:border-accent" />
        <button disabled={busy || !pw} className="w-full rounded bg-accent/20 py-2 text-accent disabled:opacity-40">{busy ? 'Checking…' : 'Unlock'}</button>
        {err && <p className="text-down">{err}</p>}
      </form>
    </div>
  );
}
