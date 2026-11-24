import { test, expect, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type {} from './fixtures/campaign-email-generation';

// Compile the actual production components into an isolated browser workbench.
// Every HTTP request is fulfilled locally; no application/API server or live provider is contacted.
const root = resolve(__dirname, '../..');
const outputDir = mkdtempSync(resolve(tmpdir(), 'campaign-email-browser-'));
execFileSync(resolve(root, 'server/node_modules/.bin/esbuild'), [
  resolve(__dirname, 'fixtures/campaign-email-generation.tsx'), '--bundle', '--platform=browser', '--format=iife', '--jsx=automatic',
  '--alias:@=' + resolve(root, 'client/src'), '--define:process.env.NODE_ENV="development"', '--define:process.env.NEXT_PUBLIC_API_URL=""',
  '--outfile=' + resolve(outputDir, 'workbench.js'),
], { stdio: 'pipe' });
execFileSync(resolve(root, 'client/node_modules/.bin/tailwindcss'), [
  '-c', resolve(root, 'client/tailwind.config.ts'), '-i', resolve(root, 'client/src/app/globals.css'), '-o', resolve(outputDir, 'workbench.css'),
], { cwd: resolve(root, 'client'), stdio: 'pipe' });
const script = readFileSync(resolve(outputDir, 'workbench.js'), 'utf8');
const css = readFileSync(resolve(outputDir, 'workbench.css'), 'utf8');
const generated = { subject: 'Validated campaign subject', greeting: 'Hello {{first_name}},', body: 'Validated campaign body.', cta: 'Read the notes.', closing: 'Kind regards,', signature: 'Fixture Team' };
const fullBody = 'Hello {{first_name}},\n\nValidated campaign body.\n\nRead the notes.\n\nKind regards,\n\nFixture Team';
const envelope = { success: true, content: JSON.stringify(generated), emailContent: generated };
test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }, video: 'off', actionTimeout: 10_000 });
test.setTimeout(60_000);

async function fixture(page: Page, caller: 'send' | 'outreach') {
  const requests: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const queued: Route[] = [];
  const state = { response: envelope as unknown, status: 200, hold: false };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101 }));
    sessionStorage.setItem('active-business-profile:4101', '4102');
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') {
      unexpected.push(request.method() + ' ' + url.pathname);
      return route.abort();
    }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/workbench.css"></head><body><div id="root"></div><script src="/workbench.js"></script></body></html>' });
    if (url.pathname === '/workbench.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/workbench.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname === '/api/content/studio/email' && request.method() === 'POST') {
      requests.push(request.postDataJSON());
      if (state.hold) { queued.push(route); return; }
      return route.fulfill({ status: state.status, json: state.response });
    }
    if (request.method() === 'GET' && ['/api/email-outreach/templates', '/api/content/templates'].includes(url.pathname)) return route.fulfill({ json: [] });
    unexpected.push(request.method() + ' ' + url.pathname);
    return route.fulfill({ status: 409, json: { error: 'Only generation fixtures are allowed.' } });
  });
  // Loopback is a secure browser context, so the real idempotency-key WebCrypto code runs.
  await page.goto('http://127.0.0.1:38888/?caller=' + caller);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  if (caller === 'outreach') {
    await dialog.getByRole('tab', { name: 'Custom Email' }).click();
    await dialog.getByLabel('Subject', { exact: true }).fill('Existing reviewed subject');
    await dialog.getByLabel('Body', { exact: true }).fill('Existing reviewed manual body.');
    await dialog.getByRole('tab', { name: 'Generate with AI' }).click();
  }
  const subject = dialog.getByLabel('Subject', { exact: true });
  const body = dialog.getByLabel(caller === 'send' ? 'Email Body' : 'Body', { exact: true });
  const generate = dialog.getByRole('button', { name: caller === 'send' ? 'AI Generate' : 'Generate Email', exact: true });
  const release = async (response: unknown) => {
    for (const route of queued.splice(0)) {
      try { await route.fulfill({ json: response }); } catch { /* Browser cancelled the fixture request. */ }
    }
  };
  return { state, requests, unexpected, errors, dialog, subject, body, generate, release };
}

for (const caller of ['send', 'outreach'] as const) {
  test(`${caller}: actual composer applies persist:false copy and retains it on provider/invalid errors`, async ({ page }, testInfo) => {
    const f = await fixture(page, caller);
    await f.generate.click();
    await expect(f.subject).toHaveValue(generated.subject);
    await expect(f.body).toHaveValue(fullBody);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ persist: false, prompt: expect.any(String) });
    await f.dialog.screenshot({ path: testInfo.outputPath(caller + '-generated.png') });
    await f.subject.fill('My newer reviewed subject');
    await f.body.fill('My newer manual body.');
    f.state.status = 503;
    f.state.response = { success: false, code: 'AI_PROVIDER_CREDITS', error: 'fixture-upstream-secret' };
    await f.generate.click();
    await expect(f.dialog.getByRole('alert')).toContainText('provider has insufficient credits');
    await expect(f.subject).toHaveValue('My newer reviewed subject');
    await expect(f.body).toHaveValue('My newer manual body.');
    await expect(page.getByText('fixture-upstream-secret')).toHaveCount(0);
    await f.dialog.screenshot({ path: testInfo.outputPath(caller + '-failure-retains-draft.png') });
    f.state.status = 200; f.state.response = { success: true };
    await f.generate.click();
    await expect(f.dialog.getByRole('alert')).toContainText('invalid email');
    await expect(f.subject).toHaveValue('My newer reviewed subject');
    await expect(f.body).toHaveValue('My newer manual body.');
    expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
  });
  test(`${caller}: duplicate clicks, manual edits, cancellation and close ignore late completions`, async ({ page }) => {
    const f = await fixture(page, caller);
    f.state.hold = true;
    await f.generate.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => f.requests.length).toBe(1);
    await f.body.fill('Manual edits during generation.');
    await expect(f.dialog.getByRole('alert')).toContainText('will not replace your edits');
    await f.release(envelope);
    await expect(f.body).toHaveValue('Manual edits during generation.');
    await f.generate.click();
    await expect.poll(() => f.requests.length).toBe(2);
    await f.dialog.getByRole('button', { name: 'Stop waiting' }).click();
    await f.release(envelope);
    await expect(f.subject).toHaveValue('Existing reviewed subject');
    await expect(f.body).toHaveValue('Manual edits during generation.');
    await f.generate.click();
    await expect.poll(() => f.requests.length).toBe(3);
    await page.evaluate(() => window.emailWorkbench.close());
    await expect(f.dialog).toHaveCount(0);
    await f.release(envelope);
    await expect(page.getByText('Email Generated', { exact: true })).toHaveCount(0);
    expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
  });
}
