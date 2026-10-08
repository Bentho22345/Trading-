import type { Metadata, Viewport } from 'next';
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
    <html lang="en">
      <body className="min-h-screen">
        <Nav />
        <main className="px-2 pb-6 md:px-3">{children}</main>
        <FlashOverlay />
      </body>
    </html>
  );
}
