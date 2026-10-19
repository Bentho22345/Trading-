import { useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { backupAll, restoreAll } from '../export';
import { currentSession, saveSession } from '../../auth/session';
import { changePassword, deleteAccount, renameAccount, signOut } from '../../auth/accounts';
import { Avatar } from './Auth';

function AccountCard() {
  const s = currentSession();
  const toast = useStore((st) => st.toast);
  const [name, setName] = useState(s?.name ?? '');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const leave = () => { signOut(); location.reload(); };
  if (s.guest) return (
    <div className="card stack">
      <h2>Account</h2>
      <p className="small muted">You're using Mound Lab without an account. Create one to keep each person's clips, athletes and settings separate, and to stay signed in on this device. Clips saved now can be moved into the new account.</p>
      <div className="row"><button className="accent" onClick={leave}>Sign in or create account</button></div>
    </div>
  );
  const run = async (f: () => Promise<void>, ok: string) => {
    setBusy(true);
    try { await f(); toast(ok); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="card stack" data-testid="account-card">
      <div className="row"><Avatar name={s.name} color={s.color} size={44} /><div><h2 style={{ margin: 0 }}>{s.name}</h2><span className="small muted">{s.email} · {s.remember ? 'stays signed in on this device' : 'signed in until the browser closes'}</span></div></div>
      <div className="row">
        <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <button disabled={busy || !name.trim() || name.trim() === s.name} onClick={() => run(async () => { await renameAccount(s.userId!, name); saveSession({ ...s, name: name.trim() }); }, 'Name updated — it shows everywhere after the next reload.')}>Save name</button>
      </div>
      <div className="row">
        <label className="field">Current password<input type="password" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} /></label>
        <label className="field">New password<input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} /></label>
        <button disabled={busy || !oldPw || !newPw} onClick={() => run(async () => { await changePassword(s.userId!, oldPw, newPw); setOldPw(''); setNewPw(''); }, 'Password changed.')}>Change password</button>
      </div>
      <div className="row">
        <button onClick={() => { saveSession({ ...s, remember: !s.remember }); location.reload(); }}>{s.remember ? 'Stop remembering me on this device' : 'Keep me signed in on this device'}</button>
        <button onClick={leave}>Sign out</button>
        <button className="ghost" style={{ color: 'var(--bad)' }} disabled={busy} onClick={() => {
          if (prompt(`This deletes ${s.name}'s account and every clip, athlete and analysis in it from this device. Type DELETE to confirm.`) !== 'DELETE') return;
          void run(async () => { await deleteAccount(s.userId!); leave(); }, 'Account deleted.');
        }}>Delete account…</button>
      </div>
      <p className="tiny faint" style={{ margin: 0 }}>Accounts are stored on this device only (there is no server), so a forgotten password can't be reset — export a backup below to keep your library safe.</p>
    </div>
  );
}

