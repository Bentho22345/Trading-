'use client';

export type TokenKey = 'accent' | 'up' | 'down' | 'fx' | 'crypto' | 'eq' | 'macro' | 'rates' | 'cmdty' | 'social' | 'reg' | 'bg' | 'bg-2' | 'panel-solid' | 'text' | 'text-dim' | 'text-faint';

export interface ThemeConfig {
  preset: 'night' | 'paper' | 'terminal' | 'contrast' | 'custom';
  base: 'dark' | 'light';
  tokens: Partial<Record<TokenKey, string>>;
  blur: number;
  radius: number;
  bgIntensity: number;
  density: 'compact' | 'cozy' | 'spacious';
  fontSans: 'geist' | 'system' | 'serif';
  fontMono: 'geist' | 'system';
}

export const DEFAULT_THEME: ThemeConfig = { preset: 'night', base: 'dark', tokens: {}, blur: 14, radius: 1, bgIntensity: 1, density: 'cozy', fontSans: 'geist', fontMono: 'geist' };

export const PRESETS: { id: ThemeConfig['preset']; name: string; config: ThemeConfig }[] = [
  { id: 'night', name: 'Night Floor', config: DEFAULT_THEME },
  { id: 'paper', name: 'Paper', config: { ...DEFAULT_THEME, preset: 'paper', base: 'light', blur: 10, bgIntensity: 0.5 } },
  {
    id: 'terminal', name: 'Terminal Green', config: {
      ...DEFAULT_THEME, preset: 'terminal', base: 'dark', blur: 0, radius: 0.4, bgIntensity: 0, fontSans: 'system',
      tokens: { bg: '#020805', 'bg-2': '#04100a', 'panel-solid': '#061309', text: '#c8ffd8', 'text-dim': '#7fd39a', 'text-faint': '#4e8c63', accent: '#39ff88', up: '#39ff88', down: '#ff5c5c', fx: '#5cf2c4', crypto: '#ffd166', eq: '#8be9fd', macro: '#a6f0b4', rates: '#7ab8ff', cmdty: '#ffd166', social: '#ff8fd6', reg: '#ff8fd6' },
    },
  },
  {
    id: 'contrast', name: 'High Contrast', config: {
      ...DEFAULT_THEME, preset: 'contrast', base: 'dark', blur: 0, bgIntensity: 0,
      tokens: { bg: '#000000', 'bg-2': '#0a0a0a', 'panel-solid': '#0d0d0d', text: '#ffffff', 'text-dim': '#e0e0e0', 'text-faint': '#bdbdbd', accent: '#ffd60a', up: '#00e676', down: '#ff4d4d', fx: '#00e5ff', crypto: '#ffb300', eq: '#d0a6ff', macro: '#64ffda', rates: '#82b1ff', cmdty: '#ffe066', social: '#ff80df', reg: '#ff80df' },
    },
  },
];

const FONT_SANS = { geist: 'var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif', system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', serif: 'var(--font-newsreader), Georgia, serif' };
const FONT_MONO = { geist: 'var(--font-geist-mono), ui-monospace, monospace', system: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
const DENSITY = { compact: '14.5px', cozy: '16px', spacious: '17px' };
const ALL_TOKENS: TokenKey[] = ['accent', 'up', 'down', 'fx', 'crypto', 'eq', 'macro', 'rates', 'cmdty', 'social', 'reg', 'bg', 'bg-2', 'panel-solid', 'text', 'text-dim', 'text-faint'];

/** Write a theme onto <html> as CSS custom properties (overrides the base light/dark tokens). */
export function applyTheme(t: ThemeConfig, opts: { colorblind?: boolean } = {}) {
  const el = document.documentElement;
  const st = el.style;
  for (const k of ALL_TOKENS) {
    const v = t.tokens[k];
    // keep the colour-blind palette authoritative for up/down
    if (v && !(opts.colorblind && (k === 'up' || k === 'down'))) st.setProperty(`--${k}`, v);
    else st.removeProperty(`--${k}`);
  }
  if (t.tokens.up && !opts.colorblind) st.setProperty('--up-bg', withAlpha(t.tokens.up, 0.16)); else st.removeProperty('--up-bg');
  if (t.tokens.down && !opts.colorblind) st.setProperty('--down-bg', withAlpha(t.tokens.down, 0.16)); else st.removeProperty('--down-bg');
  if (t.tokens['panel-solid']) st.setProperty('--panel', withAlpha(t.tokens['panel-solid'], t.blur ? 0.7 : 1)); else st.removeProperty('--panel');
  st.setProperty('--glass-blur', `${t.blur}px`);
  for (const [k, px] of [['--radius-md', 6], ['--radius-lg', 8], ['--radius-xl', 12], ['--radius-2xl', 16]] as const) st.setProperty(k, `${(px * t.radius).toFixed(1)}px`);
  st.setProperty('--ambient', String(t.bgIntensity));
  st.setProperty('--font-sans', FONT_SANS[t.fontSans]);
  st.setProperty('--font-mono', FONT_MONO[t.fontMono]);
  st.fontSize = DENSITY[t.density];
  el.dataset.density = t.density;
}

export function withAlpha(hex: string, a: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// ------------------------------------------------------------------ WCAG contrast
function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a: string, b: string): number | null {
  const la = luminance(a), lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Resolve a CSS variable to a #rrggbb string (for the contrast checker). */
export function resolveColor(token: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  if (m) return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
  return '#000000';
}
