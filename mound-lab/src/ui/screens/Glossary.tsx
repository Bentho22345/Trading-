import { useEffect, useState } from 'react';
import { GLOSSARY } from '../../data/glossary';
import { PhasesDiagram, SideSetup, FrontSetup } from './Guide';

export function GlossaryScreen({ focus }: { focus?: string }) {
  const [q, setQ] = useState('');
  useEffect(() => { if (focus) document.getElementById(`term-${focus}`)?.scrollIntoView({ block: 'center' }); }, [focus]);
  const list = GLOSSARY.filter((t) => !q || `${t.term} ${t.def}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="stack">
      <h1>Glossary <span className="small muted">({GLOSSARY.length} terms)</span></h1>
      <input placeholder="Search terms" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search glossary" style={{ maxWidth: 360 }} />
      <div className="card"><PhasesDiagram /></div>
      <dl className="grid cols-2" style={{ margin: 0 }}>
        {list.map((t) => (
          <div key={t.id} id={`term-${t.id}`} className="card flat" style={focus === t.id ? { outline: '3px solid var(--accent)' } : undefined}>
            <dt style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.1rem', textTransform: 'uppercase' }}>{t.term}</dt>
            <dd style={{ margin: '4px 0 0' }} className="small">{t.def}</dd>
            {t.diagram === 'side' && <SideSetup hand="R" small />}
            {t.diagram === 'front' && <FrontSetup small />}
          </div>
        ))}
      </dl>
    </div>
  );
}
