import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3019';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'ai-visibility-pdf-diagnosis.spec.ts',
  timeout: 180_000,
  expect: { timeout: 90_000 },
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: { executablePath: process.env.AS019_CHROMIUM_EXECUTABLE_PATH } } },
    { name: 'narrow-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, launchOptions: { executablePath: process.env.AS019_CHROMIUM_EXECUTABLE_PATH } } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
    { name: 'narrow-firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: process.env.E2E_SKIP_WEBSERVER === '1' ? undefined : {
    command: 'npm run dev -- --webpack --hostname 127.0.0.1 --port 3019',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
    env: { NEXT_DIST_DIR: '.next-as019-dev', NEXT_PUBLIC_API_URL: 'http://127.0.0.1:9', NEXT_PUBLIC_WS_URL: 'ws://127.0.0.1:9' },
  },
});
