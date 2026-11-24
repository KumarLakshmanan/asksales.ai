import type { Page, Route } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

// The real route and shell, isolated from all live APIs and application sockets.
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page, audit }) => {
  await page.clock.setFixedTime(new Date('2026-10-11T12:00:00Z'));
  await page.routeWebSocket(url => !url.pathname.startsWith('/_next/'), () => {});
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method())) {
      audit.blockedMutations.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'Calendar keyboard fixture forbids mutations.' } });
    }
    if (/^\/api\/(auth\/me|platform\/access|settings\/preferences|settings\/business-profiles|organizations|crm\/configuration|wallet|chat\/threads|notifications\/unread\/count)$/.test(path)) return route.fallback();
    return route.fulfill({ json: path === '/api/content/calendar' ? { items: [] } : {} });
  });
});

const sample = {
  id: 9101, sourceKey: 'asset-9101', contentAssetId: 9101, title: 'Keyboard fixture post',
  content: 'Synthetic reviewed caption', platform: 'instagram', status: 'scheduled', type: 'post',
  scheduled_date: '2026-10-11', scheduled_time: '16:45', publishAttempts: [],
};

function navigation(page: Page, direction = 'Next', mode = 'month') {
  return page.getByRole('button', { name: `${direction} ${mode}`, exact: true });
}

function dateLabel(page: Page, mode = 'month') {
  return navigation(page, 'Previous', mode).locator('..').locator('span');
}

async function openCalendar(page: Page, items: object[] = []) {
  await page.route('**/api/content/calendar?*', route => route.fulfill({ json: { items } }));
  await page.goto('/dashboard/content-calendar');
  await expect(dateLabel(page)).toHaveText('October, 2026');
}

test('month keyboard activation keeps focus after the async refresh in both directions', async ({ page, audit }) => {
  await page.setViewportSize({ width: 1180, height: 757 });
  await openCalendar(page);
  const next = navigation(page);
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(dateLabel(page)).toHaveText('November, 2026');
  await expect(next).toBeFocused();
  const previous = navigation(page, 'Previous');
  await previous.focus();
  await page.keyboard.press('Space');
  await expect(dateLabel(page)).toHaveText('October, 2026');
  await expect(previous).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dateLabel(page)).toHaveText('September, 2026');
  await expect(previous).toBeFocused();
  expect(audit.blockedMutations).toEqual([]);
});

test('week dates are semantic keyboard buttons for populated and empty drawers', async ({ page, audit }) => {
  await openCalendar(page, [sample]);
  await page.getByRole('button', { name: 'Weekly', exact: true }).click();
  const populated = page.getByText('SUN', { exact: true }).locator('..');
  await expect(populated).toHaveJSProperty('tagName', 'BUTTON', { timeout: 5000 });
  await populated.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText(sample.title);
  await page.keyboard.press('Escape');
  const empty = page.getByRole('button', { name: 'View content for October 12, 2026', exact: true });
  await empty.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog')).toContainText('No content scheduled');
  await expect(page.getByRole('dialog')).toContainText('Create a post or choose another date.');
  await expect(page.getByRole('dialog')).toContainText('October 12, 2026');
  expect(audit.blockedMutations).toEqual([]);
});

