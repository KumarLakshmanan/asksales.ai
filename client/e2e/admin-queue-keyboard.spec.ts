import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { fixtures } from './fixtures/ui-navigation';

async function queueFixtures(page: import('@playwright/test').Page, role = 'super_admin') {
  const state = await fixtures(page); const operations: string[] = []; let fail = false, failJobs = false, emptyJobs = false;
  await page.route('**/api/admin/me', route => route.fulfill({ json: { admin: { id: 1, name: 'Synthetic Admin', email: 'admin@example.test', role } } }));
  await page.route('**/api/admin/queues**', route => {
    if (route.request().method() !== 'GET') { operations.push(route.request().method() + ' ' + new URL(route.request().url()).pathname); return route.fulfill({ status: 409, json: { error: 'Synthetic read-only queue inspection' } }); }
    const url = new URL(route.request().url());
    if (fail || (failJobs && url.pathname.includes('/jobs'))) return route.fulfill({ status: 503, json: { error: 'Synthetic queue read unavailable' } });
    return route.fulfill({ json: url.pathname.endsWith('/queues')
      ? [{ queueName: 'synthetic-queue', waiting: 1, active: 0, completed: 0, failed: 1, delayed: 0, isPaused: false }]
      : { jobs: emptyJobs ? [] : [{ id: 'synthetic-job', name: 'Synthetic diagnostic job', status: 'failed', data: { account: '[REDACTED]' }, opts: {}, attemptsMade: 1, failedReason: 'Synthetic failure', stacktrace: [], returnvalue: null, timestamp: 1, processedOn: null, finishedOn: null }], total: emptyJobs ? 0 : 1, start: 0, end: 49, hasMore: false } });
  });
  return { state, operations, setFailure: (value: boolean) => { fail = value; }, setJobsFailure: (value: boolean) => { failJobs = value; }, setEmptyJobs: () => { emptyJobs = true; } };
}

test('queue cards and job disclosures support keyboard focus at the actual viewport', async ({ page }) => {
  const { operations, state } = await queueFixtures(page);
  const dark = test.info().project.name === 'mobile-chromium';
  await page.goto('/admin/dashboard/queues');
  expect(await page.evaluate(() => innerWidth)).toBe(page.viewportSize()!.width);
  if (dark) {
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
  }
  const queue = page.getByRole('button', { name: 'View jobs in synthetic-queue' });
  await expect(queue).toBeVisible(); await queue.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(queue).toBeFocused();
  await page.screenshot({ path: `${process.env.UI_FIX_SCREENSHOTS || '/tmp'}/${test.info().project.name}-admin-queue-card.png`, fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Enter');
  const heading = page.getByRole('heading', { name: 'Queue: synthetic-queue' });
  await expect(heading).toBeFocused();
  const disclosure = page.getByRole('button', { name: /^(Show|Hide) details for job synthetic-job$/ });
  await disclosure.focus(); await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true'); await expect(disclosure).toBeFocused();
  const details = page.getByRole('region', { name: 'Details for job synthetic-job' });
  await expect(details).toContainText('[REDACTED]');
  await expect(disclosure).toHaveAttribute('aria-controls', (await details.getAttribute('id'))!);
  await page.screenshot({ path: `${process.env.UI_FIX_SCREENSHOTS || '/tmp'}/${test.info().project.name}-admin-queue-details.png`, fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Space'); await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(details).toBeHidden(); await expect(disclosure).toBeFocused();
  await page.getByRole('button', { name: 'Back to queue overview' }).click();
  await expect(queue).toBeFocused(); await page.keyboard.press('Space'); await expect(heading).toBeFocused();
  await expectNoHorizontalOverflow(page); expect(operations).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test('non-super admins cannot inspect queues and keyboard corrections add no operations', async ({ page }) => {
  const { state, operations } = await queueFixtures(page, 'admin');
  await page.goto('/admin/dashboard/queues');
  await expect(page.getByRole('heading', { name: 'Super admin access required' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View jobs in synthetic-queue' })).toBeHidden();
  expect(state.requests.filter(path => path.includes('/api/admin/queues'))).toEqual([]);
  expect(operations).toEqual([]);
});

test('queue read failures recover to actual empty results without queue operations', async ({ page }) => {
  const { operations, setFailure, setJobsFailure, setEmptyJobs } = await queueFixtures(page);
  setFailure(true); await page.goto('/admin/dashboard/queues');
  await expect(page.getByText('Synthetic queue read unavailable')).toBeVisible();
  setFailure(false); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const queue = page.getByRole('button', { name: 'View jobs in synthetic-queue' });
  await expect(queue).toBeVisible(); setJobsFailure(true);
  await queue.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Queue: synthetic-queue' })).toBeFocused();
  await expect(page.getByText('Synthetic queue read unavailable')).toBeVisible();
  await expect(page.getByText('No jobs found.', { exact: true })).toBeHidden();
  setJobsFailure(false); setEmptyJobs();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('No jobs found.', { exact: true })).toBeVisible();
  const back = page.getByRole('button', { name: 'Back to queue overview' });
  await back.focus(); await page.keyboard.press('Enter'); await expect(queue).toBeFocused();
  expect(operations).toEqual([]);
});
