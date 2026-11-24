import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

test('Paid Ads filters retain visible names, shareable selections, and campaign pagination', async ({ page, audit }, testInfo) => {
  const mutations: string[] = [];
  // Keep this journey entirely on synthetic data, including incidental shell requests.
  await page.route('**/api/**', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      mutations.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
      await route.abort();
    } else if (/\/api\/(auth\/me|platform\/access|settings\/preferences|wallet|chat\/threads|notifications\/unread\/count)/.test(route.request().url())) {
      await route.fallback();
    } else {
      await route.fulfill({ json: {} });
    }
  });
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [{ id: 9, name: 'Regression business', isDefault: true, setupComplete: true, ownerApproved: true, brandToolkitCompleted: true, role: 'owner' }] }));
  await page.route('**/api/campaigns/accounts', route => route.fulfill({ json: { accounts: [] } }));
  await page.route('**/api/campaigns/analytics/dashboard?*', route => {
    const params = new URL(route.request().url()).searchParams;
    const campaigns = Array.from({ length: 21 }, (_, index) => ({
      id: index + 1, name: `Fixture campaign ${String(index + 1).padStart(2, '0')}`,
      source: 'provider_cache', status: 'report_only', providerStatus: 'ACTIVE',
      objective: 'app_promotion', adPlatform: 'meta', currency: 'USD', budgetAmount: 10,
      platformCampaignId: String(index + 1), campaignAiConsent: false, aiState: 'insufficient_data',
      metricsUpdatedAt: '2020-01-01T00:00:00Z', metrics: { spend: 10, clicks: 1, impressions: 100 },
    })).filter(campaign => (!params.has('platform') || params.get('platform') === campaign.adPlatform)
      && (!params.has('objective') || params.get('objective') === campaign.objective)
      && (!params.has('status') || params.get('status') === campaign.status));
    return route.fulfill({ json: { campaigns, currency: 'USD', availableCurrencies: ['USD'] } });
  });

  const labelAndTrigger = (name: string) => {
    const trigger = page.getByRole('combobox', { name, exact: true });
    const label = trigger.locator('..').locator('label');
    return { trigger, label };
  };
  const checkNames = async (statusLabel: string) => {
    for (const name of ['Platform', 'Objective', statusLabel]) {
      const { trigger, label } = labelAndTrigger(name);
      await expect(trigger).toBeVisible();
      await expect(label).toBeVisible();
      await expect(label).toHaveText(name);
      await expect(label).toHaveAttribute('for', await trigger.getAttribute('id') as string);
    }
    await expectNoHorizontalOverflow(page);
  };
  const chooseWithKeyboard = async (name: string, option: string) => {
    const { trigger } = labelAndTrigger(name);
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('option', { name: option, exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveText(option);
  };

  await page.goto('/dashboard/ads');
  await checkNames('Campaign status');
  await expect(page.getByText('Results unavailable for 21 campaigns; total is incomplete.')).toBeVisible();
  await expect(page.getByText('No fresh data', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Platform', exact: true })).toHaveText('all');
  await page.screenshot({ path: testInfo.outputPath('overview-default.png'), fullPage: true });
  await page.locator('[aria-label="Paid Ads filters"]').screenshot({ path: testInfo.outputPath('overview-default-filters.png') });
  await chooseWithKeyboard('Platform', 'meta');
  await chooseWithKeyboard('Objective', 'app promotion');
  await chooseWithKeyboard('Campaign status', 'report only');
  await checkNames('Campaign status');
  await expect(page).toHaveURL(/platform=meta/);
  await expect(page).toHaveURL(/objective=app_promotion/);
  await expect(page).toHaveURL(/status=report_only/);
  await page.reload();
  await checkNames('Campaign status');
  await expect(page.getByRole('combobox', { name: 'Objective', exact: true })).toHaveText('app promotion');
  await page.screenshot({ path: testInfo.outputPath('overview-selected.png'), fullPage: true });
  await page.locator('[aria-label="Paid Ads filters"]').screenshot({ path: testInfo.outputPath('overview-selected-filters.png') });

  await page.getByRole('tab', { name: 'Campaigns', exact: true }).click();
  await checkNames('Delivery status');
  await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Fixture campaign 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Fixture campaign 21', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Fixture campaign 01', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('campaigns-selected.png'), fullPage: true });
  await labelAndTrigger('Platform').trigger.locator('..').locator('..').screenshot({ path: testInfo.outputPath('campaigns-selected-filters.png') });
  await chooseWithKeyboard('Platform', 'google');
  await expect(page.getByText('Page 1 of 1', { exact: true })).toBeVisible();
  await checkNames('Delivery status');
  await chooseWithKeyboard('Platform', 'all');
  await chooseWithKeyboard('Objective', 'all');
  await chooseWithKeyboard('Delivery status', 'all');
  await checkNames('Delivery status');
  await page.screenshot({ path: testInfo.outputPath('campaigns-default.png'), fullPage: true });
  await labelAndTrigger('Platform').trigger.locator('..').locator('..').screenshot({ path: testInfo.outputPath('campaigns-default-filters.png') });

  // Simulate expanded translation copy on the real styled control at a narrow width.
  await page.setViewportSize({ width: 320, height: 844 });
  const { trigger, label } = labelAndTrigger('Objective');
  await label.evaluate(node => { node.textContent = 'Zielsetzung der internationalen Werbekampagne'; });
  await trigger.locator('span').first().evaluate(node => { node.textContent = 'Nur Berichterstattung ohne automatische Überwachung'; });
  await expectNoHorizontalOverflow(page);
  for (const element of [label, trigger.locator('span').first()]) {
    expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath('campaigns-expanded-copy-320.png'), fullPage: true });
  await labelAndTrigger('Platform').trigger.locator('..').locator('..').screenshot({ path: testInfo.outputPath('campaigns-expanded-copy-320-filters.png') });
  expect(mutations).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});
