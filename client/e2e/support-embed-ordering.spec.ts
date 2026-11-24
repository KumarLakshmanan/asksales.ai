import { test, expect, expectNoHorizontalOverflow, installAppShellMocks } from './fixtures/app';
import type { Page, Route } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// Invalid as provider credentials by design. Every API request is intercepted.
const teams = [
  { teamId: 10, teamName: 'Synthetic team A', token: 'artificial-old-A-' + 'x'.repeat(47), installation: null, settings: { displayName: 'Synthetic care', greeting: 'Artificial fixture greeting', primaryColor: '#2563eb', logoUrl: '', launcherPosition: 'right' } },
  { teamId: 20, teamName: 'Synthetic team B', token: 'artificial-old-B-' + 'x'.repeat(47), installation: null, settings: { displayName: 'Synthetic care B', greeting: 'Artificial fixture greeting B', primaryColor: '#2563eb', logoUrl: '', launcherPosition: 'right' } },
];
const receipt = { teamId: 10, teamName: teams[0].teamName, token: 'artificial-fresh-A-' + 'x'.repeat(45) };
const evidenceDirectory = '../qa/support-embed-ordering-2026-10-11/evidence';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const section = (page: Page, name: string) => page.getByRole('region', { name });
async function rotateA(page: Page) {
  await page.getByRole('button', { name: 'Rotate widget key for Synthetic team A' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Rotate key', exact: true }).click();
}
async function freshA(page: Page) {
  const a = section(page, teams[0].teamName);
  await expect(a.getByText(receipt.token, { exact: true })).toBeVisible();
  await expect(a.locator('pre')).toHaveCount(2);
  for (const code of await a.locator('pre').all()) await expect(code).toContainText(receipt.token);
  await expect(a.getByRole('link', { name: 'Open Synthetic team A chat in a new tab' })).toHaveAttribute('href', new RegExp(receipt.token));
  await expect(a).not.toContainText(teams[0].token);
}
async function capture(page: Page, project: string, label: string, counts: Record<string, number>) {
  await expectNoHorizontalOverflow(page);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: visualViewport?.scale, documentWidth: document.documentElement.scrollWidth }));
  expect(viewport.scale).toBe(1);
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: `${evidenceDirectory}/${project}-${label}.png`, fullPage: true });
  await writeFile(`${evidenceDirectory}/${project}-${label}.json`, JSON.stringify({ viewport, counts, fixtureOnly: true }, null, 2) + '\n');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { (window as Window & { __embedCopied?: string }).__embedCopied = text; } },
    });
  });
  // Fallback denies real backend traffic, including unexpected shell calls.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:3027') return route.abort('blockedbyclient');
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.fallback();
  });
  await installAppShellMocks(page);
  await page.route('**/api/support-widget/token', route => route.fulfill({ json: { success: true, data: teams } }));
});