test('filtered day distinguishes hidden content and clears only local filters', async ({ page, audit }) => {
  await openCalendar(page, [sample]);
  await page.getByRole('button', { name: 'Select scheduled posts', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select Keyboard fixture post', exact: true }).check();
  await page.getByRole('combobox', { name: 'Filter by platform' }).click();
  await page.getByRole('option', { name: 'YouTube', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter by status' }).click();
  await page.getByRole('option', { name: 'Published', exact: true }).click();
  await page.getByRole('button', { name: 'View content for October 12, 2026', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('No content scheduled');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByText('11', { exact: true }).locator('..').click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('No content matches your filters');
  await expect(drawer.getByText('No content scheduled', { exact: true })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(drawer).toContainText(sample.title);
  await expect(drawer).toContainText('October 11, 2026');
  await expect(drawer.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox', { name: 'Filter by platform' })).toContainText('All platforms');
  await expect(page.getByRole('combobox', { name: 'Filter by status' })).toContainText('All statuses');
  await expect(page.getByRole('button', { name: 'Cancel 1 selected', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select Keyboard fixture post', exact: true })).toBeChecked();
  expect(audit.blockedMutations).toEqual([]);
});

test('week filtered-empty recovery preserves the day and underlying posts', async ({ page, audit }) => {
  await openCalendar(page, [sample]);
  await page.getByRole('button', { name: 'Weekly', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter by status' }).click();
  await page.getByRole('option', { name: 'Published', exact: true }).click();
  const day = page.getByRole('button', { name: 'View content for October 11, 2026', exact: true });
  await day.focus();
  await page.keyboard.press('Space');
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('No content matches your filters');
  await drawer.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(drawer).toContainText(sample.title);
  await expect(drawer).toContainText('October 11, 2026');
  await page.keyboard.press('Escape');
  await expect(day).toBeFocused();
  await expect(page.getByRole('button', { name: 'Open Keyboard fixture post', exact: true })).toBeVisible();
  expect(audit.blockedMutations).toEqual([]);
});

test('partial publishing-history failures remain visible and retry read-only', async ({ page, audit }) => {
  const withHistory = { ...sample, publishAttempts: [{ id: 9201, platform: 'instagram', status: 'succeeded', attemptCount: 1, maxAttempts: 5, capabilities: { retry: false, reconcile: false, publishNow: false } }] };
  const failed = { ...sample, id: 9102, contentAssetId: 9102, sourceKey: 'asset-9102', title: 'Unavailable history post', publishAttempts: undefined };
  const empty = { ...failed, id: 9103, contentAssetId: 9103, sourceKey: 'asset-9103', title: 'No history post' };
  await openCalendar(page, [withHistory, failed, empty]);
  let fail = true;
  await page.route('**/api/content/assets/*/publish-attempts', route => {
    if (route.request().url().includes('/9102/') && fail) return route.fulfill({ status: 503, json: { error: 'Synthetic history read unavailable.' } });
    return route.fulfill({ json: { attempts: [] } });
  });
  await page.getByRole('button', { name: 'Open Keyboard fixture post', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Delivery history (1)');
  await expect(page.locator('#calendar-asset-9102')).toContainText('Publishing history unavailable');
  await expect(page.locator('#calendar-asset-9103')).toContainText('No publishing history yet.');
  fail = false;
  await page.locator('#calendar-asset-9102').getByRole('button', { name: 'Retry publishing history', exact: true }).click();
  await expect(page.locator('#calendar-asset-9102')).toContainText('No publishing history yet.');
  await expect(drawer).toContainText('Delivery history (1)');
  expect(audit.blockedMutations).toEqual([]);
});

test('deferred refresh keeps the exact control and respects newer focus', async ({ page, audit }) => {
  await page.setViewportSize({ width: 1180, height: 757 });
  await openCalendar(page);
  const pending: Route[] = [];
  await page.route('**/api/content/calendar?*', route => { pending.push(route); });
  const next = navigation(page);
  const original = await next.elementHandle();
  await next.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => pending.length).toBe(1);
  await expect(next).toBeFocused();
  await pending.shift()!.fulfill({ json: { items: [] } });
  await expect(page.getByRole('button', { name: 'View content for November 1, 2026', exact: true })).toBeVisible();
  await expect(next).toBeFocused();
  expect(await next.evaluate((node, previous) => node === previous, original!)).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(() => pending.length).toBe(1);
  // A newer keyboard focus action must win over the outstanding refresh.
  await page.keyboard.press('Tab');
  const selection = page.getByRole('button', { name: 'Select scheduled posts', exact: true });
  await expect(selection).toBeFocused();
  await pending.shift()!.fulfill({ json: { items: [] } });
  await expect(page.getByRole('button', { name: 'View content for December 1, 2026', exact: true })).toBeVisible();
  await expect(selection).toBeFocused();
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test('newer month and view requests win over older deferred responses', async ({ page, audit }) => {
  await openCalendar(page);
  const pending: Route[] = [];
  await page.route('**/api/content/calendar?*', route => { pending.push(route); });
  await navigation(page).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => pending.length).toBe(1);
  const november = pending.shift()!;
  await page.keyboard.press('Enter');
  await expect.poll(() => pending.length).toBe(1);
  const december = pending.shift()!;
  expect(new URL(december.request().url()).searchParams.get('startDate')).toBe('2026-12-01');
  await december.fulfill({ json: { items: [{ ...sample, title: 'Newest month post', scheduled_date: '2026-12-01' }] } });
  await expect(page.getByRole('button', { name: 'Open Newest month post', exact: true })).toBeVisible();
  await november.fulfill({ json: { items: [{ ...sample, title: 'Stale month post', scheduled_date: '2026-11-01' }] } });
  await expect(dateLabel(page)).toHaveText('December, 2026');
  await expect(page.getByRole('button', { name: 'Open Stale month post' })).toHaveCount(0);
  await expect(navigation(page)).toBeFocused();
  await navigation(page, 'Previous').click();
  await expect.poll(() => pending.length).toBe(1);
  const oldMonth = pending.shift()!;
  await page.getByRole('button', { name: 'Weekly', exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  const week = pending.shift()!;
  expect(new URL(week.request().url()).searchParams.get('startDate')).toBe('2026-11-01');
  expect(new URL(week.request().url()).searchParams.get('endDate')).toBe('2026-11-07');
  await week.fulfill({ json: { items: [] } });
  await expect(page.getByRole('button', { name: 'View content for November 7, 2026', exact: true })).toBeVisible();
  await oldMonth.fulfill({ json: { items: [{ ...sample, title: 'Stale view post', scheduled_date: '2026-11-01' }] } });
  await expect(page.getByRole('button', { name: 'Open Stale view post' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Weekly', exact: true })).toBeFocused();
  expect(audit.blockedMutations).toEqual([]);
});

test('route departure during a deferred load cannot restore calendar focus', async ({ page, audit }) => {
  await openCalendar(page);
  const pending: Route[] = [];
  await page.route('**/api/content/calendar?*', route => { pending.push(route); });
  await navigation(page).click();
  await expect.poll(() => pending.length).toBe(1);
  await page.getByRole('button', { name: 'Create Post', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/saved-templates\/social\/generate$/, { timeout: 30000 });
  await pending.shift()!.fulfill({ json: { items: [] } }).catch(() => {});
  await expect(navigation(page)).toHaveCount(0);
  expect(audit.blockedMutations).toEqual([]);
});

test('refresh failure retains navigation focus and allows read-only recovery', async ({ page, audit }) => {
  await openCalendar(page);
  let fail = true;
  await page.route('**/api/content/calendar?*', route => fail
    ? route.fulfill({ status: 503, json: { error: 'Synthetic calendar read failure.' } })
    : route.fulfill({ json: { items: [] } }));
  await navigation(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'We couldn’t load the content calendar' })).toBeVisible();
  await expect(navigation(page)).toBeFocused();
  fail = false;
  await navigation(page, 'Previous').focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'View content for October 1, 2026', exact: true })).toBeVisible();
  await expect(navigation(page, 'Previous')).toBeFocused();
  expect(audit.blockedMutations).toEqual([]);
});

test('month, week, leap-year and timezone boundaries retain date ranges and focus', async ({ page, audit }) => {
  await page.clock.setFixedTime(new Date('2026-12-31T23:30:00Z'));
  await page.route('**/api/settings/preferences', route => route.fulfill({ json: { timezone: 'Asia/Kolkata', theme: 'light' } }));
  const ranges: Record<string, string>[] = [];
  await page.route('**/api/content/calendar?*', route => {
    ranges.push(Object.fromEntries(new URL(route.request().url()).searchParams));
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/dashboard/content-calendar');
  await expect(dateLabel(page)).toHaveText('January, 2027');
  await expect(page.getByRole('button', { name: 'View content for January 1, 2027', exact: true })).toBeVisible();
  expect(ranges.at(-1)).toEqual({ startDate: '2027-01-01', endDate: '2027-01-31', timezone: 'Asia/Kolkata' });
  await navigation(page, 'Previous').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'View content for December 31, 2026', exact: true })).toBeVisible();
  await expect(navigation(page, 'Previous')).toBeFocused();
  expect(ranges.at(-1)).toEqual({ startDate: '2026-12-01', endDate: '2026-12-31', timezone: 'Asia/Kolkata' });
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: 'Weekly', exact: true }).click();
  await expect(dateLabel(page, 'week')).toHaveText('Week of December 27, 2026');
  await expect(page.getByRole('button', { name: 'View content for January 2, 2027', exact: true })).toBeVisible();
  expect(ranges.at(-1)).toEqual({ startDate: '2026-12-27', endDate: '2027-01-02', timezone: 'Asia/Kolkata' });
  await navigation(page, 'Next', 'week').focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'View content for January 9, 2027', exact: true })).toBeVisible();
  await expect(navigation(page, 'Next', 'week')).toBeFocused();
  expect(ranges.at(-1)).toEqual({ startDate: '2027-01-03', endDate: '2027-01-09', timezone: 'Asia/Kolkata' });
  await page.clock.setFixedTime(new Date('2028-02-29T12:00:00Z'));
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: 'Monthly', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View content for February 29, 2028', exact: true })).toBeVisible();
  expect(ranges.at(-1)).toEqual({ startDate: '2028-02-01', endDate: '2028-02-29', timezone: 'Asia/Kolkata' });
  await navigation(page).click();
  await expect(page.getByRole('button', { name: 'View content for March 31, 2028', exact: true })).toBeVisible();
  expect(ranges.at(-1)).toEqual({ startDate: '2028-03-01', endDate: '2028-03-31', timezone: 'Asia/Kolkata' });
  expect(audit.blockedMutations).toEqual([]);
});

for (const viewport of [
  { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 },
  { width: 1180, height: 757 }, { width: 1440, height: 900 }, { width: 2560, height: 1440 },
]) {
  test(`normal-zoom keyboard controls and drawer at ${viewport.width}x${viewport.height}`, async ({ page, audit }, testInfo) => {
    await page.setViewportSize(viewport);
    await openCalendar(page, [sample]);
    expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, zoom: getComputedStyle(document.documentElement).zoom, scale: visualViewport?.scale }))).toEqual({ ...viewport, zoom: '1', scale: 1 });
    await navigation(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'View content for November 1, 2026', exact: true })).toBeVisible();
    await expect(navigation(page)).toBeFocused();
    await navigation(page, 'Previous').focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Open Keyboard fixture post', exact: true })).toBeVisible();
    await expect(navigation(page, 'Previous')).toBeFocused();
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await page.getByRole('button', { name: 'Weekly', exact: true }).click();
    const day = page.getByRole('button', { name: 'View content for October 11, 2026', exact: true });
    await expect(day).toHaveJSProperty('tagName', 'BUTTON');
    await page.getByRole('button', { name: 'Monthly', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Weekly calendar. Scroll horizontally to view all days.', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(day).toBeFocused();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText(sample.title);
    // Let the existing slide transition finish before measuring or capturing.
    await expect.poll(() => drawer.evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(viewport.width + 1);
    const bounds = await drawer.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`calendar-keyboard-${viewport.width}x${viewport.height}.png`) });
    await page.keyboard.press('Escape');
    await expect(day).toBeFocused();
    expect(audit.blockedMutations).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
  });
}
