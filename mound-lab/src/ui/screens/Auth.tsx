// Sign-in screen: pick a remembered person, sign in, create an account, or continue as a guest.

import { useEffect, useState } from 'react';
import { continueAsGuest, createAccount, guestClipCount, listAccounts, moveGuestData, normEmail, passwordProblem, signIn, type Account, type Role } from '../../auth/accounts';

type Mode = 'pick' | 'signin' | 'create';

const ROLES: [Role, string][] = [['pitcher', 'Pitcher'], ['coach', 'Coach'], ['parent', 'Parent'], ['other', 'Other']];

export function Avatar({ name, color, size = 36 }: { name: string; color: string; size?: number }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  return <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.42 }} aria-hidden>{initials}</span>;
}

function ago(t: number) {
  const d = Math.round((Date.now() - t) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

export function AuthScreen({ onDone }: { onDone: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('pitcher');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [guestClips, setGuestClips] = useState(0);
  const [moveGuest, setMoveGuest] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Account | null>(null);

  useEffect(() => {
    void listAccounts().then((a) => { setAccounts(a); setMode(a.length ? 'pick' : 'create'); });
    void guestClipCount().then(setGuestClips);
  }, []);

  const go = (m: Mode) => { setMode(m); setError(null); setPassword(''); setConfirm(''); };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (mode === 'create') {
        if (password !== confirm) throw new Error("The two passwords don't match.");
        setBusy('Creating your account…');
        const acc = await createAccount({ name, email, password, role, remember });
        if (moveGuest && guestClips) await moveGuestData(acc.id, (m) => setBusy(m));
      } else {
        setBusy('Signing in…');
        await signIn(chosen?.email ?? email, password, remember);
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  const pwProblem = mode === 'create' && password ? passwordProblem(password) : null;

  return (
    <div className="auth-wrap">
      <div className="auth-card card stack">
        <div className="auth-brand">
          <img className="brand-mark" src="./icons/icon.svg" alt="" />
          <span className="brand-name">Mound<em>Lab</em></span>
        </div>

        {accounts === null ? <p className="muted">Loading…</p> : mode === 'pick' ? (
          <>
            <h1 className="auth-title">Who's working today?</h1>
            <ul className="account-list" data-testid="account-list">
              {accounts.map((a) => (
                <li key={a.id}>
                  <button className="account-row" onClick={() => { setChosen(a); setEmail(a.email); go('signin'); }}>
                    <Avatar name={a.name} color={a.color} />
                    <span className="account-text"><b>{a.name}</b><span className="tiny faint">{a.email} · last in {ago(a.lastLogin)}</span></span>
                    <span aria-hidden>›</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="row">
              <button onClick={() => { setChosen(null); setEmail(''); go('signin'); }}>Another account</button>
              <button onClick={() => { setChosen(null); go('create'); }} data-testid="to-create">Create account</button>
            </div>
          </>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            <h1 className="auth-title">{mode === 'create' ? 'Create your account' : chosen ? `Welcome back, ${chosen.name.split(' ')[0]}` : 'Sign in'}</h1>
            {chosen && mode === 'signin' && (
              <div className="row tight"><Avatar name={chosen.name} color={chosen.color} size={28} /><span className="small">{chosen.email}</span>
                <button type="button" className="small" onClick={() => { setChosen(null); go(accounts.length ? 'pick' : 'signin'); }}>Not you?</button></div>
            )}
            {mode === 'create' && (
              <>
                <label className="field">Name<input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required data-testid="auth-name" /></label>
                <label className="field">I am a
                  <select value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </label>
              </>
            )}
            {!(chosen && mode === 'signin') && (
              <label className="field">Email<input type="email" autoComplete={mode === 'create' ? 'email' : 'username'} value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="auth-email" /></label>
            )}
            <label className="field">Password
              <span className="row tight" style={{ flexWrap: 'nowrap' }}>
                <input type={show ? 'text' : 'password'} autoComplete={mode === 'create' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required style={{ flex: 1 }} data-testid="auth-password" autoFocus={!!chosen} />
                <button type="button" className="small" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? 'Hide' : 'Show'}</button>
              </span>
            </label>
            {pwProblem && <span className="tiny" style={{ color: 'var(--bad)' }}>{pwProblem}</span>}
            {mode === 'create' && (
              <label className="field">Confirm password<input type={show ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required data-testid="auth-confirm" /></label>
            )}
            <label className="row tight small"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} data-testid="auth-remember" /> Keep me signed in on this device</label>
            {mode === 'create' && guestClips > 0 && (
              <label className="row tight small"><input type="checkbox" checked={moveGuest} onChange={(e) => setMoveGuest(e.target.checked)} /> Move the {guestClips} clip{guestClips === 1 ? '' : 's'} saved without an account into this account</label>
            )}
            {error && <div className="notice bad small" role="alert" data-testid="auth-error">{error}</div>}
            <button className="accent" type="submit" disabled={!!busy || (mode === 'create' && (!name.trim() || !normEmail(email) || !!pwProblem || !password))} data-testid="auth-submit">
              {busy ?? (mode === 'create' ? 'Create account' : 'Sign in')}
            </button>
            <div className="row small">
              {mode === 'create'
                ? <span>Already have an account? <button type="button" className="linklike" onClick={() => go(accounts.length ? 'pick' : 'signin')}>Sign in</button></span>
                : <span>New here? <button type="button" className="linklike" onClick={() => { setChosen(null); go('create'); }}>Create an account</button></span>}
            </div>
          </form>
        )}

        <hr className="auth-sep" />
        <button onClick={() => { continueAsGuest(remember); onDone(); }} data-testid="auth-guest">Continue without an account</button>
        <p className="tiny faint" style={{ margin: 0 }}>
          Accounts live on this device: each person gets their own clips, athletes and settings, and stays signed in if they choose.
          Nothing is uploaded — your password is stored only as a salted hash, and videos never leave the device. Accounts don't sync between devices.
        </p>
      </div>
    </div>
  );
}
