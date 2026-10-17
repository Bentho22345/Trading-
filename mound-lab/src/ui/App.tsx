import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { useRoute } from './router';
import { Home } from './screens/Home';
import { ClipScreen } from './screens/ClipScreen';
import { CompareScreen } from './screens/CompareScreen';
import { Library } from './screens/Library';
import { DrillsScreen } from './screens/Drills';
import { GlossaryScreen } from './screens/Glossary';
import { GuideScreen } from './screens/Guide';
import { SettingsScreen } from './screens/Settings';
import { AboutScreen } from './screens/About';
import { WorkloadScreen } from './screens/Workload';
import { AthletesScreen } from './screens/Athletes';
import { ReportScreen } from './screens/Report';

const NAV: [string, string][] = [
  ['/', 'Home'],
  ['/compare', 'Compare'],
  ['/library', 'Library'],
  ['/athletes', 'Athletes'],
  ['/drills', 'Drills'],
  ['/workload', 'Workload'],
  ['/guide', 'Filming guide'],
  ['/glossary', 'Glossary'],
  ['/settings', 'Settings'],
];

function useTheme() {
  const { theme, reducedMotion } = useStore((s) => s.settings);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { document.documentElement.dataset.reducedMotion = reducedMotion ? '1' : '0'; }, [reducedMotion]);
}

function filesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files ?? []);
}

/** Full-window drop overlay: drop on A, B, or the library. */
function DropOverlay() {
  const importFiles = useStore((s) => s.importFiles);
  const [active, setActive] = useState(false);
  const [hot, setHot] = useState<'A' | 'B' | 'lib' | null>(null);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; depth++; setActive(true); };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) { setActive(false); setHot(null); } };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; setActive(false); setHot(null);
      const target = (e.target as HTMLElement | null)?.closest?.('[data-drop]')?.getAttribute('data-drop');
      const files = filesFrom(e.dataTransfer);
      void importFiles(files, target === 'A' || target === 'B' ? target : undefined);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, [importFiles]);
  // paste from clipboard
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('video/'));
      if (files.length) { e.preventDefault(); void importFiles(files); }
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, [importFiles]);
  if (!active) return null;
  return (
    <div className="drop-overlay" data-testid="drop-overlay">
      <div className="targets">
        <div className={`drop-target a ${hot === 'A' ? 'hot' : ''}`} data-drop="A" onDragEnter={() => setHot('A')}>
          <span className="chip-a" style={{ width: 40, height: 40, fontSize: '1.6rem' }}>A</span>
          <div>Drop into slot A</div>
        </div>
        <div className={`drop-target b ${hot === 'B' ? 'hot' : ''}`} data-drop="B" onDragEnter={() => setHot('B')}>
          <span className="chip-b" style={{ width: 40, height: 40, fontSize: '1.6rem' }}>B</span>
          <div>Drop into slot B</div>
        </div>
        <div className={`drop-target lib ${hot === 'lib' ? 'hot' : ''}`} data-drop="lib" onDragEnter={() => setHot('lib')}>
          Drop anywhere else: 1 clip fills an empty slot, 2 clips fill A and B, more go to the library
        </div>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  );
}

export function App() {
  const init = useStore((s) => s.init);
  const loaded = useStore((s) => s.loaded);
  const { path, parts } = useRoute();
  useTheme();
  useEffect(() => { void init(); }, [init]);
  useEffect(() => { window.scrollTo(0, 0); }, [path]);

  let screen: React.ReactNode;
  if (!loaded) screen = <p className="muted">Loading…</p>;
  else if (parts[0] === 'clip' && parts[1]) screen = <ClipScreen id={parts[1]} />;
  else if (parts[0] === 'compare') screen = <CompareScreen />;
  else if (parts[0] === 'library') screen = <Library />;
  else if (parts[0] === 'athletes') screen = <AthletesScreen id={parts[1]} />;
  else if (parts[0] === 'drills') screen = <DrillsScreen focus={parts[1]} />;
  else if (parts[0] === 'glossary') screen = <GlossaryScreen focus={parts[1]} />;
  else if (parts[0] === 'guide') screen = <GuideScreen />;
  else if (parts[0] === 'settings') screen = <SettingsScreen />;
  else if (parts[0] === 'about') screen = <AboutScreen />;
  else if (parts[0] === 'workload') screen = <WorkloadScreen />;
  else if (parts[0] === 'report') screen = <ReportScreen />;
  else screen = <Home />;

  const active = '/' + (parts[0] ?? '');
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Mound Lab home">
          <img className="brand-mark" src="./icons/icon.svg" alt="" />
          <span className="brand-name">Mound<em>Lab</em></span>
        </a>
        <nav className="nav" aria-label="Main">
          {NAV.map(([p, l]) => <a key={p} href={`#${p}`} aria-current={active === p ? 'page' : undefined}>{l}</a>)}
        </nav>
      </header>
      <main className="main" id="main">{screen}</main>
      <footer className="footer">
        Mound Lab gives 2D video estimates for training and education. It is not a medical device and does not diagnose injuries. Video stays on this device.{' '}
        <a href="#/about">About &amp; sources</a>
      </footer>
      <DropOverlay />
      <Toasts />
    </div>
  );
}
