'use client';
import { memo, useRef } from 'react';

interface Col { ch: string; anim: '' | 'odo-up' | 'odo-down' }

/**
 * Rolling-digit number. A digit that changes re-mounts (it's keyed by its character) and rolls
 * in from below when the value rose, from above when it fell — transform + opacity only, one
 * DOM node per character. Columns are keyed from the right so the decimal point stays put as
 * the integer part grows. Nothing animates on first mount.
 */
export const Odometer = memo(function Odometer({ value, className = '' }: { value: string; className?: string }) {
  const prev = useRef<string | null>(null);
  const cols = useRef(new Map<number, Col>());
  const chars = [...value];
  if (prev.current !== value) {
    const a = prev.current === null ? NaN : parseFloat(prev.current.replace(/[^\d.-]/g, ''));
    const b = parseFloat(value.replace(/[^\d.-]/g, ''));
    const anim = Number.isFinite(a) && Number.isFinite(b) ? (b >= a ? 'odo-up' : 'odo-down') : '';
    chars.forEach((ch, i) => {
      const pos = chars.length - i;
      const c = cols.current.get(pos);
      if (!c) cols.current.set(pos, { ch, anim: '' });
      else if (c.ch !== ch) cols.current.set(pos, { ch, anim });
    });
    prev.current = value;
  }
  return (
    <span className={`odo num ${className}`} aria-label={value} role="text">
      {chars.map((ch, i) => {
        const pos = chars.length - i;
        const digit = ch >= '0' && ch <= '9';
        const anim = digit ? cols.current.get(pos)?.anim ?? '' : '';
        return (
          <span key={pos} className="odo-col" aria-hidden style={digit ? { width: '1ch' } : undefined}>
            <span key={ch} className={`odo-digit ${anim}`}>{ch}</span>
          </span>
        );
      })}
    </span>
  );
});
