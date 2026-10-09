// Minimal, safe Markdown renderer (headings, bullets, bold, italics) — no HTML injection.
function inline(t: string) {
  const parts = t.split(/(\*\*[^*]+\*\*|_[^_]+_|\*[^*]+\*)/g);
  return parts.map((p, i) => p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b>
    : (p.startsWith('_') && p.endsWith('_')) || (p.startsWith('*') && p.endsWith('*') && p.length > 2) ? <i key={i}>{p.slice(1, -1)}</i> : p);
}

export function Md({ text }: { text: string }) {
  return (
    <div className="space-y-1 leading-relaxed">
      {(text || '').split('\n').map((l, i) => {
        if (/^#\s/.test(l)) return <h2 key={i} className="pt-1 text-base font-bold">{inline(l.slice(2))}</h2>;
        if (/^##+\s/.test(l)) return <h3 key={i} className="pt-2 text-[12px] font-bold uppercase tracking-wide text-accent">{inline(l.replace(/^#+\s/, ''))}</h3>;
        if (/^\s*[-*]\s/.test(l)) return <div key={i} className="pl-3">• {inline(l.replace(/^\s*[-*]\s/, ''))}</div>;
        if (!l.trim()) return <div key={i} className="h-1" />;
        return <p key={i}>{inline(l)}</p>;
      })}
    </div>
  );
}