test('two teams serialize writes and recover keyboard focus after confirmation cancel', async ({ page }, info) => {
  const pending = deferred();
  const counts = { post: 0, delete: 0, read: 0 };
  await page.route('**/api/support-widget/token', route => { counts.read++; return route.fulfill({ json: { success: true, data: teams } }); });
  await page.route('**/api/support-widget/generate-token', async route => {
    counts.post++;
    expect(route.request().headers()['x-business-profile-id']).toBe('4102');
    expect(route.request().postDataJSON()).toEqual({ teamId: 10 });
    await pending.promise;
    await route.fulfill({ json: { success: true, data: receipt } });
  });
  await page.route('**/api/support-widget/token/20', route => { counts.delete++; return route.fulfill({ json: { success: true, data: { teamId: 20 } } }); });
  await page.goto('/dashboard/support-ai/embed');
  const trigger = page.getByRole('button', { name: 'Rotate widget key for Synthetic team A' });
  await expect(trigger).toBeVisible();
  const initialReads = counts.read; // Development Strict Mode can restart the initial effect.
  await trigger.focus();
  await page.keyboard.press('Enter');
  const cancel = page.getByRole('alertdialog').getByRole('button', { name: 'Keep current key' });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog').getByRole('button', { name: 'Rotate key', exact: true });
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => counts.post).toBe(1);
  await expect(section(page, teams[0].teamName).getByRole('heading', { name: teams[0].teamName })).toBeFocused();
  await expect(page.getByText(/Updating widget key/)).toBeVisible();
  await expect(section(page, teams[1].teamName).getByRole('button', { name: 'Revoke key', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Rotate widget key for Synthetic team B' })).toBeDisabled();
  for (const check of await page.getByRole('button', { name: 'Check installation' }).all()) await expect(check).toBeDisabled();
  expect(counts).toEqual({ post: 1, delete: 0, read: initialReads });
  await capture(page, info.project.name, 'write-pending', counts);
  pending.resolve();
  await freshA(page);
  await expect(section(page, teams[1].teamName).getByRole('button', { name: 'Revoke key', exact: true })).toBeEnabled();
  await section(page, teams[1].teamName).getByRole('button', { name: 'Revoke key', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate widget key for Synthetic team B' })).toBeEnabled();
  await freshA(page);
  expect(counts).toEqual({ post: 1, delete: 1, read: initialReads });
  for (const label of ['Copy floating chat button code for Synthetic team A', 'Copy inline chat widget code for Synthetic team A', 'Copy direct chat link for Synthetic team A']) {
    await page.getByRole('button', { name: label }).click();
    await expect.poll(() => page.evaluate(() => (window as Window & { __embedCopied?: string }).__embedCopied)).toContain(receipt.token);
  }
  await capture(page, info.project.name, 'receipts', counts);
});

test('a pending installation GET cannot revert committed rotation code', async ({ page }, info) => {
  const pending = deferred();
  const counts = { post: 0, read: 0 };
  let staleRoute: Route | undefined;
  let deferNextRead = false;
  let staleFinished = false;
  await page.route('**/api/support-widget/token', async route => {
    counts.read++;
    if (deferNextRead) { staleRoute = route; await pending.promise; }
    await route.fulfill({ json: { success: true, data: teams } }).catch(() => {}); // Aborted pre-write transport.
    if (deferNextRead) staleFinished = true;
  });
  await page.route('**/api/support-widget/generate-token', route => { counts.post++; return route.fulfill({ json: { success: true, data: receipt } }); });
  await page.goto('/dashboard/support-ai/embed');
  await expect(page.getByRole('button', { name: 'Check installation' }).first()).toBeEnabled();
  const initialReads = counts.read;
  deferNextRead = true;
  await page.getByRole('button', { name: 'Check installation' }).first().click();
  await expect.poll(() => Boolean(staleRoute)).toBe(true);
  await rotateA(page);
  await freshA(page);
  pending.resolve();
  await expect.poll(() => staleFinished).toBe(true);
  await expect(page.getByRole('button', { name: 'Check installation' }).first()).toBeEnabled();
  await freshA(page);
  expect(counts).toEqual({ post: 1, read: initialReads + 1 });
  await capture(page, info.project.name, 'stale-get', counts);
});

test('failed reads and writes retain state and offer keyboard retry', async ({ page }, info) => {
  const counts = { post: 0, read: 0 };
  let readReady = false;
  const failedWrite = deferred();
  await page.route('**/api/support-widget/token', route => {
    counts.read++;
    return !readReady ? route.fulfill({ status: 503, json: { error: 'Artificial read failure' } }) : route.fulfill({ json: { success: true, data: teams } });
  });
  await page.route('**/api/support-widget/generate-token', async route => {
    counts.post++;
    if (counts.post === 1) await failedWrite.promise;
    return counts.post === 1 ? route.fulfill({ status: 503, json: { error: 'Artificial write failure' } }) : route.fulfill({ json: { success: true, data: receipt } });
  });
  await page.goto('/dashboard/support-ai/embed');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  const failedReads = counts.read;
  readReady = true;
  await retry.focus();
  await page.keyboard.press('Enter');
  const trigger = page.getByRole('button', { name: 'Rotate widget key for Synthetic team A' });
  await expect(trigger).toBeVisible();
  await rotateA(page);
  await expect(section(page, teams[0].teamName).getByRole('heading', { name: teams[0].teamName })).toBeFocused();
  failedWrite.resolve();
  await expect(page.getByText('Artificial write failure', { exact: true })).toBeVisible();
  await expect(trigger).toBeEnabled();
  await expect(section(page, teams[0].teamName).getByText(teams[0].token, { exact: true })).toBeVisible();
  await expect(section(page, teams[0].teamName).getByRole('heading', { name: teams[0].teamName })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog').getByRole('button', { name: 'Rotate key', exact: true });
  await confirm.focus();
  await page.keyboard.press('Enter');
  await freshA(page);
  expect(counts).toEqual({ post: 2, read: failedReads + 1 });
  await capture(page, info.project.name, 'keyboard-retry', counts);
});

test('dashboard profile gate recovers by keyboard before the embed page mounts', async ({ page }, info) => {
  const counts = { profileRead: 0, widgetRead: 0 };
  let phase: 'error' | 'empty' | 'ready' = 'error';
  await page.route('**/api/settings/business-profiles', route => {
    counts.profileRead++;
    if (phase === 'error') return route.fulfill({ status: 403, json: { error: 'Artificial profile failure' } });
    return route.fulfill({ json: phase === 'empty' ? [] : [{ id: 4102, companyName: 'Synthetic workspace', isDefault: true, role: 'owner' }] });
  });
  await page.route('**/api/support-widget/token', route => { counts.widgetRead++; return route.fulfill({ json: { success: true, data: teams } }); });
  await page.goto('/dashboard/support-ai/embed');
  await expect(page.getByRole('alert').filter({ hasText: 'Your business profile could not be loaded' })).toBeVisible();
  const retry = page.getByRole('button', { name: 'Try again', exact: true });
  phase = 'empty';
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => counts.profileRead).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole('alert').filter({ hasText: 'Your business profile could not be loaded' })).toBeVisible();
  expect(counts.widgetRead).toBe(0);
  phase = 'ready';
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(section(page, teams[0].teamName)).toBeVisible();
  expect(counts.widgetRead).toBeGreaterThanOrEqual(1);
  await capture(page, info.project.name, 'profile-retry', counts);
});
