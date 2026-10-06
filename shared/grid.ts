// 12-column snap-to-grid layout maths (pure): collision push-down + vertical compaction.
export interface GridItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const COLS = 12;
export const MIN_W = 2;
export const MIN_H = 3;

export function collides(a: GridItem, b: GridItem): boolean {
  return a.id !== b.id && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function clampItem<T extends GridItem>(it: T, cols = COLS): T {
  const w = Math.max(MIN_W, Math.min(cols, Math.round(it.w)));
  const h = Math.max(MIN_H, Math.min(60, Math.round(it.h)));
  const x = Math.max(0, Math.min(cols - w, Math.round(it.x)));
  const y = Math.max(0, Math.round(it.y));
  return { ...it, x, y, w, h };
}

const byPos = (a: GridItem, b: GridItem) => a.y - b.y || a.x - b.x;

/** Move every item as far up as it can go without overlapping, preserving order. */
export function compact<T extends GridItem>(items: T[], pinned?: string): T[] {
  const placed: T[] = [];
  const pin = pinned ? items.find((i) => i.id === pinned) : undefined;
  if (pin) placed.push(pin);
  for (const it of [...items].filter((i) => i.id !== pinned).sort(byPos)) {
    const n = { ...it };
    while (n.y > 0 && !placed.some((p) => collides({ ...n, y: n.y - 1 }, p))) n.y--;
    while (placed.some((p) => collides(n, p))) n.y++;
    placed.push(n);
  }
  const order = new Map(items.map((i, k) => [i.id, k]));
  return placed.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

/** Push anything overlapping `moved` downwards, recursively (cascading). */
function pushDown<T extends GridItem>(items: T[], moved: T): T[] {
  let out = items.map((i) => (i.id === moved.id ? moved : i));
  const queue = [moved];
  let guard = 0;
  while (queue.length && guard++ < 500) {
    const m = queue.shift()!;
    for (const o of out) {
      if (o.id === m.id || !collides(m, o)) continue;
      const shifted = { ...o, y: m.y + m.h };
      out = out.map((i) => (i.id === o.id ? shifted : i));
      queue.push(shifted);
    }
  }
  return out;
}

export function moveItem<T extends GridItem>(items: T[], id: string, x: number, y: number, cols = COLS): T[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items;
  const moved = clampItem({ ...it, x, y }, cols);
  return compact(pushDown(items, moved), id);
}

export function resizeItem<T extends GridItem>(items: T[], id: string, w: number, h: number, cols = COLS): T[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items;
  const resized = clampItem({ ...it, w, h }, cols);
  return compact(pushDown(items, resized), id);
}

/** First free slot for a new item of size w×h (scan rows top-down). */
export function placeNew<T extends GridItem>(items: T[], w: number, h: number, cols = COLS): { x: number; y: number } {
  const maxY = items.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const probe = { id: '__new', x, y, w, h };
      if (!items.some((i) => collides(probe, i))) return { x, y };
    }
  }
  return { x: 0, y: maxY };
}

export function gridHeight(items: GridItem[]): number {
  return items.reduce((m, i) => Math.max(m, i.y + i.h), 0);
}
