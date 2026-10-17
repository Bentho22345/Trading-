import { useRef } from 'react';
import { useStore, type RuntimeClip } from '../../state/store';
import { ClipThumb, Disclaimer } from '../components/common';
import { go } from '../router';
import { RecordButton } from '../components/Recorder';

function SlotCard({ slot, clip }: { slot: 'A' | 'B'; clip?: RuntimeClip }) {
  const importFiles = useStore((s) => s.importFiles);
  const setSlot = useStore((s) => s.setSlot);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={`slot ${slot.toLowerCase()}`} data-drop={slot} data-testid={`slot-${slot}`}>
      <span className={slot === 'A' ? 'chip-a' : 'chip-b'}>{slot}</span>
      {clip ? (
        <>
          <ClipThumb clip={clip} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-testid={`slot-${slot}-name`}>{clip.record.name}</div>
            <div className="small muted" data-testid={`slot-${slot}-fps`}>
              {clip.record.meta.fpsMedia ? `${Math.round(clip.record.meta.fpsMedia * clip.record.slowmo)} fps` : ''}
              {clip.record.meta.durationS ? ` · ${clip.record.meta.durationS.toFixed(1)} s` : ''}
              {clip.status === 'ready' ? ' · analysed' : clip.status === 'analyzing' ? ' · analysing…' : clip.status === 'error' ? ' · error' : ''}
            </div>
            <div className="row tight" style={{ marginTop: 6 }}>
              <button className="small" onClick={() => go(`/clip/${clip.id}`)}>Open</button>
              <button className="small ghost" onClick={() => input.current?.click()}>Replace</button>
              <button className="small ghost" onClick={() => setSlot(slot, undefined)} aria-label={`Clear slot ${slot}`}>Clear</button>
            </div>
          </div>
        </>
      ) : (
        <button className="ghost" style={{ flex: 1, justifyContent: 'flex-start' }} onClick={() => input.current?.click()}>
          Drop a video here or choose a file
        </button>
      )}
      <input ref={input} type="file" accept="video/*,.mov,.mp4,.m4v,.webm" hidden onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) void importFiles(f, slot); e.target.value = ''; }} />
    </div>
  );
}

export function Home() {
  const { clips, order, slotA, slotB, importFiles } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const recent = order.map((id) => clips[id]).filter(Boolean).slice(0, 8);
  const a = slotA ? clips[slotA] : undefined, b = slotB ? clips[slotB] : undefined;
  return (
    <div className="stack">
      <div
        className="hero-drop"
        role="button"
        tabIndex={0}
        data-testid="hero-drop"
        onClick={() => input.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
      >
        <div className="big">Drop pitch videos here</div>
        <div className="muted">Drop one or two clips anywhere on the page, choose files, or paste (Ctrl/⌘+V). Two clips fill A and B and you can compare them right away.</div>
        <div className="row" onClick={(e) => e.stopPropagation()}>
          <button className="primary" onClick={() => input.current?.click()}>Choose videos</button>
          <RecordButton />
          <a className="btn" href="#/guide">How to film</a>
        </div>
        <div className="tiny faint">MP4 · MOV · WebM — processed on this device, nothing is uploaded.</div>
        <input ref={input} type="file" accept="video/*,.mov,.mp4,.m4v,.webm" multiple hidden data-testid="file-input" onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) void importFiles(f); e.target.value = ''; }} />
      </div>

      <div className="grid cols-2">
        <SlotCard slot="A" clip={a} />
        <SlotCard slot="B" clip={b} />
      </div>
      <div className="row">
        <button className="accent" disabled={!a || !b} onClick={() => go('/compare')} data-testid="compare-btn">Compare A vs B</button>
        <button className="ghost" disabled={!a || !b} onClick={() => useStore.getState().swapSlots()}>Swap A ↔ B</button>
        {a?.kind === 'demo' && <span className="small muted">Slots hold a synthetic demo pitcher so you can explore a full comparison before filming.</span>}
      </div>

      <section className="card">
        <div className="card-title"><h2>Recent clips</h2><a href="#/library">Library →</a></div>
        <div className="grid cols-auto">
          {recent.map((c) => (
            <div key={c.id} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <ClipThumb clip={c} />
              <div style={{ minWidth: 0 }}>
                <a href={`#/clip/${c.id}`} style={{ fontWeight: 600, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.record.name}</a>
                <div className="tiny muted">{new Date(c.record.createdAt).toLocaleDateString()} · {c.status === 'ready' ? 'analysed' : c.status}</div>
                <div className="row tight" style={{ marginTop: 4 }}>
                  <button className="small" onClick={() => useStore.getState().setSlot('A', c.id)}>→ A</button>
                  <button className="small" onClick={() => useStore.getState().setSlot('B', c.id)}>→ B</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid cols-3">
        <div className="card flat"><h3>1 · Drop</h3><p className="muted small">Side view from the open side (RHP: third-base side) at hip height, 120–240 fps, tripod. Add a front view from behind home plate for arm slot and side bend.</p></div>
        <div className="card flat"><h3>2 · Analyse</h3><p className="muted small">The pose model runs in your browser. Every event (leg lift, foot strike, layback, release) is found automatically and can be nudged frame by frame.</p></div>
        <div className="card flat"><h3>3 · Compare</h3><p className="muted small">Two pitches play in sync phase by phase. Changes are ranked by size against normal pitch-to-pitch noise, with the likely root cause, a cue and drills.</p></div>
      </div>
      <Disclaimer />
    </div>
  );
}
