import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import type { Page } from '@playwright/test';

/** Actual pages/API clients against a task-local selected read handler. */
export async function withAdminReadBrowser(app: Express, view: string, work: (page: Page) => Promise<void>) {
  const { chromium } = await import('@playwright/test');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const fixture = fileURLToPath(new URL('./adminUsageBrowserFixture.ts', import.meta.url));
  const child = spawn(process.execPath, [fixture, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const started = Date.now();
    while (!output.includes('BROWSER_URL=') && Date.now() - started < 20000) {
      if (child.exitCode !== null) throw new Error(output);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const url = output.match(/BROWSER_URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (!url) throw new Error(`Local browser fixture did not start: ${output}`);
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.ADMIN_USAGE_CHROMIUM_EXECUTABLE || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url + '?view=' + encodeURIComponent(view));
    await work(page);
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    await browser?.close(); child.kill('SIGTERM');
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
