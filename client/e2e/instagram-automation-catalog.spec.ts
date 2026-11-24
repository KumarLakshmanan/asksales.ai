import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import type { InstagramAutomationOverview } from '../../shared/instagramAutomations';

test('connected Instagram cards explain access blockers and show each visitor journey', async ({ page, audit }, testInfo) => {
  page.setDefaultTimeout(15_000);
  const data: InstagramAutomationOverview = {
    account: { id: '1001', username: 'lakshmanan_kumar' },
    readiness: { authorized: true, enabled: false, messages: false, comments: false, profile: false, richMessages: false, reasons: ['Live automation access awaits administrator setup.'], checks: [
      { id: 'connection', title: 'Account authorization', ready: true, action: null },
      { id: 'rollout', title: 'Live automation access', ready: false, action: 'administrator' },
    ] }, profiles: [], rules: [], stats: { triggers: 0, sent: 0, failed: 0, skipped: 0, pending: 0, uncertain: 0 },
  };
  const calls: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101, name: 'Regression Alpha', email: 'regression-alpha@example.test' }));
    sessionStorage.setItem('active-business-profile:4101', '4102');
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const reply = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/instagram/oauth/status') return reply({ officialApi: { authorized: true, connected: true, instagramAccountId: '1001', username: 'lakshmanan_kumar', credentialId: 1 } });
    if (url.pathname === '/api/channel-accounts/instagram_api') return reply([{ id: 1, accountIdentifier: '1001', accountName: 'lakshmanan_kumar', isSelected: true }]);
    if (url.pathname === '/api/instagram/automations/1001') return reply({ success: true, data });
    if (url.pathname === '/api/instagram/automations/1001/readiness') {
      calls.push(`${request.method()} ${url.pathname}${url.search}`);
      return reply({ success: true, data: { ...data.readiness, enabled: true, messages: true, comments: true, profile: true, richMessages: true, reasons: [], checks: data.readiness.checks?.map(check => ({ ...check, ready: true, action: null })) } });
    }
    return route.fallback();
  });
  await page.goto('/dashboard/integrations/instagram/automations?accountId=1001');
  await expect(page.getByText('Instagram account connected · @lakshmanan_kumar')).toBeVisible();
  await expect(page.getByText('Account connected', { exact: true })).toHaveCount(5);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('catalog-connected.png'), fullPage: true });
  const starters = page.getByRole('region', { name: 'Conversation starters example' });
  await starters.getByRole('button', { name: 'How can I book?' }).click();
  await expect(starters.getByText('How can I book?', { exact: true })).toBeVisible();
  const menu = page.getByRole('region', { name: 'Main menu example' });
  await menu.getByRole('button', { name: 'Visit website · opens a link' }).click();
  await expect(menu.getByText('Website preview · example only')).toBeVisible();
  for (const title of ['Comment to DM', 'Public comment reply', 'Follow to unlock']) {
    const demo = page.getByRole('region', { name: `${title} example` });
    const count = title === 'Follow to unlock' ? 3 : 2;
    for (let i = 0; i < count; i++) await demo.getByRole('button', { name: `Next step in ${title} example` }).click();
    await expect(demo.getByRole('button', { name: `Replay ${title} example` })).toBeVisible();
  }
  await expect(page.getByText('Private reply to your GUIDE comment')).toBeVisible();
  await expect(page.getByText('Public reply', { exact: true })).toBeVisible();
  await expect(page.getByText('Follow verified', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('catalog-demo-outcomes.png'), fullPage: true });
  expect(calls).toEqual([]); // All demo steps are local illustrations.
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.getByText('Connection ready', { exact: true })).toHaveCount(5);
  expect(calls).toEqual(['GET /api/instagram/automations/1001/readiness?verify=1']);
  for (const name of ['Conversation starters', 'Main menu', 'Comment to DM', 'Public comment reply', 'Follow to unlock']) {
    const demo = page.getByRole('region', { name: `${name} example` });
    await demo.scrollIntoViewIfNeeded();
    await demo.screenshot({ path: testInfo.outputPath(`${name.toLowerCase().replaceAll(' ', '-')}-demo.png`) });
  }
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});
