import type { Locator, Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

async function readsOnly(page: Page, theme: string) {
  const writes: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'Local read-only fixture.' } });
    }
    if (path === '/api/settings/preferences') return route.fulfill({ json: { theme, language: 'en', timezone: 'UTC' } });
    if (path === '/api/settings/outreach/assistants/catalog') return route.fulfill({ json: {
      runtimeEnabled: false, presets: [], accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [],
      permissions: { canManage: false, description: 'Read-only theme fixture.' },
    } });
    if (/^\/api\/(auth|platform|organizations|wallet|chat|notifications|crm)/.test(path) || path === '/api/settings/business-profiles') return route.fallback();
    if (path === '/api/dashboard/stats') return route.fulfill({ json: { totalLeads: 0, newLeads: 0, activeCampaigns: 0, completedCampaigns: 0, totalSpent: 0, totalBudget: 0, messagesSent: 0, conversionRate: '0' } });
    if (path === '/api/suggestions') return route.fulfill({ json: { success: true, suggestions: [] } });
    return route.fulfill({ json: [] });
  });
  return writes;
}

async function zIndex(node: Locator) {
  return node.evaluate(element => Number(getComputedStyle(element).zIndex));
}

async function above(floating: Locator, owner: Locator) {
  await expect(floating).toBeVisible();
  const floatingLayer = await zIndex(floating), ownerLayer = await zIndex(owner);
  expect(floatingLayer).toBeGreaterThan(ownerLayer);
  const box = await floating.boundingBox();
  expect(box).not.toBeNull();
  expect(await floating.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 })).toBe(true);
  await test.info().attach('painted-floating-layer', { contentType: 'application/json', body: JSON.stringify({
    ownerLayer, floatingLayer, bounds: box, paintedAtCenter: true,
    surface: await floating.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, foreground: getComputedStyle(element).color })),
  }) });
  if (await floating.getAttribute('role') === 'listbox') {
    const name = (await owner.locator('h2').first().innerText()).replace(/\W+/g, '-');
    await floating.page().screenshot({ path: test.info().outputPath(`open-select-${name}.png`), animations: 'disabled', style: 'nextjs-portal{display:none}' });
  }
}

for (const theme of ['light', 'dark']) test(`finder caption and Escape badge fit narrow viewports in ${theme}`, async ({ page, audit }, info) => {
  const writes = await readsOnly(page, theme);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/dashboard/home');
  const opener = page.getByRole('button', { name: 'Find a page in Regression Company', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Search AskSales.AI', exact: true });
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 820, height: 1180 }]) {
    await page.setViewportSize(viewport);
    await opener.click(); await expect(dialog).toBeVisible();
    const caption = dialog.getByText('Pages in Regression Company', { exact: true });
    const close = dialog.getByRole('button', { name: 'Close search', exact: true });
    const badge = close.locator('kbd');
    const metrics = await caption.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, height: node.clientHeight, scrollHeight: node.scrollHeight }));
    const badgeMetrics = await badge.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, height: node.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight) }));
    await info.attach(`finder-header-${viewport.width}`, { contentType: 'application/json', body: JSON.stringify({ viewport, caption: metrics, badge: badgeMetrics, dialog: await dialog.boundingBox(), close: await close.boundingBox() }) });
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.height + 1);
    expect(badgeMetrics.scrollWidth).toBeLessThanOrEqual(badgeMetrics.width + 1);
    expect(badgeMetrics.height).toBeLessThanOrEqual(badgeMetrics.lineHeight + 8);
    await expect(caption).toHaveAttribute('aria-label', 'Pages in Regression Company');
    await expect(caption).toHaveAttribute('title', 'Pages in Regression Company');
    await expect(close).toBeInViewport({ ratio: 1 });
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await dialog.boundingBox())!.y + (await dialog.boundingBox())!.height).toBeLessThanOrEqual(viewport.height - 8);
    await expectNoHorizontalOverflow(page);
    await dialog.screenshot({ path: info.outputPath(`${theme}-finder-header-${viewport.width}.png`), animations: 'disabled', style: 'nextjs-portal{display:none}' });
    await close.focus(); await page.keyboard.press('Space');
    await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
    await expect(page).toHaveURL(/\/dashboard\/home$/);
  }
  expect(writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});

