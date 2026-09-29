import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';

export const metadata: Metadata = {
  title: 'PULSE — Markets Intelligence Terminal',
  description: 'Real-time FX, crypto and equities news and market data.',
};

export const viewport: Viewport = {
  themeColor: '#07070d',
  width: 'device-width',
  initialScale: 1,
};

// Apply saved theme before paint to avoid a light/dark flash.
const themeScript = `try{var s=JSON.parse(localStorage.getItem('pulse.settings.v1')||'{}');var d=document.documentElement;d.dataset.theme=s.theme||'dark';d.dataset.cb=String(!!s.colorblind);if(s.calm)d.classList.add('calm')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
