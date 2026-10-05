'use client';
import { useRef, type ButtonHTMLAttributes } from 'react';
import { motion, useMotionValue, useSpring } from 'framer-motion';
import { useCalm } from '@/lib/hooks';

/** Primary button with a subtle magnetic pull toward the cursor. */
export function MagneticButton({ children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const calm = useCalm();
  const ref = useRef<HTMLButtonElement>(null);
  const x = useSpring(useMotionValue(0), { stiffness: 300, damping: 20 });
  const y = useSpring(useMotionValue(0), { stiffness: 300, damping: 20 });
  return (
    <motion.button
      ref={ref}
      style={{ x, y }}
      onMouseMove={(e) => {
        if (calm || !ref.current) return;
        const r = ref.current.getBoundingClientRect();
        x.set((e.clientX - r.left - r.width / 2) * 0.18);
        y.set((e.clientY - r.top - r.height / 2) * 0.25);
      }}
      onMouseLeave={() => {
        x.set(0);
        y.set(0);
      }}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white shadow-[0_6px_20px_-8px_var(--accent)] transition-[filter] hover:brightness-110 disabled:opacity-50 ${className}`}
      {...(rest as object)}
    >
      {children}
    </motion.button>
  );
}
