import { test, expect, expectNoHorizontalOverflow, installAppShellMocks } from './fixtures/app';

// Synthetic records only: screenshots must never capture a real customer queue.
const requests = ['Invoice needs correcting', 'Move my booking to Friday'];
const tickets = [...requests, 'Long booking question '.repeat(20).trim(), 'Support request · TKT-UX005-4'].map((headline, index) => ({
  id: index + 1, ticketNumber: `TKT-UX005-${index + 1}`,
  subject: index === 2 ? headline : index === 3 ? null : 'Classification unavailable',
  description: index < 2 ? headline : null, status: 'open', priority: 'high',
  customerName: 'Synthetic customer', customerEmail: 'customer@example.test', channel: 'web',
  lastMessagePreview: 'Synthetic automated acknowledgement', lastMessageDirection: 'outbound', unreadCount: 1,
  createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-09T12:00:00Z', slaDeadline: '2026-10-01T12:00:00Z',
  ownershipMode: 'human_owned', aiReplyEnabled: false,
  handoffReason: 'Intent and risk classification is unavailable.', teamName: 'Example support team',
}));

test.beforeEach(async ({ page }) => {
  // All APIs are intercepted so the UI test cannot read or change live records.
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await installAppShellMocks(page);
  await page.route('**/api/support/analytics?*', route => route.fulfill({ json: {
    totalTickets: 4, activeTickets: 4, openTickets: 4, slaBreaches: 4,
    waitingOnCustomerTickets: 0, resolvedTickets: 0, deliveryFailures: 0,
  } }));
});

test('distinct request headlines retain status and fit the viewport', async ({ page, audit }, testInfo) => {
  await page.route('**/api/support?*', route => route.fulfill({ json: { tickets, total: tickets.length, totalPages: 1 } }));
  await page.goto('/dashboard/support');
  for (const headline of [...requests, tickets[2].subject!, 'Support request · TKT-UX005-4']) {
    await expect(page.getByRole('heading', { name: headline, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Classification unavailable', exact: true })).toHaveCount(0);
  await expect(page.getByText('Classification unavailable', { exact: true })).toHaveCount(4);
  await expect(page.getByText('Human owned', { exact: true })).toHaveCount(4);
  await expect(page.getByText(/h overdue/)).toHaveCount(4);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('synthetic-queue.png'), fullPage: true });
  const longSubjectRow = page.getByRole('link').filter({ has: page.getByRole('heading', { name: tickets[2].subject! }) });
  await longSubjectRow.screenshot({ path: testInfo.outputPath('synthetic-long-subject.png') });
  const row = page.getByRole('link').filter({ has: page.getByRole('heading', { name: requests[0] }) });
  await row.focus();
  await expect(row).toBeFocused();
  await row.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/support\/1/);
  expect(audit.consoleErrors).toEqual([]);
});

test('empty-state keyboard recovery clears search and filters while retaining queue preferences', async ({ page, audit }, testInfo) => {
  const mutations: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.url());
  });
  let emptyQueue = false;
  await page.route('**/api/support?*', route => {
    const query = new URL(route.request().url()).searchParams;
    const filtered = ['search', 'status', 'priority', 'channel', 'ownership', 'sla', 'unread'].some(key => query.has(key));
    const rows = emptyQueue || filtered ? [] : tickets;
    return route.fulfill({ json: { tickets: rows, total: rows.length, totalPages: 1 } });
  });
  for (const [query, key, limit] of [
    ['search=zzqa-no-match-20261009', 'Enter', '20'],
    ['search=zzqa-no-match-20261009&status=open&priority=high&channel=email&ownership=human_owned&sla=breached&unread=true', 'Space', '50'],
  ]) {
    await page.goto(`/dashboard/support?page=1&limit=${limit}&sort=operational&${query}`);
    await expect(page.getByText('No tickets match this view', { exact: true })).toBeVisible();
    const state = page.getByRole('status').filter({ hasText: 'No tickets match this view' });
    const clear = state.getByRole('button', { name: 'Clear filters', exact: true });
    await clear.focus();
    await expect(clear).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`synthetic-empty-${key}.png`), fullPage: true });
    await clear.press(key);
    await expect(page.getByRole('heading', { name: requests[0], exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/dashboard/support\\?page=1&limit=${limit}&sort=operational$`));
    await expect(page.getByRole('textbox', { name: 'Search support tickets' })).toHaveValue('');
    await expect(page.getByRole('textbox', { name: 'Search support tickets' })).toBeFocused();
    await expectNoHorizontalOverflow(page);
  }
  emptyQueue = true;
  await page.reload();
  await expect(page.getByText('No support tickets yet', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});
