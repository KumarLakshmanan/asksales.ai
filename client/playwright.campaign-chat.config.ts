import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// Screenshot review of the campaign chat with a synthetic lead -> outreach
// conversation. Uses its own port and build folder so it can run beside
// another local dev server.
const port = Number(process.env.CAMPAIGN_CHAT_PORT || 3211);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig(base, {
  testMatch: ['campaign-chat-flow-review.spec.ts'],
  retries: 0,
  workers: 1,
  reporter: 'line',
  outputDir: process.env.CAMPAIGN_CHAT_OUTPUT || 'test-results/campaign-chat',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'off',
    serviceWorkers: 'block',
    launchOptions: process.env.CAMPAIGN_CHAT_CHROMIUM ? { executablePath: process.env.CAMPAIGN_CHAT_CHROMIUM } : {},
  },
  webServer: {
    command: `npx next dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 300_000,
    env: { NEXT_DIST_DIR: '.next-campaign-chat', NEXT_PUBLIC_API_URL: baseURL },
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], viewport: { width: 375, height: 812 } } },
  ],
});
