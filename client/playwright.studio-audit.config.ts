import { defineConfig, devices } from '@playwright/test';
import config from './playwright.config';

// Start the local frontend separately with provider URLs disabled. These
// browser suites intercept all application APIs and sockets with fixtures.
export default defineConfig({
  ...config,
  testMatch: ['studio-audit.spec.ts', 'studio-corrections.spec.ts', 'content-template-editors.spec.ts', 'saved-blog-editor-lifecycle.spec.ts'],
  webServer: undefined,
  retries: 0,
  use: { ...config.use, baseURL: 'http://127.0.0.1:3027', video: 'off', launchOptions: { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' } },
  projects: [
    { name: 'studio-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
    { name: 'studio-narrow', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
  ],
});
