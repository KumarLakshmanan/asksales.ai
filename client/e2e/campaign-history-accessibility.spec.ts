import type { Page, Route, TestInfo } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';
import { campaignRecords, campaignTargets } from './fixtures/icon-actions';

const historyURL = '/dashboard/chats?fixture-query=retained';
const firstTarget = campaignTargets[0];
const firstDestination = '/dashboard/conversations/901';

test.afterEach(async ({ audit }, info) => {
  await info.attach('browser-audit', { body: JSON.stringify(audit), contentType: 'application/json' });
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});

async function expectDestination(page: Page) {
  await expect(page).toHaveURL(new RegExp(`${firstDestination}$`));
  await expect(page.getByText('Read-only destination fixture', { exact: true })).toBeVisible();
}

async function fixtures(page: Page) {
  const state = { writes: [] as string[], reads: [] as { limit: string | null; offset: string | null; workspace: string | null; header: string | undefined }[] };
  // Cover new tabs too. Nothing, including authentication, reaches a backend.
  const rejectWrites = (route: Route) => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) {
      state.writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Campaign History fixture rejects all mutations.' } });
    }
    return route.fulfill({ json: {} });
  };
  await page.context().route('**/api/**', rejectWrites);
  await page.route('**/api/**', rejectWrites);
  await installAppShellMocks(page);
  // Exercise a selected member workspace rather than silently reverting to the default owner.
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101 }));
    sessionStorage.setItem('active-business-profile:4101', '4103');
  });
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [
    { id: 4102, companyName: 'Default owner fixture', isDefault: true, role: 'owner' },
    { id: 4103, companyName: 'Selected member fixture', isDefault: false, role: 'member' },
  ] }));
  await page.route('**/api/chat/threads?*', route => {
    const request = route.request();
    const params = new URL(request.url()).searchParams;
    if (params.has('businessProfileId')) state.reads.push({ limit: params.get('limit'), offset: params.get('offset'),
      workspace: params.get('businessProfileId'), header: request.headers()['x-business-profile-id'] });
    const limit = Number(params.get('limit') || 10);
    const offset = Number(params.get('offset') || 0);
    return route.fulfill({ json: { threads: campaignRecords.slice(offset, offset + limit), total: campaignRecords.length, limit, offset } });
  });
  // Destination identity is verified without mounting the conversation workspace or starting work.
  // HTML also makes Next's client transition fall back to the same document destination.
  const destination = (route: Route) => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic destination</title><p>Read-only destination fixture</p>' });
  const destinationURL = /\/dashboard\/conversations\/\d+(?:[/?]|$)/;
  await page.context().route(destinationURL, destination);
  await page.route(destinationURL, destination);
  return state;
}

async function evidence(page: Page, info: TestInfo, name: string) {
  if (name.startsWith('pagination-')) await page.locator('#main-content [role="combobox"]').scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: visualViewport?.scale,
    zoom: getComputedStyle(document.documentElement).zoom, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.width).toBe(page.viewportSize()!.width);
  expect(dimensions.height).toBe(page.viewportSize()!.height);
  expect(dimensions.scale).toBe(1);
  await info.attach(`${name}-dimensions`, { body: JSON.stringify(dimensions), contentType: 'application/json' });
  await info.attach(`${name}-accessibility`, { body: await page.locator('#main-content').ariaSnapshot(), contentType: 'text/plain' });
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

async function openList(page: Page) {
  await page.goto(historyURL);
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(10);
}

