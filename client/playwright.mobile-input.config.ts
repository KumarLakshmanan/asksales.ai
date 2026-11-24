import { defineConfig, devices } from '@playwright/test';

// This suite must never target staging/production or use stored authentication.
const baseURL = 'http://127.0.0.1:3066';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'mobile-input-lifecycle.spec.ts',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [['line'], ['json', { outputFile: 'test-results/mobile-input-results.json' }]],
  use: {
    baseURL,
    serviceWorkers: 'block',
    permissions: [],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'narrow-mobile-chromium', use: { ...devices['Pixel 7'], viewport: { width: 320, height: 568 } } },
  ],
  webServer: {
    command: 'node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3066',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    env: {
      NEXT_DIST_DIR: '.next-sales-focused-6',
      NEXT_PUBLIC_API_URL: baseURL,
      NEXT_PUBLIC_WS_URL: 'ws://127.0.0.1:3066',
      BACKEND_URL: 'http://127.0.0.1:9',
    },
  },
});
