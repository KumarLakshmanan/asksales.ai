import { defineConfig } from '@playwright/test';
import path from 'node:path';

const output = process.env.SETUP_AUDIT_OUTPUT || '/tmp/setup-audit-tools';

// An explicitly local frontend with API/provider fixtures. Use real CSS viewport
// widths at normal zoom instead of scaling a desktop screenshot down.
export default defineConfig({
  testDir: './e2e',
  testMatch: /(?:workspace-setup(?:-audit|-enhancements)?|ordinary-preferences-audit)\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['line'], ['json', { outputFile: path.join(output, 'browser-results.json') }]],
  outputDir: path.join(output, 'browser-artifacts'),
  use: {
    baseURL: process.env.WORKSPACE_AUDIT_BROWSER_URL || 'http://127.0.0.1:3100',
    launchOptions: { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [390, 768, 1440].map(width => ({
    name: width === 390 ? 'mobile-chromium' : `viewport-${width}`,
    use: { viewport: { width, height: width === 390 ? 844 : 900 } },
  })),
});
