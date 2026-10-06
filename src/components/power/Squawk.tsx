'use client';
import { useEffect, useRef } from 'react';
import type { NewsCluster } from '@shared/types';
import type { AlertHistoryItem } from '@shared/v2';
import { useSettings } from '@/lib/settings';
import { useStore } from '@/lib/store';
import { listening } from '@/lib/tts';

const DOMAIN_TONE: Record<string, number> = { centralbanks: 523, fx: 587, crypto: 659, equities: 698, macro: 784, rates: 494, commodities: 440 };
const SEV_TONE: Record<string, number[]> = { low: [660], normal: [660, 880], high: [880, 660, 880], critical: [988, 784, 988, 784] };

let ctx: AudioContext | null = null;
function tone(freqs: number[], gain = 0.05) {
  try {
    ctx ??= new AudioContext();
    let t = ctx.currentTime;
    for (const f of freqs) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.25);
      t += 0.14;
    }
  } catch { /* audio unavailable */ }
}

function quiet(q: { enabled: boolean; start: string; end: string }) {
  if (!q.enabled) return false;
  const now = new Date(), t = now.getHours() * 60 + now.getMinutes();
  const m = (s: string) => { const [h, mi] = s.split(':').map(Number); return h * 60 + (mi || 0); };
  const a = m(q.start), b = m(q.end);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

/** Audio squawk: TTS for breaking headlines and routed alerts, soft earcons, push-to-mute (⇧M), ducks during Listen mode. */
export function Squawk() {
  const muted = useRef(false);
  useEffect(() => {
    const speak = (text: string) => {
      const s = useSettings.getState();
      if (!s.squawk.enabled || muted.current || listening.active || quiet(s.quietHours) || !('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = s.squawk.rate;
      const v = s.squawk.voice ? speechSynthesis.getVoices().find((x) => x.name === s.squawk.voice) : undefined;
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    };
    const onBreaking = (e: Event) => {
      const c = (e as CustomEvent<NewsCluster>).detail;
      const s = useSettings.getState().squawk;
      if (c.impact < s.minImpact || !c.domains.some((d) => s.domains.includes(d))) return;
      if (s.earcons && !muted.current && !listening.active) tone([DOMAIN_TONE[c.domains[0]] ?? 600]);
      speak(`Breaking. ${c.headline}`);
    };
    const onAlert = (e: Event) => {
      const a = (e as CustomEvent<AlertHistoryItem & { squawk?: boolean }>).detail;
      const s = useSettings.getState().squawk;
      if (s.earcons && !muted.current && !listening.active) tone(SEV_TONE[a.severity] ?? [660]);
      if (a.squawk) speak(`Alert. ${a.message}`);
    };
    const onMute = () => {
      muted.current = !muted.current;
      if (muted.current && 'speechSynthesis' in window) speechSynthesis.cancel();
      useStore.getState().pushToast({ kind: 'info', title: muted.current ? 'Squawk muted (⇧M to unmute)' : 'Squawk unmuted' });
    };
    const onTest = () => { tone(SEV_TONE.normal); const was = muted.current; muted.current = false; speak('PULSE squawk test. Breaking headlines and alerts will sound like this.'); muted.current = was; };
    window.addEventListener('pulse:breaking', onBreaking);
    window.addEventListener('pulse:alert2', onAlert);
    window.addEventListener('pulse:mute', onMute);
    window.addEventListener('pulse:squawk-test', onTest);
    return () => {
      window.removeEventListener('pulse:breaking', onBreaking);
      window.removeEventListener('pulse:alert2', onAlert);
      window.removeEventListener('pulse:mute', onMute);
      window.removeEventListener('pulse:squawk-test', onTest);
    };
  }, []);
  return null;
}
