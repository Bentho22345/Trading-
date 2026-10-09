import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import '@fontsource-variable/inter';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import './globals.css';
import { Nav } from '@/components/Nav';
import { FlashOverlay } from '@/components/FlashOverlay';
import { ScrollProgress } from '@/components/ScrollProgress';
import { THEME_BOOT } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'Memecoin Radar',
  description: 'Real-time narrative, social and on-chain signal terminal',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, title: 'Radar', statusBarStyle: 'black-translucent' },
};
export const viewport: Viewport = { themeColor: '#000000', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} data-theme="dark" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} /></head>
      <body className="min-h-screen">
        <div className="aurora" aria-hidden />
        <ScrollProgress />
        <Nav />
        <main className="mx-auto max-w-[1920px] px-3 pb-16 pt-4 md:px-6">{children}</main>
        <FlashOverlay />
      </body>
    </html>
  );
}
