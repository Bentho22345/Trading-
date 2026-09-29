'use client';

let ctx: AudioContext | null = null;

/** A soft two-note chime synthesised with WebAudio (no audio assets shipped). Off by default. */
export function playChime(kind: 'breaking' | 'alert') {
  try {
    ctx ??= new AudioContext();
    const notes = kind === 'breaking' ? [660, 880] : [880, 1175];
    const t0 = ctx.currentTime;
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.13;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(ctx!.destination);
      o.start(t);
      o.stop(t + 0.55);
    });
  } catch {
    /* audio unavailable */
  }
}