test('List primary entry follows native links and keeps Delete focus and activation isolated', async ({ page, audit, isMobile }, info) => {
  const state = await fixtures(page);
  await openList(page);
  const toggle = page.getByRole('button', { name: 'List view', exact: true });
  const entry = page.getByRole('link', { name: `Open campaign ${firstTarget}`, exact: true });
  const remove = page.getByRole('button', { name: `Delete campaign ${firstTarget}`, exact: true });
  await toggle.focus();
  await page.keyboard.press('Tab');
  await evidence(page, info, 'list-primary-focus');
  await expect(entry).toBeFocused();
  await expect(entry).toHaveAttribute('href', firstDestination);
  await expect(entry).not.toHaveCSS('box-shadow', 'none');
  await expect(page.locator('tbody tr').first()).not.toHaveAttribute('tabindex');
  await expect(page.locator('tbody tr').first()).not.toHaveAttribute('role');
  await expect(page.getByRole('row')).toHaveCount(11);
  await page.keyboard.press('Space'); // A native link scrolls; it must not open or delete.
  await expect(page).toHaveURL(/\/dashboard\/chats\?fixture-query=retained$/);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(remove).toBeFocused();
  await expect(remove).toHaveCSS('opacity', '1');
  const bounds = await remove.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  for (const key of ['Enter', 'Space']) {
    await remove.press(key);
    const dialog = page.getByRole('alertdialog', { name: 'Delete Campaign', exact: true });
    await expect(dialog).toHaveAccessibleDescription(`Are you sure you want to delete ${firstTarget}? This action cannot be undone.`);
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await expect(page).toHaveURL(/\/dashboard\/chats\?fixture-query=retained$/);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
    await expect(remove).toBeFocused();
  }
  await remove.click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(remove).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: `Open campaign ${campaignTargets[1]}`, exact: true })).toBeFocused();
  expect(state.writes).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);

  await entry.focus();
  await entry.press('Enter');
  await expectDestination(page);
  await openList(page);
  await entry.click();
  await expectDestination(page);
  await openList(page);
  await page.locator('tbody tr').first().locator('td').nth(1).click();
  await expectDestination(page);
  await openList(page);
  if (isMobile) {
    await entry.tap();
    await expectDestination(page);
  } else {
    // Chromium can send the navigation while Playwright is still waiting for
    // the background tab to initialize. Observe the request across the context.
    const destinationURL = new URL(firstDestination, page.url()).href;
    const expectNewTabNavigation = async (open: () => Promise<void>) => {
      await page.bringToFront();
      await Promise.all([
        page.context().waitForEvent('request', {
          timeout: 15_000,
          predicate: request => {
            if (!request.isNavigationRequest() || request.url() !== destinationURL) return false;
            try {
              return request.frame().page() !== page;
            } catch {
              // The new tab can send its first request before its frame exists.
              return true;
            }
          },
        }),
        open(),
      ]);
      await expect(page).toHaveURL(/\/dashboard\/chats\?fixture-query=retained$/);
    };
    await test.step('Ctrl-click requests the campaign in a new tab', () =>
      expectNewTabNavigation(() => entry.click({ modifiers: ['Control'] })));
    await test.step('Middle-click requests the campaign in a new tab', () =>
      expectNewTabNavigation(() => entry.click({ button: 'middle' })));
    await entry.click({ button: 'right' });
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/dashboard\/chats\?fixture-query=retained$/);
  }
  await page.goto(firstDestination);
  await expectDestination(page);
  expect(state.writes).toEqual([]);
  expect(state.reads.every(read => read.workspace === '4103' && read.header === '4103')).toBe(true);
});

