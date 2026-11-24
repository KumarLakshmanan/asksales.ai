import { test, expect } from './fixtures/app';
import { fixtures, lead } from './fixtures/ui-navigation';
import type { Page } from '@playwright/test';
import path from 'node:path';

const screenshotRoot = path.resolve(process.env.UI_FIX_SCREENSHOTS || 'qa/ui-fixes-2026-10-23/screenshots');
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = []; pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });
async function capture(page: Page, name: string) {
  await page.screenshot({ path: path.join(screenshotRoot, name + '.png'), fullPage: true, animations: 'disabled', style: 'nextjs-portal{display:none!important}' });
}

test('UX-01: dirty settings survive rejected link, search and repeated Forward; confirmed discard leaves', async ({ page }) => {
  await fixtures(page); await page.goto('/dashboard/settings/leads');
  const settings = page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).getByRole('link', { name: 'Settings', exact: true });
  await settings.click(); await expect(page).toHaveURL(/\/settings$/);
  await page.goBack();
  const source = page.getByRole('checkbox', { name: 'Select LinkedIn as a fallback source' });
  await source.uncheck(); await expect(page.getByText(/Unsaved changes/)).toBeVisible();
  let allow = false; const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); if (allow) await dialog.accept(); else await dialog.dismiss(); });
  await settings.click(); await expect.poll(() => dialogs.length).toBe(1); await expect(source).not.toBeChecked();
  await page.getByRole('button', { name: /Find a page in/ }).click();
  await page.getByRole('combobox', { name: 'Search pages, actions, and settings' }).fill('Dashboard');
  await page.getByRole('option', { name: 'Dashboard — Overview', exact: true }).click();
  await expect.poll(() => dialogs.length).toBe(2);
  await expect(page).toHaveURL(/\/settings\/leads$/);
  await page.keyboard.press('Escape');
  await expect(source).not.toBeChecked();
  for (let count = 3; count <= 4; count++) {
    await page.evaluate(() => history.forward());
    await expect.poll(() => dialogs.length).toBe(count);
    await expect(page).toHaveURL(/\/settings\/leads$/);
    await expect(source).not.toBeChecked();
  }
  await capture(page, 'dirty-settings-canceled-forward');
  allow = true; await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(/\/settings$/);
  await page.goBack(); await expect(source).toBeChecked();
});

for (const shell of ['support', 'admin'] as const) {
  test(`UX-02: ${shell} responsive navigation supports desktop links and mobile keyboard focus`, async ({ page }) => {
    await fixtures(page); await page.goto(shell === 'support' ? '/support/tickets' : '/admin/dashboard/users');
    const opener = page.getByRole('button', { name: `Open ${shell} navigation` });
    const title = shell === 'support' ? 'Support navigation' : 'Admin navigation';
    const sidebar = page.getByRole('complementary', { name: title, exact: true });
    const viewport = page.viewportSize()!;
    const screenshotPrefix = `${shell}-${test.info().project.name}`;
    const expectDesktopNavigation = async () => {
      await expect(opener).toBeHidden();
      await expect(page.getByRole('dialog')).toBeHidden();
      await expect(sidebar).toBeVisible();
      const firstLink = sidebar.getByRole('link').first();
      await firstLink.focus(); await expect(firstLink).toBeFocused();
      await page.keyboard.press('Tab');
      expect(await sidebar.evaluate(element => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Shift+Tab'); await expect(firstLink).toBeFocused();
    };
    expect(await page.evaluate(() => innerWidth)).toBe(viewport.width);
    if (viewport.width >= 1024) {
      await expectDesktopNavigation();
      await capture(page, `${screenshotPrefix}-desktop-navigation`);
    }
    // Both projects exercise the mobile contract at an actual CSS viewport.
    // Desktop Chrome starts at 1440px, where the drawer trigger is correctly hidden.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => innerWidth)).toBe(390);
    await expect(opener).toBeVisible();
    await expect(sidebar).toBeHidden();
    for (let i = 0; i < 18; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => { const e = document.activeElement!; return !!e.closest('aside') && e.getBoundingClientRect().right <= 1; })).toBe(false);
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      await opener.focus(); await expect(opener).toBeFocused();
      if (repeat === 0) await opener.click();
      else await page.keyboard.press('Space');
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog).toBeVisible();
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
      for (let i = 0; i < 20; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true); }
      await capture(page, `${screenshotPrefix}-mobile-navigation`);
      await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
    }
    await page.setViewportSize({ width: 1023, height: 900 });
    expect(await page.evaluate(() => innerWidth)).toBe(1023);
    await expect(opener).toBeVisible(); await expect(sidebar).toBeHidden();
    await opener.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: title })).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 900 });
    expect(await page.evaluate(() => innerWidth)).toBe(1024);
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('main')).toBeFocused();
    await expectDesktopNavigation();
    await capture(page, `${screenshotPrefix}-desktop-breakpoint`);
  });
}

