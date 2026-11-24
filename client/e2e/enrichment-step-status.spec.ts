import type { Page, TestInfo } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';
import { historyRun, historySteps, ordinaryHistoryRun } from '../src/__tests__/fixtures/enrichmentHistory';

test.use({ video: 'off', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });
const shellReads = new Set(['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/settings/business-profiles',
  '/api/organizations', '/api/wallet', '/api/crm/configuration', '/api/notifications/unread/count', '/api/settings/outreach/assistants/catalog']);
const viewports = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }];

async function checkSteps(page: Page, steps: typeof historySteps, stale = false) {
  const bubbles = page.locator('main [class~="max-w-[85%]"]');
  await expect(bubbles).toHaveCount(steps.length);
  for (const [index, step] of steps.entries()) {
    const bubble = bubbles.nth(index), row = bubble.locator('div.text-xs.text-muted-foreground');
    await bubble.scrollIntoViewIfNeeded();
    await expect(row.getByText(step.status, { exact: true })).toBeVisible();
    await expect(row).toHaveText(`${step.status}${step.durationMs == null ? '' : `· Elapsed time: ${step.durationMs === 0 ? '0s' : '1s'}`}`);
    const accessibility = await row.ariaSnapshot();
    expect(accessibility.toLowerCase()).toContain(step.status);
    if (step.durationMs != null) expect(accessibility).toContain(`Elapsed time: ${step.durationMs === 0 ? '0s' : '1s'}`);
    else expect(accessibility).not.toContain('Elapsed time:');
    const icon = { completed: '.lucide-circle-check', failed: '.lucide-circle-x', running: '.lucide-loader-circle', pending: '' }[step.status];
    if (icon && !(stale && step.status === 'running')) {
      await expect(row.locator(icon)).toHaveCount(1);
      await expect(row.locator(icon)).toHaveAttribute('aria-hidden', 'true');
    } else await expect(row.locator('svg')).toHaveCount(0);
    const bounds = await row.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await expectNoHorizontalOverflow(page);
}

async function evidence(page: Page, info: TestInfo, state: string) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: visualViewport?.scale,
    zoom: getComputedStyle(document.documentElement).zoom, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.width).toBe(page.viewportSize()?.width);
  expect(dimensions.height).toBe(page.viewportSize()?.height);
  expect(dimensions.scale).toBe(1);
  expect(dimensions.zoom).toBe('1');
  await info.attach(`${state}-dimensions`, { body: JSON.stringify(dimensions), contentType: 'application/json' });
  await info.attach(`${state}-accessibility`, { body: await page.getByRole('main').ariaSnapshot(), contentType: 'text/plain' });
  const screenshot = info.outputPath(`${state}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach(`${state}-screenshot`, { path: screenshot, contentType: 'image/png' });
}

for (const viewport of viewports) for (const theme of ['light', 'dark']) {
  test.describe(`${viewport.width}×${viewport.height} ${theme}`, () => {
    test.use({ viewport });
    test('history preserves recorded statuses, elapsed time and run semantics at normal zoom', async ({ page, audit }, info) => {
      const writes: string[] = [], unexpectedReads: string[] = [], externalRequests: string[] = [];
      const runs = [historyRun(), ordinaryHistoryRun('running', 902), ordinaryHistoryRun('pending', 903), ordinaryHistoryRun('running', 904, '2020-01-01T00:00:00Z')];
      runs[3].leadName = 'Synthetic stale history';
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(info.project.use.baseURL as string).origin) {
          externalRequests.push(url.origin + url.pathname);
          return route.abort();
        }
        return route.fallback();
      });
      await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (!['GET', 'HEAD'].includes(request.method())) {
          writes.push(`${request.method()} ${url.pathname}`);
          return route.fulfill({ status: 409, json: { error: 'Synthetic history fixture forbids every mutation.' } });
        }
        if (url.pathname === '/api/settings/preferences') return route.fulfill({ json: { theme, language: 'en', timezone: 'UTC' } });
        if (shellReads.has(url.pathname)) return route.fallback();
        if (url.pathname === '/api/chat/threads') return route.fulfill({ json: { threads: [], total: 0 } });
        if (url.pathname === '/api/enrichments') return route.fulfill({ json: runs.map(({ steps: _steps, ...run }) => run) });
        const run = runs.find(item => url.pathname === `/api/enrichments/${item.id}`);
        if (run) return route.fulfill({ json: run });
        unexpectedReads.push(url.pathname);
        return route.fulfill({ json: {} });
      });
      await page.addInitScript(value => localStorage.setItem('theme', value), theme);
      await page.goto('/dashboard/enrichment');
      await expect(page.locator('html')).toHaveClass(new RegExp(theme));
      for (const run of runs) {
        await page.getByRole('button', { name: new RegExp(run.leadName) }).click();
        const stale = run.id === 904;
        await checkSteps(page, run.steps, stale);
        if (run.status === 'completed') {
          await expect(page.getByText('Completed', { exact: true })).toBeVisible();
          await expect(page.getByText('Enrichment complete', { exact: true })).toBeVisible();
          await page.locator('main [class~="max-w-[85%]"]').first().scrollIntoViewIfNeeded();
        } else {
          await expect(page.getByText('Enrichment complete', { exact: true })).toHaveCount(0);
          await expect(page.getByText(stale ? 'Recorded: Running' : run.status === 'running' ? 'Running' : 'Pending', { exact: true })).toBeVisible();
          if (stale) await expect(page.getByRole('main').getByRole('alert')).toContainText('does not confirm the worker is still active');
          else await expect(page.getByText(run.status === 'running' ? 'Processing...' : 'Queued for enrichment...', { exact: true })).toBeVisible();
        }
        await evidence(page, info, stale ? 'stale' : run.status);
        await page.getByRole('button', { name: 'Back to enrichment runs' }).click();
      }
      expect(writes).toEqual([]);
      expect(unexpectedReads).toEqual([]);
      expect(externalRequests).toEqual([]);
      expect(audit.blockedMutations).toEqual([]);
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.failedRequests).toEqual([]);
      await info.attach('transport', { body: JSON.stringify({ writes, unexpectedReads, externalRequests }), contentType: 'application/json' });
    });
  });
}