for (const theme of ['light', 'dark']) test(`finder theme, chrome layers, scope and keyboard in ${theme}`, async ({ page, audit }, info) => {
  const writes = await readsOnly(page, theme);
  await page.emulateMedia({ reducedMotion: theme === 'dark' ? 'reduce' : 'no-preference' });
  await page.goto('/dashboard/home');
  await expect(page.locator('html')).toHaveClass(new RegExp(theme));
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  const opener = page.getByRole('button', { name: 'Find a page in Regression Company', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Search AskSales.AI', exact: true });
  const input = page.getByRole('combobox', { name: 'Search pages, actions, and settings' });
  if ((page.viewportSize()?.width || 0) < 1024) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  const chooserOpener = page.getByRole('button', { name: /Switch business profile\. Current:/ });
  await chooserOpener.click();
  const chooser = page.getByRole('dialog', { name: 'Choose a business profile' });
  await expect(chooser).toBeVisible();
  expect(await zIndex(chooser)).toBeGreaterThan(await zIndex(page.locator('aside[aria-label="Dashboard navigation"]')));
  await page.keyboard.press('Escape'); await expect(chooser).toBeHidden(); await expect(chooserOpener).toBeFocused();
  if ((page.viewportSize()?.width || 0) < 1024) await page.getByRole('dialog', { name: 'Dashboard navigation' }).getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  for (let cycle = 0; cycle < 3; cycle++) {
    if (cycle === 1) {
      if ((page.viewportSize()?.width || 0) >= 1024) await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
      else {
        await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
        await page.keyboard.press('ControlOrMeta+k');
      }
    }
    if (cycle !== 1 || (page.viewportSize()?.width || 0) >= 1024) { await opener.focus(); await opener.press('Enter'); }
    await expect(dialog).toBeVisible(); await expect(input).toBeFocused();
    expect(await zIndex(dialog)).toBeGreaterThan(await zIndex(page.locator('aside[aria-label="Dashboard navigation"]')));
    expect(await zIndex(dialog)).toBeGreaterThan(await zIndex(page.getByTestId('header')));
    const color = await dialog.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(color).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(13, 19, 33)');
    await input.fill('no-such-page-fixture'); await expect(dialog.getByText('No results found')).toBeVisible();
    await input.fill(''); await expect(input).toBeFocused();
    const first = await dialog.locator('[cmdk-item][data-selected="true"]').getAttribute('id');
    await input.press('ArrowDown');
    expect(await dialog.locator('[cmdk-item][data-selected="true"]').getAttribute('id')).not.toBe(first);
    for (let tab = 0; tab < 5; tab++) {
      await page.keyboard.press(tab % 2 ? 'Shift+Tab' : 'Tab');
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`${theme}-finder-cycle-${cycle}.png`), animations: 'disabled', style: 'nextjs-portal{display:none}' });
    if (cycle === 2) { await dialog.getByRole('button', { name: 'Close search' }).focus(); await page.keyboard.press('Enter'); }
    else await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
    await expect(page).toHaveURL(/\/dashboard\/home$/);
    if (cycle === 1 && (page.viewportSize()?.width || 0) < 1024) {
      await page.getByRole('dialog', { name: 'Dashboard navigation' }).getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    }
  }
  await opener.click(); await expect(dialog).toBeVisible();
  await page.mouse.click((page.viewportSize()?.width || 0) - 3, 3);
  await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
  await opener.click(); await dialog.getByRole('button', { name: 'Close search' }).focus(); await page.keyboard.press('Space');
  await expect(dialog).toBeHidden(); await expect(opener).toBeFocused(); await expect(page).toHaveURL(/\/dashboard\/home$/);
  await opener.click(); await input.fill('Enrichment'); await input.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/enrichment$/);
  await expect(page.getByRole('main')).toHaveCount(1);
  await page.goBack(); await expect(page).toHaveURL(/\/dashboard\/home$/);
  expect(writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});

