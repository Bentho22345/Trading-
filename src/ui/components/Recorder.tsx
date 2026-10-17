// Record from the camera (MediaRecorder) with a countdown, framing silhouette and simple live checks.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';

export function RecordButton() {
  const [open, setOpen] = useState(false);
  const can = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  if (!can) return null;
  return (
    <>
      <button onClick={() => setOpen(true)}>Record</button>
      {open && <RecorderDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function RecorderDialog({ onClose }: { onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [checks, setChecks] = useState<string[]>([]);
  const [fps, setFps] = useState<number | null>(null);
  const importFiles = useStore((s) => s.importFiles);

  useEffect(() => {
    let s: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', frameRate: { ideal: 240 }, width: { ideal: 1280 } }, audio: false })
      .then((st) => { s = st; setStream(st); setFps(st.getVideoTracks()[0]?.getSettings().frameRate ?? null); if (video.current) { video.current.srcObject = st; void video.current.play(); } })
      .catch((e) => setErr(`Camera unavailable: ${(e as Error).message}`));
    return () => s?.getTracks().forEach((t) => t.stop());
  }, []);

  // live framing checks: brightness and (if supported) device tilt
  useEffect(() => {
    let raf = 0, tilt: number | null = null;
    const onOrient = (e: DeviceOrientationEvent) => { if (e.gamma !== null) tilt = e.gamma; };
    window.addEventListener('deviceorientation', onOrient);
    const tick = () => {
      const v = video.current, c = canvas.current;
      if (v && c && v.videoWidth) {
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        c.width = 64; c.height = 36;
        ctx.drawImage(v, 0, 0, 64, 36);
        const d = ctx.getImageData(0, 0, 64, 36).data;
        let lum = 0;
        for (let i = 0; i < d.length; i += 4) lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        lum /= d.length / 4;
        const out: string[] = [];
        if (lum < 60) out.push('Too dark — add light or move to a brighter spot.');
        if (lum > 225) out.push('Very bright — avoid filming into the sun.');
        if (tilt !== null && Math.abs(tilt) > 4 && Math.abs(tilt) < 86) out.push(`Phone is tilted ${Math.round(Math.abs(tilt))}° — level the tripod.`);
        if (v.videoHeight > v.videoWidth) out.push('Portrait video: landscape usually fits the whole stride better.');
        setChecks(out);
      }
      raf = window.setTimeout(tick, 700) as unknown as number;
    };
    tick();
    return () => { clearTimeout(raf); window.removeEventListener('deviceorientation', onOrient); };
  }, [stream]);

  const start = () => {
    if (!stream) return;
    let n = 3;
    setCount(n);
    const t = setInterval(() => {
      n--;
      if (n > 0) { setCount(n); return; }
      clearInterval(t); setCount(null);
      const chunks: Blob[] = [];
      const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      const r = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 12_000_000 } : undefined);
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        const type = r.mimeType || 'video/webm';
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const f = new File(chunks, `Recording ${new Date().toLocaleTimeString().replace(/:/g, '-')}.${ext}`, { type });
        void importFiles([f]);
        onClose();
      };
      r.start(250);
      setRec(r);
    }, 1000);
  };

  return (
    <div className="drop-overlay" role="dialog" aria-modal="true" aria-label="Record a pitch">
      <div className="card" style={{ width: 'min(880px, 94vw)' }}>
        <div className="card-title"><h2>Record a pitch</h2><button className="ghost" onClick={onClose}>Close</button></div>
        {err ? <div className="notice bad">{err}</div> : (
          <>
            <div className="player" style={{ aspectRatio: '16/9' }}>
              <video ref={video} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              {/* framing silhouette: whole body, room for the stride */}
              <svg viewBox="0 0 160 90" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                <rect x="20" y="8" width="120" height="76" fill="none" stroke="rgba(255,255,255,.5)" strokeDasharray="3 3" />
                <circle cx="52" cy="22" r="5" fill="none" stroke="rgba(255,255,255,.7)" />
                <path d="M52 27 L52 52 M52 52 L44 80 M52 52 L90 80 M52 33 L36 42 M52 33 L66 24" stroke="rgba(255,255,255,.7)" fill="none" strokeWidth="1.5" />
                <line x1="10" y1="80" x2="150" y2="80" stroke="rgba(255,200,80,.8)" />
                <text x="80" y="88" fill="rgba(255,255,255,.8)" fontSize="4" textAnchor="middle">keep the ground line level · whole body through the finish</text>
              </svg>
              {count !== null && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 120, color: '#fff', fontFamily: 'var(--font-display)', fontWeight: 800 }}>{count}</div>}
            </div>
            <canvas ref={canvas} hidden />
            <div className="stack" style={{ marginTop: 10 }}>
              {checks.map((c) => <div key={c} className="notice warn small">{c}</div>)}
              <div className="small muted">Camera frame rate: {fps ? `${Math.round(fps)} fps` : 'unknown'}{fps && fps < 100 ? ' — browsers usually record at 30–60 fps. For 120–240 fps use the phone\'s slow-motion camera and drop the file here.' : ''}</div>
              <div className="row">
                {!rec ? <button className="accent" onClick={start} disabled={!stream || count !== null}>Start (3-2-1)</button>
                  : <button className="primary" onClick={() => rec.stop()}>Stop &amp; analyse</button>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
