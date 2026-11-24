import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { installOutreachReview } from './fixtures/outreach-review';
import type { Page, TestInfo } from '@playwright/test';

test.use({ timezoneId: 'Asia/Kolkata', actionTimeout: 20_000, video: 'off' });

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await expectNoHorizontalOverflow(page);
  const main = page.locator('#main-content');
  const style = 'nextjs-portal, [data-sonner-toaster] { visibility: hidden !important; }';
  if (await main.evaluate(element => element.scrollTop > 80)) {
    await page.screenshot({ path: testInfo.outputPath(name + '-detail.png'), fullPage: true, animations: 'disabled', style });
    await main.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
  }
  await page.screenshot({ path: testInfo.outputPath(name + '.png'), fullPage: true, animations: 'disabled', style });
}

for (const theme of ['light', 'dark'] as const) {
  for (const channel of ['email', 'whatsapp', 'instagram', 'facebook', 'sms'] as const) {
    test(theme + ' ' + channel + ' creation, individual preview and queued result', async ({ page, audit }, testInfo) => {
      const state = await installOutreachReview(page, theme);
      await page.goto('/dashboard/outreach/create?channel=' + channel + '&leadId=1');
      await expect(page.getByRole('heading', { name: 'New outreach', exact: true })).toBeVisible();
      await expect(page.getByLabel('Select Ada Lovelace')).toBeChecked();
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /light/);
      if (channel === 'email') {
        await expect(page.getByRole('option', { name: 'Friendly check-in', exact: true })).toHaveCount(1);
        await page.getByLabel('Subject', { exact: true }).fill('Your proposal, {{first_name}}');
      }
      if (channel === 'whatsapp') {
        await page.getByLabel('Approved template', { exact: true }).selectOption('welcome-en');
        await page.getByLabel('Header variable 1').fill('{{first_name}}');
        await page.getByLabel('Body variable 1').fill('{{first_name}}');
        await page.getByText('These recipients have agreed to receive WhatsApp messages from this business.').click();
      } else await page.getByLabel('Message body').fill('Hello {{first_name}}, your proposal is ready.');
      await expect(page.getByRole('button', { name: 'Review outreach', exact: true })).toBeEnabled();
      await expect(page.getByText('Resolve these before sending', { exact: true })).toHaveCount(0);
      await capture(page, testInfo, 'create-' + channel + '-' + theme);
      expect(state.batches).toEqual([]);
      await page.getByRole('button', { name: 'Review outreach', exact: true }).click();
      await expect(page.getByText(/Hello Ada, your proposal is ready\./).first()).toBeVisible();
      await capture(page, testInfo, 'review-' + channel + '-' + theme);
      expect(state.batches).toEqual([]);
      await page.getByRole('button', { name: 'Send to 1 recipient', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Outreach queued', exact: true }).first()).toBeVisible();
      await capture(page, testInfo, 'queued-' + channel + '-' + theme);
      expect(state.batches).toHaveLength(1);
      expect(state.batches[0]).toMatchObject({
        channel, providerAccountId: channel === 'sms' ? 'ORCHID' : 'account-1',
        confirmation: { confirmed: true, channel, recipientCount: 1 },
        messages: [{ leadId: 1, expectedRecipient: channel === 'email' ? 'ada@example.test' : ['whatsapp', 'sms'].includes(channel) ? '919876543210' : '12345678' }],
      });
      await expect(page.getByRole('link', { name: 'Open conversation' })).toHaveAttribute('href', '/dashboard/outreach/inbox?thread=conversation:9');
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.blockedMutations).toEqual([]);
    });
  }

  test(theme + ' outreach settings open follow-ups and every follow-up workspace works', async ({ page, audit }, testInfo) => {
    const state = await installOutreachReview(page, theme);
    await page.goto('/dashboard/settings/outreach');
    await expect(page.getByRole('heading', { name: 'Assistants', exact: true })).toBeVisible();
    const shortcut = page.getByRole('link', { name: 'Follow-ups', exact: true }).filter({ visible: true });
    await expect(shortcut).toHaveAttribute('href', '/dashboard/outreach/follow-ups');
    await expect(page.getByRole('link', { name: 'Reply operations', exact: true })).toHaveAttribute('href', '/dashboard/settings/outreach/operations');
    await capture(page, testInfo, 'outreach-settings-' + theme);
    await shortcut.click();
    await expect(page).toHaveURL(/\/dashboard\/outreach\/follow-ups$/);
    await expect(page.getByRole('heading', { name: 'Follow-ups', exact: true })).toBeVisible();
    for (const [channel, label] of [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['sms', 'SMS']]) {
      await page.getByRole('tab', { name: label, exact: true }).click();
      await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toBeVisible();
      await capture(page, testInfo, 'follow-ups-' + channel + '-' + theme);
      await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
      await expect.poll(() => state.settings.at(-1)?.channel).toBe(channel);
      expect(state.settings.at(-1)?.body).toMatchObject({ enableAutoFollowUp: false, followUpSteps: [{ delayHours: 24, templateId: 77 }] });
    }
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    await expect(page.getByText('Ada Lovelace', { exact: true })).toBeVisible();
    await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();
    await capture(page, testInfo, 'follow-up-history-' + theme);
    await page.getByRole('tab', { name: 'Templates', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Friendly check-in', exact: true })).toBeVisible();
    await capture(page, testInfo, 'follow-up-templates-' + theme);
    await page.getByRole('button', { name: 'Create template', exact: true }).click();
    await page.getByLabel('Template name', { exact: true }).fill('Reviewed SMS check-in');
    await page.getByLabel('Message', { exact: true }).fill('Hi {{first_name}}, can I help?');
    await capture(page, testInfo, 'follow-up-template-dialog-' + theme);
    await page.getByRole('dialog').getByRole('button', { name: 'Create template', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    expect(state.templates).toEqual([expect.objectContaining({ type: 'sms', name: 'Reviewed SMS check-in', content: 'Hi {{first_name}}, can I help?' })]);
    await page.goto('/dashboard/outreach/follow-ups?channel=whatsapp&tab=history');
    await expect(page.getByRole('tab', { name: 'WhatsApp', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'History', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();
    expect(audit.consoleErrors).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
  });

  test(theme + ' Operations overview, isolated reply preview, reconciliation and reports', async ({ page, audit }, testInfo) => {
    const state = await installOutreachReview(page, theme);
    await page.goto('/dashboard/settings/outreach/orchestration');
    await expect(page.getByRole('heading', { name: 'AI reply operations', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What needs your attention', exact: true })).toBeVisible();
    await expect(page.getByText('System and channel status', { exact: true })).not.toBeVisible();
    await capture(page, testInfo, 'operations-overview-' + theme);
    await page.getByRole('button', { name: 'Open test', exact: true }).click();
    await page.getByLabel('Simulation channel').selectOption('email');
    await page.getByLabel('Customer test message').fill('Can you help me review the proposal?');
    await page.getByRole('button', { name: 'Preview reply safely', exact: true }).click();
    await expect(page.getByText('Happy to help. What would you like to know?', { exact: true })).toBeVisible();
    await page.getByLabel('Customer test message').fill('Which services are included?');
    await page.getByRole('button', { name: 'Preview reply safely', exact: true }).click();
    await expect(page.getByText('Your proposal includes the requested services.', { exact: true })).toBeVisible();
    expect(state.simulations[1]).toMatchObject({ channel: 'email', previewSessionId: 9001 });
    await capture(page, testInfo, 'operations-reply-test-' + theme);
    await page.getByRole('button', { name: 'Start a new test', exact: true }).click();
    await expect(page.getByLabel('Simulation channel')).toBeEnabled();
    await page.getByRole('tab', { name: /Review issues/ }).click();
    await expect(page.getByRole('heading', { name: 'Verify uncertain outcomes', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm sent', exact: true }).click();
    expect(state.reconciliations).toEqual([]);
    await page.getByPlaceholder('Required provider verification note', { exact: true }).fill('Verified in the provider dashboard.');
    await page.getByPlaceholder('Provider message ID (if sent)', { exact: true }).fill('provider-receipt-1');
    await capture(page, testInfo, 'operations-review-issues-' + theme);
    await page.getByRole('button', { name: 'Confirm sent', exact: true }).click();
    await expect(page.getByText('No ambiguous provider outcomes.', { exact: true })).toBeVisible();
    expect(state.reconciliations).toEqual([{ outcome: 'sent', note: 'Verified in the provider dashboard.', providerMessageId: 'provider-receipt-1' }]);
    await page.getByRole('tab', { name: 'Reports & status', exact: true }).click();
    await expect(page.getByText('System and channel status', { exact: true })).toBeVisible();
    await capture(page, testInfo, 'operations-reports-' + theme);
    await page.goto('/dashboard/settings/outreach/orchestration#simulator');
    await expect(page.getByRole('tab', { name: 'Test a reply', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(state.batches).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
  });

  test(theme + ' CRM list and contact detail open outreach with the correct contact', async ({ page, audit }, testInfo) => {
    const state = await installOutreachReview(page, theme);
    await page.goto('/dashboard/crm/contacts');
    await expect(page.getByText('Ada Lovelace', { exact: true }).filter({ visible: true })).toBeVisible();
    await capture(page, testInfo, 'crm-contacts-' + theme);
    await page.getByRole('button', { name: /(?:More actions for Ada Lovelace|Contact actions)/ }).filter({ visible: true }).click();
    await page.getByRole('menuitem', { name: 'Send outreach', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Send outreach', exact: true })).toBeVisible();
    await capture(page, testInfo, 'crm-outreach-dialog-' + theme);
    await page.getByRole('dialog').getByRole('button', { name: /WhatsApp/ }).click();
    await expect(page).toHaveURL(/\/dashboard\/outreach\/create\?channel=whatsapp&contactId=42$/);
    await expect(page.getByLabel('Select Ada Lovelace')).toBeChecked();
    expect(state.contactPreparations.at(-1)).toMatchObject({ contactId: 42, channel: 'whatsapp', providerAccountId: 'account-1' });
    for (const [channel, label] of [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram'], ['facebook', 'Messenger'], ['sms', 'SMS']]) {
      await page.goto('/dashboard/crm/contacts/42');
      await expect(page.getByRole('heading', { name: 'Ada Lovelace', exact: true })).toBeVisible();
      if (channel === 'email') await capture(page, testInfo, 'crm-contact-detail-' + theme);
      await page.getByRole('button', { name: 'Send outreach', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: new RegExp('^' + label) }).click();
      await expect(page).toHaveURL(new RegExp('/dashboard/outreach/create\\?channel=' + channel + '&contactId=42$'));
      await expect(page.getByLabel('Select Ada Lovelace')).toBeChecked();
      expect(state.contactPreparations.at(-1)).toMatchObject({ contactId: 42, channel, providerAccountId: channel === 'sms' ? 'ORCHID' : 'account-1' });
    }
    expect(state.batches).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
  });

  test(theme + ' settings and Operations recover from loading failures', async ({ page, audit }, testInfo) => {
    const state = await installOutreachReview(page, theme);
    const operationsAlert = page.getByRole('alert').filter({ hasText: 'Operations data could not be refreshed.' });
    state.followUpFailures = 10;
    await page.goto('/dashboard/outreach/follow-ups');
    await expect(page.getByText('Follow-up settings could not be loaded', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toHaveCount(0);
    expect(state.settings).toEqual([]);
    await capture(page, testInfo, 'follow-up-error-' + theme);
    state.followUpFailures = 0;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toBeVisible();
    state.reportFailures = 10;
    await page.goto('/dashboard/settings/outreach/orchestration');
    await expect(operationsAlert).toContainText('Operations data could not be refreshed.');
    await capture(page, testInfo, 'operations-error-' + theme);
    state.reportFailures = 0;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What needs your attention', exact: true })).toBeVisible();
    state.reportFailures = 10;
    await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
    await expect(operationsAlert).toContainText('The last loaded results are still shown.');
    await expect(page.getByRole('heading', { name: 'What needs your attention', exact: true })).toBeVisible();
    state.reportFailures = 0;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(operationsAlert).toHaveCount(0);
    expect(state.batches).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
  });
}