test('Page size has an associated name in populated and filtered-empty states; pagination preserves scope and query', async ({ page, audit }, info) => {
  const state = await fixtures(page);
  await openList(page);
  const search = page.getByRole('searchbox', { name: 'Filter campaigns on this page', exact: true });
  const size = page.getByRole('combobox', { name: 'Campaigns per page', exact: true });
  await evidence(page, info, 'pagination-populated');
  await expect(size).toBeVisible();
  await search.fill('zz-no-match');
  await expect(page.getByText('No matches on this page', { exact: true })).toBeVisible();
  await evidence(page, info, 'pagination-filtered-empty');
  await expect(size).toBeVisible();
  const sizeId = await size.getAttribute('id');
  const label = page.locator(`label[for="${sizeId}"]`);
  await expect(label).toHaveText('Campaigns per page');
  await label.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(size).toBeFocused();
  await size.press('Space');
  await page.getByRole('option', { name: '5', exact: true }).press('Enter');
  await expect(size).toHaveText('5');
  await expect(search).toHaveValue('zz-no-match');
  await expect(page.getByText('No matches on this page', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'List view', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await search.fill('');
  await expect(page.locator('tbody tr')).toHaveCount(5);
  const pagination = page.getByRole('navigation', { name: 'Campaign history pagination', exact: true });
  await pagination.getByRole('button', { name: 'Next', exact: true }).press('Enter');
  await expect(page.getByText('Showing 6-10 of 11', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: `Open campaign ${campaignTargets[5]}`, exact: true })).toHaveAttribute('href', '/dashboard/conversations/906');
  await pagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Showing 11-11 of 11', { exact: true })).toBeVisible();
  await expect(pagination.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: `Open campaign ${campaignTargets[10]}`, exact: true })).toHaveAttribute('href', '/dashboard/conversations/911');
  if (page.viewportSize()!.width >= 640) {
    await expect(pagination.getByRole('button', { name: 'Page 3', exact: true })).toHaveAttribute('aria-current', 'page');
    await pagination.getByRole('button', { name: 'Page 1', exact: true }).click();
  } else {
    await pagination.getByRole('button', { name: 'Previous', exact: true }).press('Space');
    await pagination.getByRole('button', { name: 'Previous', exact: true }).click();
  }
  await expect(page.getByText('Showing 1-5 of 11', { exact: true })).toBeVisible();
  await size.press('Enter');
  await page.getByRole('option', { name: '10', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(10);
  await expect(page.getByText('Campaigns for Selected member fixture', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/chats\?fixture-query=retained$/);
  expect(state.reads).toContainEqual({ limit: '5', offset: '10', workspace: '4103', header: '4103' });
  expect(state.reads.every(read => read.workspace === '4103' && read.header === '4103')).toBe(true);
  expect(state.writes).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  await info.attach('pagination-fixture-requests', { body: JSON.stringify(state), contentType: 'application/json' });
  await evidence(page, info, 'pagination-recovered');
});

test('Displayed campaign names, underlying titles and ID fallbacks match while Grid controls keep their destinations', async ({ page, audit }, info) => {
  const state = await fixtures(page);
  await openList(page);
  const search = page.getByRole('searchbox', { name: 'Filter campaigns on this page', exact: true });
  const initialReads = [...state.reads];
  await search.fill('very long full title');
  await evidence(page, info, 'different-icp-name-search');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('link', { name: `Open campaign ${firstTarget}`, exact: true })).toBeVisible();
  await search.fill('Underlying thread title');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await search.fill('campaign 904');
  await expect(page.getByRole('link', { name: 'Open campaign Campaign 904', exact: true })).toBeVisible();
  await search.fill('campaign 901');
  await expect(page.getByRole('link', { name: `Open campaign ${firstTarget}`, exact: true })).toBeVisible();
  await search.fill('Duplicate synthetic campaign');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  for (let attempt = 0; attempt < 2; attempt++) {
    await search.fill('zz-no-match');
    await expect(page.getByText('No matches on this page', { exact: true })).toBeVisible();
    await search.fill('');
    await expect(page.locator('tbody tr')).toHaveCount(10);
  }
  await search.fill('Underlying thread title');
  await page.getByRole('button', { name: 'Grid view', exact: true }).press('Space');
  await expect(search).toHaveValue('Underlying thread title');
  await expect(page.getByRole('button', { name: 'View Details', exact: true })).toHaveCount(1);
  await evidence(page, info, 'grid-filter-retained');
  expect(state.reads).toEqual(initialReads);
  await page.getByRole('button', { name: 'View Details', exact: true }).press('Enter');
  await expectDestination(page);
  await page.goto(historyURL);
  await search.fill('Underlying thread title');
  await page.getByRole('button', { name: 'Open Chat', exact: true }).press('Space');
  await expectDestination(page);
  expect(state.writes).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});
