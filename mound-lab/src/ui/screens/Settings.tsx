import { useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { backupAll, restoreAll } from '../export';

export function SettingsScreen() {
  const { settings, setSettings, toast } = useStore();
  const file = useRef<HTMLInputElement>(null);
  const [videos, setVideos] = useState(true);
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <h1>Settings</h1>
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
        <p className="small muted">Models run on this device (WebGPU/WebGL when available, otherwise CPU) and are cached for offline use.</p>
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
