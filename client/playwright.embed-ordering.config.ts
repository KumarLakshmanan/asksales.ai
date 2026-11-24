import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'support-embed-ordering.spec.ts',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:3027',
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.EMBED_CHROMIUM_EXECUTABLE_PATH },
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'narrow-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 568 } } },
  ],
  webServer: {
    command: 'npm run dev -- --webpack --hostname 127.0.0.1 --port 3027',
    url: 'http://127.0.0.1:3027',
    reuseExistingServer: false,
    timeout: 300_000,
    env: { NEXT_DIST_DIR: '.next-embed-ordering', BACKEND_URL: 'http://127.0.0.1:9', NEXT_PUBLIC_API_URL: '', NEXT_PUBLIC_WS_URL: 'ws://127.0.0.1:9' },
  },
});
