import { defineConfig } from '@playwright/test';

// Tests start signed in as a guest (auth.spec.ts clears this to test the sign-in screen itself).
const guest = JSON.stringify({ userId: null, name: 'Guest', color: '#6b7280', guest: true, remember: true, at: Date.now() });

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  use: {
    baseURL: 'http://localhost:4173',
    storageState: { cookies: [], origins: [{ origin: 'http://localhost:4173', localStorage: [{ name: 'mound-session', value: guest }] }] },
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true },
});
