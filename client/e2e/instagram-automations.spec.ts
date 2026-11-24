import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import {
  newInstagramRule,
  type InstagramAutomationOverview,
  type InstagramAutomationRule,
} from '../../shared/instagramAutomations';

test('Instagram hub, wizard, profile publishing and history work on desktop and mobile', async ({
  page,
  audit,
}, testInfo) => {
  page.setDefaultTimeout(15000);
  const data: InstagramAutomationOverview = {
    account: { id: '1001', username: 'orchidstudio' },
    readiness: {
      enabled: true,
      messages: true,
      comments: true,
      profile: true,
      richMessages: true,
      reasons: [],
    },
    profiles: [],
    rules: [],
    stats: { triggers: 0, sent: 0, failed: 0, skipped: 0, pending: 0, uncertain: 0 },
  };
  const mutations: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem(
      'user',
      JSON.stringify({ id: 4101, name: 'Regression Alpha', email: 'regression-alpha@example.test' })
    );
    sessionStorage.setItem('active-business-profile:4101', '4102');
  });
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const reply = (body: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path.includes('csrf')) return reply({ csrfToken: 'fixture' });
    if (path === '/api/instagram/oauth/status')
      return reply({
        officialApi: {
          connected: true,
          authorized: true,
          instagramAccountId: '1001',
          username: 'orchidstudio',
          credentialId: 1,
        },
      });
    if (path === '/api/channel-accounts/instagram_api')
      return reply([
        { id: 1, accountIdentifier: '1001', accountName: 'orchidstudio', isSelected: true },
      ]);
    if (path === '/api/instagram/automations/1001') return reply({ success: true, data });
    if (path.endsWith('/1001/rules') && req.method() === 'POST') {
      mutations.push(path);
      const body = req.postDataJSON();
      const rule: InstagramAutomationRule = {
        id: 1,
        accountId: '1001',
        definition: body.definition,
        status: 'paused',
        priority: 1,
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      data.rules.push(rule);
      return reply({ success: true, data: rule });
    }
    if (path.endsWith('/1001/profiles/icebreakers') && req.method() === 'PUT') {
      mutations.push(path);
      const body = req.postDataJSON();
      const profile = {
        kind: 'icebreakers' as const,
        config: body.config,
        publishedConfig: body.publish ? body.config : null,
        revision: body.revision + 1,
        syncStatus: body.publish ? ('published' as const) : ('draft' as const),
        syncError: null,
        syncedAt: body.publish ? new Date().toISOString() : null,
      };
      data.profiles = [profile];
      return reply({ success: true, data: profile });
    }
    if (path.endsWith('/1001/runs'))
      return reply({
        success: true,
        data: {
          runs: [
            {
              id: 1,
              ruleId: 1,
              ruleName: 'Guide delivery',
              sourceKey: 'comment:c1',
              status: 'uncertain',
              reason: 'Provider response interrupted.',
              privateMessageId: null,
              publicMessageId: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith('/1001/media'))
      return reply({ success: true, data: { media: [], nextCursor: null } });
    if (
      /^\/api\/(auth\/me|platform\/access|settings\/preferences|settings\/business-profiles|wallet|chat\/threads|notifications\/unread\/count|organizations)$/.test(
        path
      )
    )
      return route.fallback();
    return reply({ success: true, data: [] });
  });
  await page.goto('/dashboard/integrations/instagram/automations?accountId=1001');
  await expect(
    page.getByRole('heading', { name: 'Instagram automations', exact: true })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('instagram-hub.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create comment to DM', exact: true }).first().click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Trigger keywords', { exact: true }).fill('guide');
  await page.getByLabel('Trigger keywords', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page
    .getByLabel('DM message', { exact: true })
    .fill('Here is your guide: https://example.test/guide');
  await expect(page.getByRole('button', { name: 'Carousel', exact: true })).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('instagram-compose.png'), fullPage: true });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Automation name', { exact: true }).fill('Guide delivery');
  await page.getByRole('button', { name: 'Create paused automation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guide delivery', exact: true })).toBeVisible();
  expect(data.rules[0].status).toBe('paused');
  expect(data.rules[0].definition.trigger).toEqual({
    ...newInstagramRule('comment_dm').trigger,
    keywords: ['guide'],
  });
  await page.getByRole('button', { name: 'All automations', exact: true }).click();
  await page.getByRole('button', { name: 'Set up questions', exact: true }).click();
  await page.getByLabel('Question 1', { exact: true }).fill('What are your opening hours?');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(
    page.getByText('Draft saved. Publish when you are ready.', { exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Publish to Instagram', exact: true }).click();
  await expect(
    page.getByText('Published and confirmed by Instagram.', { exact: true })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Automation hub', exact: true }).click();
  await page.goto('/dashboard/integrations/instagram/automations?accountId=1001&view=history');
  await expect(page.getByText('Provider response interrupted.', { exact: false })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(mutations).toHaveLength(3);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors.filter((line) => !line.includes('favicon'))).toEqual([]);
});
