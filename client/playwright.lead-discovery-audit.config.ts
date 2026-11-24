import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: ['enrichment-step-status.spec.ts', 'leads-table-ux003.spec.ts', 'lead-discovery-runtime-audit.spec.ts', 'lead-enrichment-accessibility.spec.ts', 'lead-enrichment-execution.spec.ts'],
  timeout: 120000,
  expect: { timeout: 30000 },
  workers: 1,
  retries: 0,
  reporter: [['line'], ['json', { outputFile: '../qa/lead-discovery-2026-10-23/browser-results.json' }]],
  outputDir: '../qa/lead-discovery-2026-10-23/browser-artifacts',
  use: {
    baseURL: 'http://127.0.0.1:5300',
    launchOptions: { executablePath: '/usr/bin/chromium' },
    screenshot: 'only-on-failure', trace: 'retain-on-failure', video: 'off',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
  ],
});
