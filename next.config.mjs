/** @type {import('next').NextConfig} */
const WORKER = process.env.PULSE_WORKER_URL || 'http://127.0.0.1:4000';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // REST calls from the browser go through Next so the worker origin/keys stay private.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${WORKER}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
