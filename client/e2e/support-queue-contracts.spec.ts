import { test, expect } from './fixtures/app';
import { fixtures } from './fixtures/ui-navigation';

test('queue links honor API page/search limits, preserve web and recover with history', async ({ page }) => {
  const state = await fixtures(page); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/support/tickets?origin=notification&page=100001#queue');
  await expect(page).toHaveURL(/\/support\/tickets\?origin=notification#queue$/);
  expect(state.ticketQueries.some(query => new URLSearchParams(query).get('page') === '100001')).toBe(false);
  await page.goto('/support/tickets?origin=notification&assignee=2147483648#queue');
  await expect(page).toHaveURL(/\/support\/tickets\?origin=notification#queue$/);
  expect(state.ticketQueries.some(query => new URLSearchParams(query).get('assignee') === '2147483648')).toBe(false);
  const overlong = 'x'.repeat(201);
  await page.goto('/support/tickets?search=' + overlong);
  const input = page.getByRole('textbox', { name: 'Search assigned tickets' });
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Search must contain at most 200 characters. Shorten it to load tickets.')).toBeVisible();
  expect(state.ticketQueries.some(query => (new URLSearchParams(query).get('search') || '').length > 200)).toBe(false);
  await input.fill('x'.repeat(200));
  await expect.poll(() => state.ticketQueries.some(query => new URLSearchParams(query).get('search')?.length === 200)).toBe(true);
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAttribute('placeholder', 'Ticket number or subject');
  await page.goto('/support/tickets?origin=notification&channel=web#queue');
  await expect.poll(() => state.ticketQueries.some(query => new URLSearchParams(query).get('channel') === 'web')).toBe(true);
  const channel = page.getByRole('combobox', { name: 'Filter tickets by channel' });
  await expect(channel).toHaveValue('web'); await channel.selectOption('email');
  await expect(page).toHaveURL(/origin=notification&channel=email#queue$/);
  await page.goBack(); await expect(channel).toHaveValue('web');
  await page.goForward(); await expect(channel).toHaveValue('email');
  await page.screenshot({ path: `${process.env.UI_FIX_SCREENSHOTS || '/tmp'}/${test.info().project.name}-queue-contracts.png`, fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]); expect(state.external).toEqual([]);
});

test('deterministic queue rejection offers filter correction without repeated requests', async ({ page }) => {
  await fixtures(page); let rejected = 0;
  await page.route('**/api/support-portal/tickets?*', route => {
    if (new URL(route.request().url()).searchParams.get('status') === 'open') {
      rejected++; return route.fulfill({ status: 400, json: { error: 'Synthetic filter rejected' } });
    }
    return route.fulfill({ json: { success: true, data: { tickets: [], page: 1, totalPages: 1, total: 0 } } });
  });
  await page.goto('/support/tickets?status=open');
  await expect(page.getByText('Synthetic filter rejected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeHidden();
  expect(rejected).toBe(1);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByText('No tickets match this view')).toBeVisible();
  expect(rejected).toBe(1);
});

test('claim feedback surfaces the enabled AI reply setting from the confirmed response', async ({ page }) => {
  await fixtures(page); let claimed = false;
  const ticket = { id: 1, ticketNumber: 'UI-CLAIM-1', subject: 'Synthetic claim', status: 'open', priority: 'medium', version: 1,
    unreadCount: 0, channel: 'web', ownershipMode: 'ai_active', aiReplyEnabled: true, claimable: true,
    assignedMemberId: null, updatedAt: '2026-10-23T00:00:00Z', createdAt: '2026-10-23T00:00:00Z' };
  await page.route('**/api/support-portal/tickets?*', route => route.fulfill({ json: { success: true, data: {
    tickets: [{ ...ticket, claimable: !claimed, assignedMemberId: claimed ? 51 : null }], page: 1, totalPages: 1, total: 1,
  } } }));
  await page.route('**/api/support-portal/tickets/1/claim', route => {
    expect(route.request().postDataJSON()).toEqual({ expectedVersion: 1 });
    claimed = true;
    return route.fulfill({ json: { success: true, data: { ...ticket, assignedMemberId: 51, version: 2 } } });
  });
  await page.goto('/support/tickets?scope=team');
  await page.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(page.getByText('The ticket’s AI reply setting is enabled.')).toBeVisible();
  await expect(page.getByText('AI remains paused while you own this conversation.')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Claim', exact: true })).toBeHidden();
});