test('UX-07: mobile admin account menu has a name and keyboard interaction', async ({ page }) => {
  await fixtures(page); await page.goto('/admin/dashboard/users');
  const trigger = page.getByRole('button', { name: 'Admin account menu', exact: true });
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Update Profile' })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(page.getByRole('menuitem', { name: 'Change Password' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
});

test('UX-03/10: registration validates name locally and contains focus in verification', async ({ page }) => {
  const s = await fixtures(page); s.public = true; s.registerDelay = 800;
  await page.goto('/login?mode=register');
  await page.getByLabel('Full name').fill('   ');
  await page.getByLabel('Work email', { exact: true }).fill('registration@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Synthetic!123');
  await page.getByLabel('Confirm password', { exact: true }).fill('Synthetic!123');
  await page.locator('button[type=submit]').click();
  await expect(page.getByLabel('Full name')).toBeFocused();
  await expect(page.getByLabel('Full name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert').filter({ hasText: 'Enter your full name.' })).toBeVisible();
  expect(s.mutations).not.toContain('POST /api/auth/register');
  await page.getByLabel('Full name').fill('Synthetic Registration');
  await expect(page.getByLabel('Full name')).not.toHaveAttribute('aria-invalid');
  await page.locator('button[type=submit]').click(); await expect(page.getByRole('button', { name: 'Creating account…' })).toBeDisabled();
  const dialog = page.getByRole('dialog', { name: 'Check your email' }); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Open verification' })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Open verification' })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Open verification' })).toBeFocused();
  expect(s.mutations.filter(x => x === 'POST /api/auth/register')).toHaveLength(1);
  await capture(page, 'registration-verification-dialog');
});

for (const url of ['/login', '/forgot-password']) {
  test(`UX-08: skip link focuses main on ${url}`, async ({ page }) => {
    const s = await fixtures(page); s.public = true; await page.goto(url);
    await page.getByRole('link', { name: 'Skip to content' }).focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toHaveCount(1); await expect(page.locator('#main-content')).toBeFocused();
  });
}

test('UX-04: queue outage remains a retryable error, recovery empty is truthful, refresh failure stays visible', async ({ page }) => {
  const s = await fixtures(page); s.ticketsFail = true; await page.goto('/support/tickets');
  const main = page.getByRole('main');
  await expect(main.getByRole('alert')).toContainText('Ticket queue could not be loaded');
  await expect(main.getByText('No tickets match this view')).toHaveCount(0);
  await expect(main.getByText('Ticket count unavailable')).toBeVisible();
  await capture(page, 'support-initial-error');
  s.ticketsFail = false; await main.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(main.getByRole('alert')).toHaveCount(0); await expect(main.getByText('No tickets match this view')).toBeVisible();
  s.ticketsFail = true; await main.getByRole('button', { name: 'Refresh queue' }).click();
  await expect(main.getByRole('alert')).toContainText('Showing the last loaded results for this view.');
  await capture(page, 'support-refresh-error');
});

