import { defineConfig, devices } from '@playwright/test';
import config from './playwright.config';

export default defineConfig({
  ...config,
  testMatch: /storage-(workspace|search-recovery)\.spec\.ts/,
  use: {
    ...config.use,
    video: 'off',
    ...(process.env.E2E_CHROMIUM_EXECUTABLE_PATH ? {
      launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH },
    } : {}),
  },
  projects: [
    ...(config.projects || []),
    { name: 'mobile-narrow-chromium', use: { ...devices['iPhone SE'], defaultBrowserType: 'chromium', viewport: { width: 320, height: 568 } } },
  ],
});
