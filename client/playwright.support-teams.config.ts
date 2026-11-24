import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

// Use an isolated local server and disposable API fixtures for this form-state QA.
export default defineConfig({
  ...baseConfig,
  testMatch: 'support-teams-forms.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: process.env.E2E_SUPPORT_TEAMS_OUTPUT_DIR || './test-results/support-teams',
  reporter: [['line'], ['json', { outputFile: process.env.E2E_SUPPORT_TEAMS_REPORT || './test-results/support-teams-report.json' }]],
  use: {
    ...baseConfig.use,
    browserName: 'chromium',
    video: 'off',
    ...(process.env.E2E_CHROMIUM_EXECUTABLE ? {
      launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] },
    } : {}),
  },
  projects: [
    { name: 'phone-360x800', use: { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
    { name: 'phone-393x852', use: { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
    { name: 'tablet-768x1024', use: { viewport: { width: 768, height: 1024 }, hasTouch: true, deviceScaleFactor: 1 } },
    { name: 'tablet-820x1180', use: { viewport: { width: 820, height: 1180 }, hasTouch: true, deviceScaleFactor: 1 } },
    { name: 'desktop-1440x900', use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
  ],
});
