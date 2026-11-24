import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig(base, {
  testMatch: ['ai-visibility-seo-health.spec.ts'],
  retries: 0,
  workers: 1,
  reporter: 'line',
  outputDir: process.env.SEO_OUTPUT || 'test-results/seo-health',
  use: {
    trace: 'retain-on-failure',
    video: 'off',
    serviceWorkers: 'block',
    launchOptions: process.env.SEO_CHROMIUM ? { executablePath: process.env.SEO_CHROMIUM } : {},
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
