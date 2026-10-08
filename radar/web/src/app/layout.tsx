import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import './globals.css';
import { Nav } from '@/components/Nav';
import { FlashOverlay } from '@/components/FlashOverlay';

export const metadata: Metadata = {
  title: 'Memecoin Radar',
  description: 'Real-time narrative, social and on-chain signal terminal',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, title: 'Radar', statusBarStyle: 'black-translucent' },
};
export const viewport: Viewport = { themeColor: '#07090c', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen">
        <div className="aurora" aria-hidden />
        <Nav />
        <main className="px-3 pb-10 pt-3 md:px-5 lg:pl-[228px]">{children}</main>
        <FlashOverlay />
      </body>
    </html>
  );
}
