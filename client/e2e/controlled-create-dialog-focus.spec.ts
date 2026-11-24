import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }, actionTimeout: 15_000 });
test.setTimeout(60_000);

async function isolateWorkspace(page: Page, pathname: string, openerName: string) {
  const mutations: string[] = [];
  const shellReads = ['/api/auth/me', '/api/platform/access', '/api/settings/preferences',
    '/api/settings/business-profiles', '/api/settings/outreach/assistants/catalog', '/api/wallet', '/api/notifications/unread/count'];
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
      mutations.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Dialog-focus fixture blocks all writes.' } });
    }
    if (shellReads.includes(url.pathname)) return route.fallback();
    if (url.pathname === '/api/leads') return route.fulfill({ json: { data: [], total: 0, totalPages: 0, page: 1, pageSize: 15 } });
    if (url.pathname === '/api/leads/stats') return route.fulfill({ json: { success: false } });
    if (url.pathname === '/api/support') return route.fulfill({ json: { tickets: [], total: 0, totalPages: 1 } });
    if (url.pathname === '/api/support/analytics') return route.fulfill({ json: null });
    if (url.pathname === '/api/crm/contacts') return route.fulfill({ json: { contacts: [] } });
    return route.fulfill({ json: [] });
  });
  await page.goto(pathname);
  await expect(page.getByRole('button', { name: openerName, exact: true })).toBeVisible();
  return mutations;
}

async function settleFocus(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const device of [
  { name: '1180×757 desktop', options: { viewport: { width: 1180, height: 757 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 } },
  { name: '390×844 mobile', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75 } },
]) {
  test.describe(device.name, () => {
    test.use(device.options);

    for (const workspace of [
      { name: 'Add Contact', pathname: '/dashboard/leads', title: 'Add Contact', initialLabel: 'First name', blankLabels: ['First name', 'Last name', 'Email', 'Phone', 'Company', 'Job role'], searchLabel: 'Search leads' },
      { name: 'New ticket', pathname: '/dashboard/support', title: 'Create support ticket', initialLabel: 'Subject', blankLabels: ['Subject', 'Description', 'CRM customer'], searchLabel: 'Search support tickets' },
    ]) {
      test(`${workspace.name}: blank dialog returns to the exact opener after repeated Cancel, Escape, Close and backdrop`, async ({ page, audit }) => {
        const mutations = await isolateWorkspace(page, workspace.pathname, workspace.name);
        expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, zoom: visualViewport?.scale })))
          .toEqual({ ...device.options.viewport, zoom: 1 });
        const opener = page.getByRole('button', { name: workspace.name, exact: true });
        const original = await opener.elementHandle();
        const dialog = page.getByRole('dialog', { name: workspace.title });
        for (const method of ['Cancel', 'Cancel', 'Escape', 'Escape', 'Close', 'Close', 'Backdrop', 'Backdrop']) {
          await opener.focus();
          await opener.press('Enter');
          await expect(dialog).toBeVisible();
          await expect(dialog.getByLabel(workspace.initialLabel, { exact: true })).toBeFocused();
          for (const label of workspace.blankLabels) {
            await expect(dialog.getByLabel(label, { exact: true })).toHaveValue('');
          }
          if (workspace.name === 'New ticket') await expect(dialog.getByRole('button', { name: 'Create and open', exact: true })).toBeDisabled();
          if (method === 'Escape') await page.keyboard.press('Escape');
          else if (method === 'Backdrop') await page.mouse.click(5, 5);
          else {
            const close = dialog.getByRole('button', { name: method, exact: true });
            await close.focus();
            await close.press('Enter');
          }
          await expect(dialog).toHaveCount(0);
          await settleFocus(page);
          expect(await page.evaluate(element => document.activeElement === element, original)).toBe(true);
        }
        await expectNoHorizontalOverflow(page);
        if (workspace.name === 'Add Contact') {
          await page.getByRole('button', { name: 'Filter leads' }).click();
          await page.getByLabel('Score range', { exact: true }).selectOption('80-100');
          await expect(page.getByText('No leads match your filters')).toBeVisible();
          await page.getByRole('button', { name: 'Clear Filters' }).click();
          await expect(page.getByLabel('Search leads', { exact: true })).toBeFocused();
        }
        expect(mutations).toEqual([]);
        expect(audit.blockedMutations).toEqual([]);
      });

      test(`${workspace.name}: an interrupted exit and newer dialog or navigation keep their focus`, async ({ page }) => {
        const mutations = await isolateWorkspace(page, workspace.pathname, workspace.name);
        const opener = page.getByRole('button', { name: workspace.name, exact: true });
        const original = await opener.elementHandle();
        if (!original) throw new Error('The workspace opener is missing.');
        const dialog = page.getByRole('dialog', { name: workspace.title });
        await opener.click();
        await expect(dialog.getByLabel(workspace.initialLabel, { exact: true })).toBeFocused();
        // Dispatch both activations in one browser task so the exit animation is interrupted.
        await original.evaluate((opener: HTMLButtonElement) => {
          const content = document.querySelector('[role="dialog"][data-state="open"]')!;
          const cancel = Array.from(content.querySelectorAll('button')).find(button => button.textContent === 'Cancel')!;
          cancel.click();
          setTimeout(() => {
            document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            opener.click();
          }, 0);
        });
        await expect(dialog).toHaveAttribute('data-state', 'open');
        await settleFocus(page);
        await expect(dialog.getByLabel(workspace.initialLabel, { exact: true })).toBeFocused();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
        await expect(dialog).toHaveCount(0);
        await settleFocus(page);
        await expect(opener).toBeFocused();

        await opener.press('Enter');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
        // A keyboard-triggered newer action can start while the retiring portal exists.
        await page.keyboard.press('Control+k');
        const search = page.getByRole('dialog', { name: 'Search AskSales.AI' });
        await expect(search).toBeVisible();
        await expect(dialog).toHaveCount(0);
        await settleFocus(page);
        await expect(search.getByRole('combobox')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(search).toHaveCount(0);

        await opener.click();
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
        const searchInput = page.getByLabel(workspace.searchLabel, { exact: true });
        await searchInput.focus();
        await expect(dialog).toHaveCount(0);
        await settleFocus(page);
        await expect(searchInput).toBeFocused();
        expect(mutations).toEqual([]);
      });
    }
  });
}
