'use client';
import type { Brief, BriefSection, BriefStory, LevelHit, ScoreRow } from '@shared/v2';
import type { EconEvent } from '@shared/types';

/** True while Listen mode is speaking: the audio squawk ducks (stays quiet) during it. */
export const listening = { active: false };

const say = (r: ScoreRow) => {
  const dir = r.change >= 0 ? 'up' : 'down';
  return r.bp ? `${r.name} ${dir} ${Math.abs(r.change * 100).toFixed(0)} basis points` : `${r.name} ${dir} ${Math.abs(r.changePct).toFixed(1)} percent`;
};

export function sectionSpeech(s: BriefSection, b: Brief): string {
  if (s.empty) return `${s.title}. ${s.empty}`;
  const d = s.data as Record<string, unknown>;
  const tz = b.tz;
  const t = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  switch (s.type) {
    case 'scoreboard': return `${s.title}. ${((d.rows as ScoreRow[]) ?? []).slice(0, 10).map(say).join('. ')}.`;
    case 'stories': return `${s.title}. ${((d.stories as BriefStory[]) ?? []).map((x, i) => `Story ${i + 1}: ${x.headline}. ${x.tldr} Why it matters: ${x.why}`).join(' ')}`;
    case 'calendar': return `${s.title}. ${((d.events as EconEvent[]) ?? []).map((e) => `At ${t(e.time)}, ${e.currency} ${e.title}${e.consensus !== null ? `, consensus ${e.consensus}${e.unit === '%' ? ' percent' : e.unit}` : ''}`).join('. ') || 'No major releases.'}`;
    case 'levels': return `${s.title}. ${((d.levels as LevelHit[]) ?? []).filter((l) => l.status !== 'watch').slice(0, 6).map((l) => `${l.symbol} ${l.status} its ${l.label.toLowerCase()} at ${l.level}`).join('. ') || 'No levels approached or broken.'}`;
    case 'book': return `${s.title}. Overnight P and L is ${Math.round(d.total as number)} dollars.`;
    case 'risks': return `${s.title}. ${((d.risks as string[]) ?? []).join(' ')}`;
    case 'journal': return String(d.prompt ?? '');
    default: return s.title;
  }
}

export function chaptersOf(b: Brief): { title: string; text: string }[] {
  return [
    { title: 'The take', text: `${b.headline}. ${b.take.text}` },
    ...b.sections.filter((s) => s.type !== 'take').map((s) => ({ title: s.title, text: sectionSpeech(s, b) })),
    { title: 'Disclaimer', text: 'This briefing is informational only and is not investment advice.' },
  ];
}

export type NarratorState = { playing: boolean; chapter: number; progress: number; total: number };

/**
 * Chaptered text-to-speech over the browser's speechSynthesis (default) or a server provider
 * (/api/tts, when one is configured). Exposes chapter skip and an overall progress fraction.
 */
export class Narrator {
  private idx = 0;
  private playing = false;
  private audio: HTMLAudioElement | null = null;
  private charDone = 0;
  private totalChars: number;

  constructor(private chapters: { title: string; text: string }[], private onChange: (s: NarratorState) => void, private opts: { rate?: number; voice?: string; server?: boolean } = {}) {
    this.totalChars = chapters.reduce((s, c) => s + c.text.length, 0) || 1;
  }

  static supported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  private emit(extra = 0) {
    const before = this.chapters.slice(0, this.idx).reduce((s, c) => s + c.text.length, 0);
    this.onChange({ playing: this.playing, chapter: this.idx, progress: Math.min(1, (before + extra) / this.totalChars), total: this.chapters.length });
  }

  play(i = this.idx) {
    this.stopAudio();
    this.idx = Math.max(0, Math.min(this.chapters.length - 1, i));
    this.playing = true;
    listening.active = true;
    this.charDone = 0;
    this.emit();
    const ch = this.chapters[this.idx];
    if (this.opts.server) {
      this.audio = new Audio(`/api/tts?text=${encodeURIComponent(ch.text.slice(0, 2500))}`);
      this.audio.playbackRate = this.opts.rate ?? 1;
      this.audio.ontimeupdate = () => this.audio && this.emit((this.audio.currentTime / (this.audio.duration || 1)) * ch.text.length);
      this.audio.onended = () => this.advance();
      this.audio.onerror = () => {
        this.opts.server = false;
        this.play(this.idx);
      };
      void this.audio.play().catch(() => this.pause());
      return;
    }
    const u = new SpeechSynthesisUtterance(ch.text);
    u.rate = this.opts.rate ?? 1;
    const v = this.opts.voice ? speechSynthesis.getVoices().find((x) => x.name === this.opts.voice) : undefined;
    if (v) u.voice = v;
    u.onboundary = (e) => {
      this.charDone = e.charIndex;
      this.emit(this.charDone);
    };
    u.onend = () => this.advance();
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  private advance() {
    if (!this.playing) return;
    if (this.idx < this.chapters.length - 1) this.play(this.idx + 1);
    else {
      this.playing = false;
      listening.active = false;
      this.onChange({ playing: false, chapter: this.idx, progress: 1, total: this.chapters.length });
    }
  }

  pause() {
    this.playing = false;
    listening.active = false;
    this.stopAudio();
    this.emit(this.charDone);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play(this.idx);
  }
  next() { this.play(this.idx + 1); }
  prev() { this.play(this.idx - 1); }

  private stopAudio() {
    if (this.audio) {
      this.audio.onended = null;
      this.audio.pause();
      this.audio = null;
    }
    if (Narrator.supported()) speechSynthesis.cancel();
  }

  destroy() {
    this.playing = false;
    listening.active = false;
    this.stopAudio();
  }
}
