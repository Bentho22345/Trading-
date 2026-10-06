'use client';
import type { ReactNode } from 'react';

/** Tiny, safe Markdown renderer (headings, bullets, bold, italics, links, code) — no HTML injection. */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const inline = (s: string, k: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|_[^_]+_|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
    let last = 0, m: RegExpExecArray | null, i = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('**')) out.push(<strong key={`${k}${i++}`}>{t.slice(2, -2)}</strong>);
      else if (t.startsWith('`')) out.push(<code key={`${k}${i++}`} className="rounded bg-bg-2 px-1">{t.slice(1, -1)}</code>);
      else if (t.startsWith('[')) out.push(<a key={`${k}${i++}`} href={m[2]} target="_blank" rel="noopener noreferrer" className="text-accent underline">{t.slice(1, t.indexOf(']'))}</a>);
      else out.push(<em key={`${k}${i++}`}>{t.slice(1, -1)}</em>);
      last = m.index + t.length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = (k: number) => { if (list.length) { blocks.push(<ul key={`ul${k}`} className="my-1 list-disc space-y-0.5 pl-5">{list}</ul>); list = []; } };
  text.split('\n').forEach((line, i) => {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (/^\s*[-*]\s+/.test(line)) { list.push(<li key={i}>{inline(line.replace(/^\s*[-*]\s+/, ''), `l${i}`)}</li>); return; }
    flush(i);
    if (h) blocks.push(<div key={i} className={`mt-3 font-semibold text-text ${h[1].length === 1 ? 'text-lg' : 'text-sm'}`}>{inline(h[2], `h${i}`)}</div>);
    else if (line.trim()) blocks.push(<p key={i} className="my-1">{inline(line, `p${i}`)}</p>);
  });
  flush(9999);
  return <div className={`text-sm leading-relaxed text-dim ${className}`}>{blocks}</div>;
}
