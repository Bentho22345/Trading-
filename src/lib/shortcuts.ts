'use client';

export type Action =
  | 'next' | 'prev' | 'openTimeline' | 'openSource' | 'save' | 'toggleRead' | 'brief' | 'search' | 'breaking' | 'high' | 'focus' | 'help'
  | 'privacy' | 'explain' | 'journal' | 'playbooks' | 'library' | 'muteSquawk' | 'editLayout' | 'settings' | 'copilot' | 'replay' | 'palette';

export const ACTIONS: { id: Action; label: string; key: string; fixed?: boolean }[] = [
  { id: 'palette', label: 'Command palette', key: 'mod+k', fixed: true },
  { id: 'copilot', label: 'Ask Pulse copilot', key: 'mod+j' },
  { id: 'next', label: 'Next story', key: 'j' },
  { id: 'prev', label: 'Previous story', key: 'k' },
  { id: 'openTimeline', label: 'Open story timeline', key: 'enter' },
  { id: 'openSource', label: 'Open source article', key: 'o' },
  { id: 'save', label: 'Save / unsave story', key: 's' },
  { id: 'toggleRead', label: 'Toggle read / unread', key: 'u' },
  { id: 'brief', label: 'Morning brief', key: 'm' },
  { id: 'search', label: 'Search', key: '/' },
  { id: 'breaking', label: 'Toggle breaking only', key: 'b' },
  { id: 'high', label: 'Toggle high impact only', key: 'h' },
  { id: 'focus', label: 'Focus mode', key: 'f' },
  { id: 'privacy', label: 'Privacy blur (P&L)', key: 'p' },
  { id: 'explain', label: 'Explain this', key: 'e' },
  { id: 'journal', label: 'Journal', key: 'n' },
  { id: 'playbooks', label: 'Playbooks', key: 'y' },
  { id: 'library', label: 'Widget library', key: 'w' },
  { id: 'editLayout', label: 'Edit layout', key: 'g' },
  { id: 'muteSquawk', label: 'Push-to-mute squawk', key: 'shift+m' },
  { id: 'replay', label: 'Market replay', key: 'r' },
  { id: 'settings', label: 'Settings', key: ',' },
  { id: 'help', label: 'Keyboard shortcuts', key: '?' },
];

/** Normalise a KeyboardEvent to "mod+shift+k" style. Symbols use the produced character ("?" not "shift+/"). */
export function keyOf(e: KeyboardEvent): string {
  const k = e.key;
  const mod = e.metaKey || e.ctrlKey ? 'mod+' : '';
  const alt = e.altKey ? 'alt+' : '';
  if (k === 'Enter') return `${mod}${alt}${e.shiftKey ? 'shift+' : ''}enter`;
  if (k === 'Escape') return 'escape';
  if (/^[a-z]$/i.test(k)) return `${mod}${alt}${e.shiftKey ? 'shift+' : ''}${k.toLowerCase()}`;
  if (k.length === 1) return `${mod}${alt}${k}`;
  return `${mod}${alt}${k.toLowerCase()}`;
}

export function bindings(overrides: Partial<Record<Action, string>>): Record<Action, string> {
  return Object.fromEntries(ACTIONS.map((a) => [a.id, a.fixed ? a.key : overrides[a.id] ?? a.key])) as Record<Action, string>;
}

export function conflicts(map: Record<Action, string>): Record<string, Action[]> {
  const by: Record<string, Action[]> = {};
  for (const [a, k] of Object.entries(map) as [Action, string][]) (by[k] ??= []).push(a);
  // digits are reserved for workspaces (1–9) and shift+digits for feed filters
  for (const k of Object.keys(by)) if (/^\d$/.test(k)) by[k].push('palette');
  return Object.fromEntries(Object.entries(by).filter(([, v]) => v.length > 1));
}

export const prettyKey = (k: string) => k.replace('mod+', navigator?.platform?.includes('Mac') ? '⌘' : 'Ctrl ').replace('shift+', '⇧').replace('alt+', '⌥').replace('enter', 'Enter').toUpperCase();
