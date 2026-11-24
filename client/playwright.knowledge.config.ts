import { defineConfig, devices } from '@playwright/test';
import config from './playwright.config';

// Keep the Knowledge regression independently runnable, including a real narrow
// viewport. An installed Chromium can be used in restricted cloud environments.
export default defineConfig({
  ...config,
  testMatch: 'knowledge-form-accessibility.spec.ts',
  use: {
    ...config.use,
    video: 'off', // Screenshots and accessibility snapshots provide form evidence without FFmpeg.
    ...(process.env.E2E_CHROMIUM_EXECUTABLE_PATH ? {
      launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH },
    } : {}),
  },
  projects: [
    ...(config.projects || []),
    { name: 'narrow-chromium', use: { ...devices['iPhone SE'], defaultBrowserType: 'chromium', viewport: { width: 320, height: 568 } } },
  ],
});
