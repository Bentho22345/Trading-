import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'PULSE — markets intelligence terminal',
    short_name: 'PULSE',
    description: 'Your morning-to-close trading desk: briefs, live news, alerts.',
    start_url: '/m',
    scope: '/',
    display: 'standalone',
    background_color: '#07070d',
    theme_color: '#07070d',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
