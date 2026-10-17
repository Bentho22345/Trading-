// Filming guide with simple illustrations for side (RHP/LHP) and front setups.

export function SideSetup({ hand, small }: { hand: 'R' | 'L'; small?: boolean }) {
  // top-down field: rubber at left, plate at right; camera on the open side
  const camY = hand === 'R' ? 30 : 150; // RHP: third-base side (top in this drawing), LHP: first-base side
  return (
    <svg viewBox="0 0 320 180" style={{ width: '100%', maxWidth: small ? 260 : 420 }} role="img" aria-label={`Side view setup for a ${hand === 'R' ? 'right' : 'left'}-handed pitcher`}>
      <rect width="320" height="180" rx="10" fill="var(--surface-2)" />
      <text x="10" y="18" fontSize="11" fill="var(--text-3)">{hand === 'R' ? '3B side' : '1B side'}</text>
      <text x="10" y="172" fontSize="11" fill="var(--text-3)">{hand === 'R' ? '1B side' : '3B side'}</text>
      <circle cx="80" cy="90" r="34" fill="#a7774f" opacity=".6" />
      <rect x="74" y="86" width="12" height="8" fill="#fff" />
      <text x="62" y="140" fontSize="11" fill="var(--text)">mound</text>
      <path d="M270 82 l10 8 -10 8 -10 -8z" fill="#fff" stroke="var(--line-strong)" />
      <text x="252" y="120" fontSize="11" fill="var(--text)">home</text>
      <line x1="86" y1="90" x2="260" y2="90" stroke="var(--line-strong)" strokeDasharray="4 4" />
      <g transform={`translate(110 ${camY})`}>
        <rect x="-12" y="-8" width="24" height="16" rx="3" fill="var(--a)" />
        <circle r="4" fill="#fff" />
      </g>
      <line x1="110" y1={camY} x2="95" y2="90" stroke="var(--a)" strokeWidth="1.5" />
      <text x="128" y={camY + 4} fontSize="11" fill="var(--a)">phone · hip height · 15–25 ft · square to the pitcher</text>
    </svg>
  );
}

export function FrontSetup({ small }: { small?: boolean }) {
  return (
    <svg viewBox="0 0 320 180" style={{ width: '100%', maxWidth: small ? 260 : 420 }} role="img" aria-label="Front view setup from behind home plate">
      <rect width="320" height="180" rx="10" fill="var(--surface-2)" />
      <circle cx="80" cy="90" r="34" fill="#a7774f" opacity=".6" />
      <rect x="74" y="86" width="12" height="8" fill="#fff" />
      <path d="M250 82 l10 8 -10 8 -10 -8z" fill="#fff" stroke="var(--line-strong)" />
      <rect x="268" y="66" width="6" height="48" fill="var(--text-3)" />
      <text x="232" y="128" fontSize="10" fill="var(--text-3)">screen / net</text>
      <g transform="translate(292 90)"><rect x="-8" y="-12" width="16" height="24" rx="3" fill="var(--b)" /><circle r="4" fill="#fff" /></g>
      <line x1="284" y1="90" x2="92" y2="90" stroke="var(--b)" strokeDasharray="4 4" />
      <text x="140" y="40" fontSize="11" fill="var(--b)">behind home plate, centred on the rubber,</text>
      <text x="140" y="54" fontSize="11" fill="var(--b)">protected by a screen</text>
    </svg>
  );
}

export function PhasesDiagram() {
  const phases = [['Wind-up', 'FM → PKH'], ['Stride', 'PKH → FS'], ['Arm cocking', 'FS → MER'], ['Acceleration', 'MER → BR'], ['Deceleration', 'BR → MIR'], ['Follow-through', 'MIR → END']];
  return (
    <svg viewBox="0 0 600 70" style={{ width: '100%' }} role="img" aria-label="The six phases of the pitching delivery">
      {phases.map(([n, ev], i) => (
        <g key={n} transform={`translate(${i * 100} 0)`}>
          <rect x="2" y="8" width="96" height="34" rx="5" fill={i === 3 ? 'var(--accent)' : 'var(--bg-2)'} stroke="var(--line-strong)" />
          <text x="50" y="30" textAnchor="middle" fontSize="13" fontFamily="var(--font-display)" fontWeight="700" fill={i === 3 ? '#fff' : 'var(--text)'}>{n.toUpperCase()}</text>
          <text x="50" y="60" textAnchor="middle" fontSize="11" fill="var(--text-3)">{ev}</text>
        </g>
      ))}
    </svg>
  );
}

export function GuideScreen() {
  return (
    <div className="stack" style={{ maxWidth: 980 }}>
      <h1>Filming guide</h1>
      <p className="muted">Good video is the biggest accuracy upgrade you can make. Film the same way every time so comparisons are fair.</p>
      <div className="grid cols-2">
        <div className="card stack">
          <h2>Side view (main view)</h2>
          <SideSetup hand="R" />
          <SideSetup hand="L" />
          <ul className="small">
            <li><b>Open side:</b> right-handers from the third-base side, left-handers from the first-base side — you see the chest and the throwing arm.</li>
            <li>Phone on a <b>tripod at hip height</b>, lens <b>square</b> (perpendicular) to the line from rubber to plate, about <b>15–25 ft</b> away.</li>
            <li>Whole body in frame from the set position through the follow-through — leave room in front for the stride.</li>
            <li>Measures well: stride, knee bends, trunk tilt, arm timing, extension, release height, tempo.</li>
          </ul>
        </div>
        <div className="card stack">
          <h2>Front view (add-on)</h2>
          <FrontSetup />
          <ul className="small">
            <li>From behind home plate — <b>always behind a protective screen</b> during live throwing.</li>
            <li>Centred on the rubber, at chest height.</li>
            <li>Measures well: arm slot, side bend, stride direction, glove side, head position.</li>
            <li>Can't measure: stride length or forward trunk tilt.</li>
          </ul>
        </div>
      </div>
      <div className="card">
        <h2>Checklist</h2>
        <div className="grid cols-2 small">
          <ul>
            <li><b>Frame rate:</b> 120–240 fps (iPhone/Android "Slo-mo"). 30 fps works for tempo and stride but arm numbers get rough.</li>
            <li><b>Light:</b> bright, even light. Avoid filming into the sun (backlit).</li>
            <li><b>Clothes:</b> contrast with the background; avoid baggy tops.</li>
            <li><b>Tripod:</b> no hand-held video — camera motion ruins measurements.</li>
          </ul>
          <ul>
            <li><b>Same setup every session:</b> same spot, height, distance, zoom and frame rate.</li>
            <li><b>Full pitch:</b> start a second before the first move, stop after the finish.</li>
            <li><b>Netting/fences</b> in front of the lens confuse the pose model — shoot through a gap.</li>
            <li><b>Slow-mo exports:</b> if your phone exports slow-motion as a normal-speed file, set "Clip speed" (e.g. 8×) so times are real.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
