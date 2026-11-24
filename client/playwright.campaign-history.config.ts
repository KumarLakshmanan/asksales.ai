import { defineConfig } from '@playwright/test';
import config from './playwright.config';

export default defineConfig({
  ...config,
  testMatch: 'campaign-history-accessibility.spec.ts',
  expect: { timeout: 15_000 },
  use: {
    ...config.use,
    video: 'off',
    ...(process.env.E2E_CHROMIUM_EXECUTABLE_PATH ? {
      launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH },
    } : {}),
  },
  projects: [
    { name: 'desktop-live-size', use: { viewport: { width: 1180, height: 757 } } },
    { name: 'desktop-wide', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'narrow', use: { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true } },
  ],
});