export function SettingsScreen() {
  const { settings, setSettings, toast } = useStore();
  const file = useRef<HTMLInputElement>(null);
  const [videos, setVideos] = useState(true);
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <h1>Settings</h1>
      <AccountCard />
      <div className="card stack">
        <h2>Display</h2>
        <div className="row">
          <label className="field">Theme
            <select value={settings.theme} onChange={(e) => setSettings({ theme: e.target.value as 'system' | 'light' | 'dark' })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>
          </label>
          <label className="field">Units
            <select value={settings.units} onChange={(e) => setSettings({ units: e.target.value as 'imperial' | 'metric' })}><option value="imperial">Imperial (ft/in)</option><option value="metric">Metric (m/cm)</option></select>
          </label>
          <label className="field">Default handedness
            <select value={settings.handedness} onChange={(e) => setSettings({ handedness: e.target.value as 'R' | 'L' })}><option value="R">Right</option><option value="L">Left</option></select>
          </label>
          <label className="row tight small"><input type="checkbox" checked={settings.reducedMotion} onChange={(e) => setSettings({ reducedMotion: e.target.checked })} /> Reduce motion</label>
        </div>
        <label className="row tight"><input type="checkbox" checked={settings.youth} onChange={(e) => setSettings({ youth: e.target.checked })} /> <b>Youth mode</b> — simpler language, top-3 findings only, no reference ranges, workload reminders first</label>
      </div>
      <div className="card stack">
        <h2>Analysis</h2>
        <label className="field">Pose model
          <select value={settings.model} onChange={(e) => setSettings({ model: e.target.value as 'full' | 'lite' })}><option value="full">MediaPipe Pose full (accurate)</option><option value="lite">MediaPipe Pose lite (fast preview)</option></select>
        </label>
        <label className="field">Tracking engine
          <select value={settings.poseEngine} onChange={(e) => setSettings({ poseEngine: e.target.value as 'auto' | 'mediapipe' | 'movenet' })} data-testid="engine-select">
            <option value="auto">Automatic (recommended): MediaPipe, MoveNet from behind and for missed frames</option>
            <option value="mediapipe">MediaPipe only (adds 3D estimate, misses pitchers filmed from behind)</option>
            <option value="movenet">MoveNet only (any angle, 2D only)</option>
          </select>
        </label>
        <label className="row tight"><input type="checkbox" checked={settings.autoAnalyze} onChange={(e) => setSettings({ autoAnalyze: e.target.checked })} /> Analyse new clips automatically as soon as they're dropped in</label>
        <p className="small muted">Models run on this device (WebGPU/WebGL when available, otherwise CPU) and are cached for offline use. People are found with MoveNet MultiPose, which sees a pitcher from any side, including center-field cameras.</p>
      </div>
      <div className="card stack">
        <h2>AI coach (optional)</h2>
        <p className="small muted">The AI coach is off unless you add your own Anthropic API key. The key is stored only in this browser's local storage and sent directly to Anthropic when you request a report. Only numbers, your notes and small annotated stills are sent — never the video.</p>
        <label className="field">Anthropic API key
          <input type="password" value={settings.apiKey ?? ''} placeholder="sk-ant-…" onChange={(e) => setSettings({ apiKey: e.target.value.trim() || undefined })} />
        </label>
        <label className="field">Model
          <select value={settings.aiModel} onChange={(e) => setSettings({ aiModel: e.target.value })}>
            <option value="claude-opus-5-5">Claude Opus 5.5</option>
            <option value="claude-sonnet-5-5">Claude Sonnet 5.5</option>
            <option value="claude-haiku-5-5">Claude Haiku 5.5</option>
          </select>
        </label>
      </div>
      <div className="card stack">
        <h2>Your data</h2>
        <p className="small muted">Everything lives in this browser (IndexedDB). Back it up to one file you can restore anywhere — your work is never trapped here.</p>
        <label className="row tight small"><input type="checkbox" checked={videos} onChange={(e) => setVideos(e.target.checked)} /> include video files (bigger backup)</label>
        <div className="row">
          <button onClick={() => backupAll(videos).then(() => toast('Backup downloaded'))}>Download backup</button>
          <button onClick={() => file.current?.click()}>Restore from backup…</button>
          <input ref={file} type="file" accept="application/json,.json" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try { const n = await restoreAll(f); toast(`Restored ${n} clips — reloading`); setTimeout(() => location.reload(), 800); } catch (err) { toast((err as Error).message, 'error'); }
          }} />
        </div>
      </div>
      <div className="card small">
        <h2>Keyboard</h2>
        <p><span className="kbd">Space</span> play/pause · <span className="kbd">←</span>/<span className="kbd">→</span> frame · <span className="kbd">[</span>/<span className="kbd">]</span> previous/next event · <span className="kbd">1</span>–<span className="kbd">8</span> jump to event · <span className="kbd">O</span> overlay · <span className="kbd">S</span> sync mode · <span className="kbd">Ctrl/⌘+V</span> paste a video</p>
      </div>
    </div>
  );
}
