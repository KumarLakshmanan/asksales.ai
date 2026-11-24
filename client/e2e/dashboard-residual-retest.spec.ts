import { type Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { roomRecords, roomTargets } from './fixtures/icon-actions';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });
const property = { id: 12, name: 'Synthetic Hotel', currency: 'USD', timezone: 'UTC' };
const templates = [51, 52].map(id => ({ id, name: 'Duplicate sample', userId: null, templateType: 'document', templateContent: { sections: [], requiredFields: [] } }));

async function fixtures(page: Page) {
  const state = { writes: [] as string[], empty: false, populated: false, pending: 0, currency: 'USD' as string | undefined };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) {
      state.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'Synthetic fixture forbids writes.' } });
    }
    if (/^\/api\/(auth|platform|organizations|wallet|chat|notifications|crm)/.test(path) || ['/api/settings/preferences', '/api/settings/business-profiles'].includes(path)) return route.fallback();
    let body: unknown = [];
    const savedRun = { id: 772, userId: 4101, leadName: 'Synthetic saved enrichment', status: 'completed', createdAt: '2026-10-01T00:00:00Z', summary: {}, steps: [] };
    if (path === '/api/enrichments') body = state.populated ? [savedRun] : [];
    if (path === '/api/enrichments/772') body = savedRun;
    if (path === '/api/hotel/property') body = { property: { ...property, currency: state.currency } };
    if (path === '/api/hotel/summary') body = { totalRoomTypes: state.empty ? 0 : roomRecords.length, totalBookings: 0, confirmedBookings: 0, revenueByCurrency: {} };
    if (path === '/api/hotel/room-types') body = { roomTypes: state.empty ? [] : roomRecords };
    if (path === '/api/hotel/bookings') body = { bookings: [] };
    if (path === '/api/proposals/templates') body = templates;
    if (path === '/api/support/teams/capacity-settings') body = { handlingMinutesPerTicket: 5, socialFallbackSlaMinutes: 30, emailFallbackSlaMinutes: 240 };
    if (path === '/api/support/notification-settings') body = { email: { enabled: false, subject: 'Sample', text: 'Sample', providerState: 'unconfigured' }, whatsapp: { enabled: false, templates: [], providerState: 'unconfigured' }, recipients: [] };
    if (path === '/api/support/notification-health') body = null;
    if (path === '/api/support/ai/orchestration-report') body = { readiness: {} };
    state.pending++;
    await new Promise(resolve => setTimeout(resolve, 200));
    try { await route.fulfill({ json: body }); } finally { state.pending--; }
  });
  return state;
}

async function oneMain(page: Page) {
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.locator('main main, main [role="main"]')).toHaveCount(0);
  await expect(page.locator('#main-content')).toHaveCount(1);
  const accessible = await page.locator('body').ariaSnapshot();
  expect(accessible.match(/^\s*- main(?:[:\s]|$)/gm)).toHaveLength(1);
  const session = await page.context().newCDPSession(page);
  const current = await session.send('Accessibility.getFullAXTree');
  await session.detach();
  expect(current.nodes.filter(node => !node.ignored && node.role?.value === 'main')).toHaveLength(1);
  await expectNoHorizontalOverflow(page);
}