test('UX-05: delayed old scope cannot overwrite a newer support queue', async ({ page }) => {
  await fixtures(page); const delivered: string[] = [], requested: string[] = [];
  await page.route('**/api/support-portal/tickets?*', async route => {
    const scope = new URL(route.request().url()).searchParams.get('scope')!; requested.push(scope);
    if (scope === 'team') await new Promise(resolve => setTimeout(resolve, 1500));
    const ticket = { id: scope === 'team' ? 801 : 802, ticketNumber: scope === 'team' ? 'OLD-TEAM' : 'NEW-UNASSIGNED', subject: scope === 'team' ? 'Old team ticket' : 'Current unassigned ticket', status: 'open', priority: 'low', version: 1, totalMessages: 1, unreadCount: 0, createdAt: lead.createdAt, updatedAt: lead.createdAt, slaDeadline: null, customerName: 'Synthetic Customer', channel: 'email', assignedMemberId: null, handoffId: null, ownershipMode: 'ai_active', claimable: false };
    await route.fulfill({ json: { tickets: [ticket], total: 1, totalPages: 1, page: 1 } }); delivered.push(scope);
  });
  await page.goto('/support/tickets?scope=team'); await expect.poll(() => requested.includes('team')).toBe(true);
  await page.getByRole('button', { name: 'Unassigned', exact: true }).click();
  await expect(page.getByText('Current unassigned ticket', { exact: true })).toBeVisible();
  await expect.poll(() => delivered.includes('team')).toBe(true);
  await expect(page.getByText('Old team ticket', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Unassigned', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await capture(page, 'support-latest-scope');
});

test('UX-06: support scope/filter URL survives reload and Back/Forward and rejects invalid values', async ({ page }) => {
  const s = await fixtures(page); await page.goto('/support/tickets?scope=team');
  await page.getByRole('button', { name: 'Unassigned', exact: true }).click(); await expect(page).toHaveURL(/scope=unassigned/);
  await page.getByLabel('Filter tickets by status', { exact: true }).selectOption('open'); await expect(page).toHaveURL(/status=open/);
  await page.reload(); await expect(page.getByRole('button', { name: 'Unassigned', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Filter tickets by status', { exact: true })).toHaveValue('open');
  await page.goBack(); await expect(page.getByLabel('Filter tickets by status', { exact: true })).toHaveValue('all');
  await page.goForward(); await expect(page.getByLabel('Filter tickets by status', { exact: true })).toHaveValue('open');
  await page.goto('/support/tickets?scope=wrong&status=invalid&page=-1'); await expect(page).toHaveURL(/\/support\/tickets$/);
  await expect.poll(() => s.ticketQueries.at(-1)).toContain('scope=my');

  // Native query changes must synchronize Next, preserve custom history data,
  // and replace the invalid entry rather than insert a canonicalization step.
  const historyLength = await page.evaluate(() => {
    const length = history.length;
    history.replaceState({ queueAuditMarker: 'retained' }, '', '/support/tickets?scope=wrong&status=invalid&page=-1&origin=notification&tag=one&tag=two#queue');
    return length;
  });
  await expect(page).toHaveURL(/\/support\/tickets\?origin=notification&tag=one&tag=two#queue$/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await page.evaluate(() => history.state.queueAuditMarker)).toBe('retained');
  expect(await page.evaluate(() => Boolean(history.state.__NA && history.state.__PRIVATE_NEXTJS_INTERNALS_TREE))).toBe(true);
  await page.getByRole('button', { name: 'Team queue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Team queue', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).searchParams.get('origin')).toBe('notification');
  expect(new URL(page.url()).searchParams.getAll('tag')).toEqual(['one', 'two']);
  expect(new URL(page.url()).hash).toBe('#queue');
  await page.goBack(); await expect(page.getByRole('button', { name: 'My work', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goForward(); await expect(page.getByRole('button', { name: 'Team queue', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload(); await expect(page.getByRole('button', { name: 'Team queue', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).searchParams.getAll('tag')).toEqual(['one', 'two']);
  expect(new URL(page.url()).hash).toBe('#queue');

  // Both events share one browser task, before a React render can update the
  // handlers' captured filters. Neither selection may erase the other.
  await page.evaluate(() => {
    for (const [label, value] of [['Filter tickets by status', 'open'], ['Filter tickets by priority', 'high']]) {
      const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await expect(page.getByLabel('Filter tickets by status', { exact: true })).toHaveValue('open');
  await expect(page.getByLabel('Filter tickets by priority', { exact: true })).toHaveValue('high');
  expect(new URL(page.url()).searchParams.get('scope')).toBe('team');
  expect(new URL(page.url()).searchParams.get('status')).toBe('open');
  expect(new URL(page.url()).searchParams.get('priority')).toBe('high');
  await page.goBack(); await expect(page.getByLabel('Filter tickets by priority', { exact: true })).toHaveValue('all');
  await expect(page.getByLabel('Filter tickets by status', { exact: true })).toHaveValue('open');
  await page.goForward(); await expect(page.getByLabel('Filter tickets by priority', { exact: true })).toHaveValue('high');
  expect(await page.evaluate(() => history.state.queueAuditMarker)).toBe('retained');
  await capture(page, `${test.info().project.name}-canonical-queue-history`);
});

test('SC-01: support session outage is unverified, stays on route and retries without showing login', async ({ page }) => {
  const s = await fixtures(page); s.supportAuthFail = true; await page.goto('/support/tickets');
  await expect(page.getByRole('heading', { name: 'Support portal could not be checked' })).toBeVisible();
  await expect(page).toHaveURL(/\/support\/tickets$/); await expect(page.getByText('Ticket operations', { exact: true })).toHaveCount(0);
  await capture(page, 'support-session-error');
  s.supportAuthFail = false; await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Ticket operations' })).toBeVisible();
});

test('UX-09/11: proposal has one main, canceled Back keeps edits and accepted Back retains recovery', async ({ page }) => {
  await fixtures(page); await page.goto('/dashboard/proposals/42'); await expect(page.getByRole('main')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
  const title = page.getByLabel(/Proposal title/); await title.fill('Retained synthetic changes');
  let allow = false; let dialogs = 0;
  page.on('dialog', async d => { dialogs++; if (allow) await d.accept(); else await d.dismiss(); });
  await page.evaluate(() => history.back()); await expect.poll(() => dialogs).toBe(1);
  await expect(page).toHaveURL(/\/proposals\/42\/edit$/); await expect(title).toHaveValue('Retained synthetic changes');
  allow = true; await page.evaluate(() => history.back()); await expect(page).toHaveURL(/\/proposals\/42$/);
  await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore draft', exact: true })).toBeVisible(); await capture(page, 'proposal-recovery-after-approved-back');
});

test('SC-04: failed theme preference reports unsaved sync while preserving the current view', async ({ page }) => {
  const s = await fixtures(page); s.preferenceFail = true; await page.goto('/dashboard/leads');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click(); await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByText('Theme changed for this view')).toBeVisible(); await expect(page.getByText(/may revert after reload/)).toBeVisible();
  await capture(page, 'theme-sync-failure');
});

test('saved dark theme persists across customer, support and admin shells', async ({ page }) => {
  const s = await fixtures(page); await page.goto('/dashboard/leads');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect.poll(() => s.theme).toBe('dark');
  for (const [url, label] of [['/dashboard/leads', 'customer'], ['/support/tickets', 'support'], ['/admin/dashboard/users', 'admin']]) {
    await page.goto(url); await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/); await capture(page, `${label}-dark-final`);
  }
  await page.goto('/dashboard/leads'); await page.reload();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(s.mutations.filter(x => x === 'PUT /api/settings/preferences')).toHaveLength(1);
});

test('responsive shells and registration preserve reflow and one main at 320, 768 and 1440px', async ({ page }) => {
  const s = await fixtures(page);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [url, label] of [['/dashboard/leads', 'leads'], ['/dashboard/settings/leads', 'lead-settings'], ['/support/tickets', 'support-queue'], ['/admin/dashboard/users', 'admin-users'], ['/login?mode=register', 'register']]) {
      s.public = url.startsWith('/login'); await page.goto(url);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(page.getByRole('main')).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await capture(page, `${label}-${width}`);
    }
  }
});
