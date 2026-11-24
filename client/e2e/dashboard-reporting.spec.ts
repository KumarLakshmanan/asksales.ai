import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';

test('Home reports recorded CRM wins and keeps channel event types separate', async ({ page, audit }) => {
  // Catch every unmatched API request; this fixture never contacts a backend.
  await page.route('**/api/**', route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      audit.blockedMutations.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
      return route.fulfill({ status: 409, json: { error: 'Read-only reporting fixture' } });
    }
    return route.fulfill({ json: {} });
  });
  await installAppShellMocks(page);
  await page.route('**/api/suggestions', route => route.fulfill({ json: { success: true, suggestions: [], allSuggestions: [] } }));
  await page.route('**/api/setup/onboarding-status', route => route.fulfill({ json: { profile: {}, completedTasks: [], connectedChannels: [] } }));
  await page.route('**/api/dashboard/stats', route => route.fulfill({ json: {
    totalLeads: 500, newLeads: 5, activeCampaigns: 1, completedCampaigns: 0, messagesSent: 100,
    totalSpent: null, totalBudget: null, conversionRate: '20.0', spendByCurrency: {}, budgetByCurrencyAndType: [],
    reportingVersion: 2, recordedWins: { total: 2, crmContacts: 10, thisWeek: 2, lastWeek: 1, rate: '20.0', coverage: 'recorded_events_only', policy: 'first_lifetime_win_per_canonical_contact' },
    dailyActivity: [{ date: '2026-11-06', leads: 5, messages: 100, customerUpdates: 3, recordedWins: 2 }], campaignPerformance: [],
    leadSources: [{ source: 'linkedin', count: 500, percentage: 100 }],
    channelPerformance: { email: { sent: 100, opened: 50, replied: 10, clicked: 5 }, sms: { sent: 80, delivered: 30, replied: 4 }, linkedin: { sent: 40, accepted: 10, replied: 2 } },
    weeklyTrends: { leadsThisWeek: 5, leadsLastWeek: 3, messagesThisWeek: 100, messagesLastWeek: 80 },
  } }));
  await page.goto('/dashboard/home');
  await page.getByRole('button', { name: 'Performance', exact: true }).click();
  await expect(page.getByText('Recorded CRM win rate', { exact: true })).toBeVisible();
  await expect(page.getByText('20.0%', { exact: true })).toBeVisible();
  await expect(page.getByText(/Historical wins without recorded activity are unavailable/)).toBeVisible();
  await expect(page.getByText('50 opened / 100 sent receipts', { exact: true })).toBeVisible();
  await expect(page.getByText('30 delivered / 80 sent receipts', { exact: true })).toBeVisible();
  await expect(page.getByText('10 accepted / 40 sent receipts', { exact: true })).toBeVisible();
  await expect(page.getByText('Opened/Delivered', { exact: true })).toHaveCount(0);
  await page.getByText('View daily activity values', { exact: true }).click();
  const table = page.getByRole('table', { name: 'Daily activity values' });
  await expect(table.getByRole('columnheader', { name: 'Recorded first CRM wins' })).toBeVisible();
  await expect(table.getByRole('cell', { name: '2', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});