for (const [path, heading] of [
  ['/dashboard/enrichment', 'Lead Enrichment'],
  ['/dashboard/support/notifications', 'Support notifications'],
]) test(`AS015 residual loading, settled and history: ${path}`, async ({ page, audit }, info) => {
  const state = await fixtures(page);
  await page.goto(path);
  await expect(page.locator('#main-content')).toBeVisible();
  await oneMain(page);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect.poll(() => state.pending).toBe(0);
  await oneMain(page);
  await page.screenshot({ path: info.outputPath('settled.png'), fullPage: true });
  if (path === '/dashboard/enrichment') {
    await expect(page.getByText('No enrichment history yet', { exact: true })).toBeVisible();
    state.populated = true; await page.reload();
    await page.getByRole('button', { name: /Synthetic saved enrichment/ }).click();
    await expect.poll(() => state.pending).toBe(0);
    await expect(page.locator('#main-content .animate-spin:visible')).toHaveCount(0);
    await oneMain(page);
    await page.screenshot({ path: info.outputPath('populated.png'), fullPage: true });
  }
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await skip.focus(); await skip.press('Enter'); await page.keyboard.press('Tab');
  expect(await page.locator('#main-content').evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.goto('/dashboard/support/teams');
  await expect(page.getByRole('heading', { name: 'Support teams', exact: true })).toBeVisible();
  await page.goBack(); await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible(); await oneMain(page);
  await page.goForward(); await expect(page.getByRole('heading', { name: 'Support teams', exact: true })).toBeVisible();
  await page.goBack(); await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible(); await oneMain(page);
  expect(state.writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});

test('AS025 deliberate inline names, unique IDs, numeric constraints and selection/cancel continuity', async ({ page, audit }, info) => {
  const state = await fixtures(page);
  await page.goto('/dashboard/hotel');
  const all = page.getByRole('checkbox', { name: 'Select all visible room types (5)', exact: true });
  await expect(all).toBeVisible(); await all.focus(); await all.press('Space');
  for (const target of roomTargets) await expect(page.getByRole('checkbox', { name: `Select room type ${target}`, exact: true })).toBeChecked();
  await all.press('Space');
  for (const target of roomTargets) {
    const opener = page.getByRole('button', { name: `Edit room type ${target}`, exact: true });
    await opener.focus(); await opener.press('Enter');
    const name = page.getByRole('textbox', { name: `Room name for ${target}`, exact: true });
    await expect(name).toBeFocused();
    await expect(page.getByRole('spinbutton', { name: `Capacity (guests per room) for ${target}`, exact: true })).toHaveAttribute('min', '1');
    const price = page.getByRole('spinbutton', { name: `Base price (USD) per night for ${target}`, exact: true });
    await expect(price).toHaveAttribute('min', '0.01'); await expect(price).toHaveAttribute('step', '0.01');
    const discount = page.getByRole('spinbutton', { name: `Maximum discount (percent) for ${target}`, exact: true });
    await expect(discount).toHaveAttribute('min', '0'); await expect(discount).toHaveAttribute('max', '100');
    await name.fill('Unsaved draft');
    const cancel = page.getByRole('button', { name: `Cancel editing room type ${target}`, exact: true });
    await cancel.focus(); await cancel.press('Enter'); await expect(opener).toBeFocused();
  }
  const ids = await page.locator('#main-content [id]').evaluateAll(nodes => nodes.map(node => node.id));
  expect(new Set(ids).size).toBe(ids.length);
  await page.screenshot({ path: info.outputPath('rooms.png'), fullPage: true });
  await expectNoHorizontalOverflow(page); expect(state.writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});

test('AS026 both zero-booking summaries use property currency, with explicit missing provenance', async ({ page, audit }, info) => {
  const state = await fixtures(page);
  await page.goto('/dashboard/hotel?tab=bookings');
  await expect(page.getByText('$0.00', { exact: true })).toHaveCount(2);
  await expect(page.getByText('₹0.00', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('usd-zero.png'), fullPage: true });
  state.currency = 'INR'; await page.reload(); await expect(page.getByText('₹0.00', { exact: true })).toHaveCount(2);
  state.currency = undefined; await page.reload(); await expect(page.getByText('0.00 (currency unknown)', { exact: true })).toHaveCount(2);
  expect(state.writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});

test('AS027 duplicate proposal openers restore exact node after Escape/keyboard Close and removal', async ({ page, audit }) => {
  const state = await fixtures(page);
  await page.goto('/dashboard/proposals/templates');
  const openers = page.getByRole('button', { name: 'Customer preview of Duplicate sample', exact: true });
  await expect(openers).toHaveCount(2);
  for (const index of [1, 0, 1]) for (const dismissal of ['escape', 'close']) {
    const opener = openers.nth(index); await opener.focus(); await opener.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Duplicate sample', exact: true });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Shift+Tab'); expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
    if (dismissal === 'escape') await page.keyboard.press('Escape');
    else { const close = dialog.getByRole('button', { name: 'Close', exact: true }); await close.focus(); await close.press('Enter'); }
    await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  }
  const removed = await openers.nth(1).elementHandle();
  await openers.nth(1).click();
  await removed!.evaluate(node => node.remove());
  await page.keyboard.press('Escape'); await expect(page.getByRole('textbox', { name: 'Search templates', exact: true })).toBeFocused();
  expect(state.writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});

test('AS027 both team openers restore after Escape/keyboard Cancel, without submission', async ({ page, audit }) => {
  const state = await fixtures(page);
  await page.goto('/dashboard/support/teams');
  for (const label of ['Add team', 'Create team', 'Add team']) for (const dismissal of ['escape', 'cancel']) {
    const opener = page.getByRole('button', { name: label, exact: true }); await opener.focus(); await opener.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Create Team', exact: true });
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole('textbox', { name: 'Team name *', exact: true })).toBeFocused();
    if (dismissal === 'escape') await page.keyboard.press('Escape');
    else { const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true }); await cancel.focus(); await cancel.press('Enter'); }
    await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  }
  expect(state.writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});

test('app bar shows business scope when sidebar selector is unavailable', async ({ page, audit }) => {
  const state = await fixtures(page);
  await page.goto('/dashboard/support/teams');
  const context = page.getByLabel('Current workspace: Regression Company', { exact: true });
  if (page.viewportSize()!.width >= 1024) {
    await expect(context).toBeHidden(); await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    await expect(context).toBeVisible(); await page.getByRole('button', { name: 'Show sidebar', exact: true }).click(); await expect(context).toBeHidden();
  } else await expect(context).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find a page in Regression Company', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page); expect(state.writes).toEqual([]); expect(audit.consoleErrors).toEqual([]);
});
