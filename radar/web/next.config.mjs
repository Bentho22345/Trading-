/** Static export: FastAPI serves the built UI, API and live socket on one port. */
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
};
export default nextConfig;