for (const theme of ['light', 'dark']) test(`owned body portals, nested modals and clipped controls in ${theme}`, async ({ page, audit }, info) => {
  test.skip(process.env.E2E_LAYER_HARNESS !== '1', 'Requires the documented disposable local fixture route.');
  const writes = await readsOnly(page, theme);
  await page.goto('/qa-theme-layers'); await expect(page.locator('html')).toHaveClass(new RegExp(theme));
  const rootPopup = page.locator('[data-ui-layer="floating"]:visible');
  await page.getByRole('button', { name: 'Fixture popover', exact: true }).click();
  expect(await zIndex(rootPopup)).toBeLessThan(50); await page.keyboard.press('Escape');
  for (const kind of ['dialog', 'sheet', 'drawer']) {
    const trigger = page.getByRole('button', { name: `Fixture ${kind}`, exact: true });
    await trigger.click();
    // Radix hides the parent from assistive technology while a modal select or
    // menu is open. Its painted surface still owns the floating layer.
    const owner = page.getByRole('dialog', { name: kind === 'dialog' ? 'Outer fixture dialog' : `Fixture ${kind}`, exact: true, includeHidden: true });
    await expect(owner).toBeVisible();
    await owner.getByRole('combobox', { name: 'Fixture choice' }).click();
    await above(page.getByRole('listbox'), owner);
    await page.getByRole('option', { name: 'Second choice' }).click();
    await expect(owner.getByRole('combobox', { name: 'Fixture choice' })).toBeFocused();
    await owner.getByRole('button', { name: 'Fixture popover', exact: true }).click();
    const popover = page.locator('[data-ui-layer="floating"]:visible').filter({ has: page.getByRole('textbox', { name: 'Popover input' }) });
    await above(popover, owner); await expect(page.getByRole('textbox', { name: 'Popover input' })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(owner.getByRole('button', { name: 'Fixture popover', exact: true })).toBeFocused();
    await owner.getByRole('button', { name: 'Fixture menu', exact: true }).click(); await above(page.getByRole('menu'), owner);
    await page.getByRole('menuitem', { name: 'More choices' }).hover();
    await above(page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Nested choice' }) }), owner);
    await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0); await expect(owner).toBeVisible();
    await owner.getByRole('button', { name: 'Fixture tooltip', exact: true }).hover(); await above(page.getByRole('tooltip').locator('xpath=..'), owner);
    await page.mouse.move(1, 1);
    await owner.getByRole('link', { name: 'Fixture hover card' }).hover();
    await above(page.locator('[data-ui-layer="floating"]').filter({ hasText: 'Unclipped hover card' }), owner); await page.mouse.move(1, 1);
    await owner.getByText('Fixture context menu', { exact: true }).click({ button: 'right' }); await above(page.getByRole('menu'), owner); await page.keyboard.press('Escape');
    await owner.getByRole('menuitem', { name: 'Fixture menubar' }).click(); await above(page.getByRole('menu'), owner); await page.keyboard.press('Escape');
    if (kind === 'dialog') {
      const nested = owner.getByRole('button', { name: 'Nested fixture dialog', exact: true }); await nested.click();
      const inner = page.getByRole('dialog', { name: 'Inner fixture dialog', exact: true, includeHidden: true }); await expect(inner).toBeVisible();
      expect(await zIndex(inner)).toBeGreaterThan(await zIndex(owner) + 10);
      await inner.getByRole('combobox').click(); await above(page.getByRole('listbox'), inner); await page.keyboard.press('Escape');
      await page.keyboard.press('Escape'); await expect(inner).toBeHidden(); await expect(nested).toBeFocused();
      await owner.getByRole('button', { name: 'Nested fixture alert', exact: true }).click();
      const alert = page.getByRole('alertdialog'); await expect(alert).toBeVisible(); expect(await zIndex(alert)).toBeGreaterThan(await zIndex(owner));
      await alert.getByRole('button', { name: 'Cancel fixture alert' }).click();
      await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
      await expect(owner.getByRole('button', { name: 'Nested fixture alert', exact: true })).toBeFocused();
    }
    await page.mouse.move(1, 1);
    await expect(page.locator('[data-ui-layer="floating"]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${theme}-${kind}.png`), animations: 'disabled', style: 'nextjs-portal{display:none}' });
    await page.keyboard.press('Escape'); await expect(owner).toBeHidden(); await expect(trigger).toBeFocused();
  }
  expect(writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});
