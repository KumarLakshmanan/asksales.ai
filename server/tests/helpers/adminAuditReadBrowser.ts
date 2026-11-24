import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import type { Page } from '@playwright/test';

/** Selected real page/API read fixture; no production auth or mutation endpoints. */
export async function withAdminAuditReadBrowser(app: Express, work: (page: Page) => Promise<void>) {
  const { chromium } = await import('@playwright/test');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'fixture', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', value => { output += value.toString(); });
  child.stderr.on('data', value => { output += value.toString(); });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    for (let attempt = 0; !output.includes('AUDIT_BROWSER_URL=') && attempt < 200; attempt++) {
      if (child.exitCode !== null) throw Error(output);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const url = output.match(/AUDIT_BROWSER_URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (!url) throw Error('Audit browser fixture did not start: ' + output);
    browser = await chromium.launch({ headless: true, executablePath: process.env.ADMIN_HELD_CHROMIUM_EXECUTABLE,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await work(page);
    expectNoErrors(errors);
  } finally {
    await browser?.close(); child.kill('SIGTERM');
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
function expectNoErrors(errors: string[]) { if (errors.length) throw Error(errors.join('\n')); }

if (process.argv[2] === 'fixture') {
  const client = fileURLToPath(new URL('../../../client/', import.meta.url));
  const requireClient = createRequire(path.join(client, 'package.json'));
  const requireVitest = createRequire(requireClient.resolve('vitest'));
  const { createServer } = await import(requireVitest.resolve('vite'));
  const root = await mkdtemp(path.join(tmpdir(), 'admin-audit-read-'));
  await symlink(path.join(client, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(path.join(root, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>');
  await writeFile(path.join(root, 'main.tsx'), "import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import Page from '@/app/admin/dashboard/audit-logs/page';createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Page/></QueryClientProvider>);");
  const fixture = await createServer({ configFile: false, envFile: false, root, esbuild: { jsx: 'automatic' },
    define: { 'process.env.NEXT_PUBLIC_API_URL': '""' },
    resolve: { dedupe: ['react', 'react-dom'], alias: { '@': path.join(client, 'src') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, client] }, proxy: { '/api': { target: 'http://127.0.0.1:' + process.argv[3] } } },
  });
  await fixture.listen();
  console.log('AUDIT_BROWSER_URL=http://127.0.0.1:' + fixture.httpServer.address().port);
  process.on('SIGTERM', async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); process.exit(0); });
}
