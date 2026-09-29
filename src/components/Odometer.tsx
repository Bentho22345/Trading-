'use client';
import { memo } from 'react';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * Rolling-digit number. Each digit is a vertical 0–9 strip moved with a CSS transform,
 * so updates are compositor-only. Columns are keyed from the right so the decimal point
 * stays put as the integer part grows.
 */
export const Odometer = memo(function Odometer({ value, className = '' }: { value: string; className?: string }) {
  const chars = [...value];
  return (
    <span className={`odo num ${className}`} aria-label={value} role="text">
      {chars.map((ch, i) => {
        const key = chars.length - i;
        const d = DIGITS.indexOf(ch);
        if (d < 0) {
          return (
            <span key={`s${key}`} className="odo-col" aria-hidden>
              {ch}
            </span>
          );
        }
        return (
          <span key={`d${key}`} className="odo-col" aria-hidden style={{ width: '1ch' }}>
            <span className="odo-strip" style={{ transform: `translateY(${-d * 10}%)` }}>
              {DIGITS.map((x) => (
                <span key={x}>{x}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
});
