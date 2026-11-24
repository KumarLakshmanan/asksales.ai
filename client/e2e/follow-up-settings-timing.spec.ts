import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';

test('follow-up timing, saved settings and option views agree across all five channels', async ({ page, audit }) => {
  const saved = new Map<string, unknown>();
  const requests: string[] = [];
  const defaults = {
    enableAutoFollowUp: true,
    followUpSteps: [
      { id: 1, enabled: true, delayValue: 1, delayUnit: 'hours', delayHours: 1, templateId: -1, templateName: 'Auto-generate' },
      { id: 2, enabled: true, delayValue: 1, delayUnit: 'days', delayHours: 24, templateId: -1, templateName: 'Auto-generate' },
    ],
  };
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await installAppShellMocks(page);
  await page.route('**/api/settings/integrations/*/follow-ups', async route => {
    const channel = new URL(route.request().url()).pathname.split('/')[4];
    if (route.request().method() === 'PUT') { saved.set(channel, route.request().postDataJSON()); return route.fulfill({ json: { success: true } }); }
    await route.fulfill({ json: saved.get(channel) || defaults });
  });
  await page.route('**/api/sent-messages?*', route => {
    requests.push(route.request().url());
    return route.fulfill({ json: [] });
  });
  await page.route('**/api/content/templates?*', route => route.fulfill({ json: { templates: [], total: 0 } }));

  await page.goto('/dashboard/outreach/follow-ups?channel=email');
  for (const [channel, label] of [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['sms', 'SMS']]) {
    await page.getByRole('tab', { name: label, exact: true }).click();
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save Settings' })).toBeVisible();
    await expect(page.getByText(/1 hour and 24 hours after that message/)).toBeVisible();
    await expect(page.getByLabel('Step 1 delay unit')).toHaveText('Hours');
    await expect(page.getByLabel('Step 2 delay unit')).toHaveText('Days');
    await page.getByLabel('Step 1 delay unit').click();
    for (const unit of ['Min', 'Hours', 'Days']) await expect(page.getByRole('option', { name: unit, exact: true })).toBeVisible();
    await page.getByRole('option', { name: 'Hours', exact: true }).click();
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect.poll(() => saved.has(channel)).toBe(true);
    expect(saved.get(channel)).toEqual(defaults);
    await expectNoHorizontalOverflow(page);
    if (channel === 'email') await page.screenshot({ path: `test-results/follow-up-settings-${test.info().project.name}.png`, fullPage: true });
    await page.reload();
    await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Step 1 delay unit')).toHaveText('Hours');
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    await expect(page.getByText('No follow-ups yet')).toBeVisible();
    expect(requests.some(url => new URL(url).searchParams.get('channel') === channel)).toBe(true);
    await page.getByRole('tab', { name: 'Templates', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create template', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});
