import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './styles.css';
import { currentSession, touchSession } from './auth/session';

const root = createRoot(document.getElementById('root')!);

// The library (IndexedDB) and settings belong to whoever is signed in, so the app itself only loads after
// sign-in. Signing in, switching person or signing out reloads the page to open the right library.
async function boot() {
  if (!currentSession()) {
    document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const { AuthScreen } = await import('./ui/screens/Auth');
    root.render(<StrictMode><AuthScreen onDone={() => location.reload()} /></StrictMode>);
    return;
  }
  touchSession();
  const { App } = await import('./ui/App');
  root.render(<StrictMode><App /></StrictMode>);
}
void boot();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // pre-cache the pose models so the app works at the field without signal
      (reg.active ?? reg.installing ?? reg.waiting)?.postMessage('cache-models');
    }).catch(() => undefined);
  });
}
