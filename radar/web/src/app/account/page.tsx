'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { post } from '@/components/AuthCard';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useNow } from '@/lib/live';

export default function AccountPage() {
  const [me, setMe] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const now = useNow(30000);
  const load = useCallback(async () => {
    const m = await fetch('/api/auth/me').then((r) => r.json());
    setMe(m);
    api('/api/auth/sessions').then(setSessions).catch(() => {});
    if (m.user?.role === 'owner' && m.user?.id) api('/api/auth/users').then(setUsers).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  const u = me?.user;
  if (me && !u) return <div className="pt-16 text-center"><Link href="/login" className="btn-primary">Log in</Link></div>;
  return (
    <div className="mx-auto max-w-4xl pt-4">
      <div className="eyebrow mb-3">Account</div>
      <h1 className="display text-[56px] md:text-[80px]">{u?.name || u?.email?.split('@')[0] || '…'}</h1>
      <p className="mt-1 text-[14px] text-white/55">{u?.email} · <span className="font-semibold capitalize text-accent">{u?.role}</span></p>
      <div className="mt-4 flex gap-2">
        <button onClick={() => post('/api/auth/logout', {}).then(() => { location.href = '/login'; })} className="btn-ghost">Log out</button>
        {u?.id ? <button onClick={() => post('/api/auth/forgot', { email: u.email }).then(() => alert('Password reset link sent to your email.'))} className="btn-ghost">Change password</button> : null}
      </div>

      <section className="glass mt-8 rounded-[28px] p-6">
        <div className="display mb-3 text-[26px]">Signed-in devices</div>
        <ul className="divide-y divide-white/[0.06]">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
              <span className="max-w-[420px] truncate text-white/80" title={s.device}>{s.device || 'Unknown device'}</span>
              {s.current && <span className="rounded-full bg-accent/20 px-2 text-[10.5px] font-bold text-accent">this device</span>}
              <span className="text-white/45">{s.ip} · active {ago(s.last_seen, now)} ago · {s.remember ? 'remembered 30 days' : 'this session'}</span>
              {!s.current && <button onClick={() => fetch(`/api/auth/sessions/${s.id}`, { method: 'DELETE' }).then(load)} className="ml-auto text-[12px] text-white/50 hover:text-down">Sign out</button>}
            </li>
          ))}
          {!sessions.length && <li className="py-3 text-[13px] text-white/45">{u?.id ? 'No other devices.' : 'Logged in with the owner password (no device list).'}</li>}
        </ul>
      </section>

      {u?.role === 'owner' && (
        <section className="glass mt-6 rounded-[28px] p-6">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <span className="display text-[26px]">People</span>
            <label className="ml-auto flex items-center gap-2 text-[13px] text-white/70">
              <input type="checkbox" checked={!!me?.signup_open} onChange={(e) => post('/api/auth/signup-setting', { open: e.target.checked }).then(load)} className="accent-[var(--color-accent)]" />
              Anyone with the link can sign up (as read-only members)
            </label>
          </div>
          {!me?.email_configured && <p className="mb-3 rounded-xl border border-warn/30 bg-warn/10 p-3 text-[12.5px] text-warn">
            Email isn&apos;t configured — verification links go to the server log. Add <Link href="/connectors" className="underline">Email</Link> on Connectors (Resend or Gmail SMTP).</p>}
          <table className="w-full text-[13px]">
            <tbody>
              {users.map((x) => (
                <tr key={x.id} className="border-t border-white/[0.06]">
                  <td className="py-2">{x.email}{x.name ? <span className="text-white/45"> · {x.name}</span> : null}</td>
                  <td className="capitalize text-white/70">{x.role}</td>
                  <td>{x.verified ? <span className="text-up">verified</span> : <button onClick={() => post(`/api/auth/users/${x.id}`, { verified: true }).then(load)} className="text-warn underline">verify manually</button>}</td>
                  <td className="text-white/45">{x.last_login ? `${ago(x.last_login, now)} ago` : 'never'}</td>
                  <td className="text-right">
                    {x.id !== u.id && <>
                      <button onClick={() => post(`/api/auth/users/${x.id}`, { role: x.role === 'owner' ? 'member' : 'owner' }).then(load)} className="mr-3 text-[12px] text-white/55 hover:text-white">{x.role === 'owner' ? 'Make member' : 'Make owner'}</button>
                      <button onClick={() => confirm(`Delete ${x.email}?`) && fetch(`/api/auth/users/${x.id}`, { method: 'DELETE' }).then(load)} className="text-[12px] text-white/40 hover:text-down">Delete</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[11.5px] text-white/40">Owners control everything, including Autopilot and real money. Members can look but not change anything.</p>
        </section>
      )}
    </div>
  );
}
