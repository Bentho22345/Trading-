import { useEffect, useRef, useState } from 'react';
import { currentSession } from '../../auth/session';
import { signOut } from '../../auth/accounts';
import { Avatar } from '../screens/Auth';

/** Header chip: who's signed in, switch person, sign out. */
export function UserMenu() {
  const s = currentSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  if (!s) return null;
  const leave = () => { signOut(); location.reload(); };
  return (
    <div className="user-menu" ref={ref}>
      <button className="user-chip" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid="user-chip" title={s.guest ? 'Guest (no account)' : `Signed in as ${s.name}`}>
        <Avatar name={s.name} color={s.color} size={28} />
        <span className="user-name">{s.name}</span>
      </button>
      {open && (
        <div className="user-pop" role="menu">
          <div className="small">{s.guest ? <><b>Guest</b><br /><span className="tiny faint">Clips are saved in this browser without an account.</span></> : <><b>{s.name}</b><br /><span className="tiny faint">{s.email}{s.remember ? ' · stays signed in' : ''}</span></>}</div>
          {!s.guest && <a className="btn" href="#/settings" onClick={() => setOpen(false)}>Account settings</a>}
          <button onClick={leave} data-testid="switch-user">{s.guest ? 'Sign in or create account' : 'Switch person'}</button>
          {!s.guest && <button onClick={leave} data-testid="sign-out">Sign out</button>}
        </div>
      )}
    </div>
  );
}
