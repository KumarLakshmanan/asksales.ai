import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig(base, {
  testMatch: ['knowledge-form-accessibility.spec.ts', 'knowledge-validation-feedback.spec.ts', 'knowledge-toast-guarded.spec.ts'],
  retries: 0,
  workers: 1,
  reporter: [['line'], ['json', { outputFile: process.env.KNOWLEDGE_RESULTS || '/tmp/knowledge-toast/results.json' }]],
  outputDir: process.env.KNOWLEDGE_OUTPUT || '/tmp/knowledge-toast/browser',
  use: { trace: 'on', video: 'off', serviceWorkers: 'block', launchOptions: { executablePath: process.env.KNOWLEDGE_CHROMIUM || '/usr/bin/chromium' } },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'narrow-chromium', use: { ...devices['Pixel 7'], viewport: { width: 320, height: 568 } } },
  ],
});
