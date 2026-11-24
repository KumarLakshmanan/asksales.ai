import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { runtime } from './fixtures/conversation-runtime';
import { installLibrary } from './fixtures/outreach-local';

test.use({ actionTimeout: 20_000, video: 'off' });

for (const channel of ['email', 'whatsapp'] as const) {
  test(`campaign ${channel} card restores local follow-ups and confirms the reviewed batch`, async ({ page, audit }, info) => {
    const browserErrors: string[] = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    await runtime(page, { turns: [], stops: [], messages: [{ id: 101, role: 'assistant', agentType: 'outreach', content: 'Review your outreach.', createdAt: '2026-10-23T12:00:00Z', metadata: { isToolResult: true, toolName: 'send_outreach_messages', widgetMessageId: 101, success: true, toolOutput: { awaitingSubmission: true } } }] });
    const mock = await installLibrary(page);
    const widget = { id: 44, threadId: 42, messageId: 101, toolName: 'send_outreach_messages', widgetType: 'send_outreach', status: 'active', formValues: { channel, lead_ids: [1], subject: 'Proposal', body: 'Hello {{first_name}}' } as Record<string, unknown>, agentType: 'outreach', createdAt: '2026-10-23T12:00:00Z', updatedAt: '2026-10-23T12:00:00Z' };
    const submitted: Record<string, unknown>[] = [];
    await page.route('**/api/widgets**', async route => {
      const req = route.request();
      if (req.method() === 'PATCH') {
        Object.assign(widget, req.postDataJSON());
        return route.fulfill({ json: { success: true, widget } });
      }
      if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/close')) {
        widget.status = req.postDataJSON().status;
        return route.fulfill({ json: { success: true, widget } });
      }
      if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/submit')) {
        submitted.push(req.postDataJSON().values);
        widget.status = 'queued';
        return route.fulfill({ json: { success: true, widget, result: { success: true, output: { status: 'queued', queued: 1 } } } });
      }
      return route.fulfill({ json: { widgets: [widget] } });
    });
    await page.goto('/dashboard/conversations/42');
    const card = page.locator('[data-widget-review="44"]');
    const confirm = card.getByRole('button', { name: 'Confirm and run', exact: true });
    await expect(card.getByLabel('Send from', { exact: true })).toHaveValue('sender-1');
    await expect(confirm).toBeDisabled();
    for (const name of ['Email', 'WhatsApp', 'Instagram', 'Messenger', 'SMS']) await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
    const chooseTemplate = async () => {
      await page.getByRole('dialog').getByRole('button', { name: /welcome/ }).click();
      await page.getByLabel('Body variable 1').fill('{{first_name}}');
      await page.getByRole('button', { name: 'Use template', exact: true }).click();
    };
    if (channel === 'whatsapp') {
      await card.getByRole('button', { name: /Choose a template/ }).click();
      await chooseTemplate();
      await card.getByText('These recipients have agreed to receive WhatsApp messages from this business.', { exact: true }).click();
    }
    await card.getByRole('switch', { name: 'Enable follow-ups for this outreach' }).check();
    const followUps = card.getByRole('region', { name: 'Follow-ups for this outreach' });
    await followUps.getByLabel('Follow-up 1 delay', { exact: true }).fill('90');
    if (channel === 'whatsapp') {
      await followUps.getByRole('button', { name: /Choose a template/ }).click();
      await chooseTemplate();
    } else await followUps.getByLabel('Follow-up 1 message').fill('Checking in with {{first_name}}');
    await card.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect.poll(() => widget.status, { timeout: 10_000 }).toBe('draft');
    expect(JSON.stringify(widget.formValues)).toContain('"delayValue":90');
    await page.reload();
    await expect(card.getByLabel('Follow-up 1 delay', { exact: true })).toHaveValue('90');
    await expect(confirm).toBeDisabled();
    await card.getByRole('button', { name: 'Review outreach', exact: true }).click();
    await expect(confirm).toBeEnabled({ timeout: 10_000 });
    await expect(card.getByText(channel === 'email' ? 'Checking in with Asha' : 'Hello Asha', { exact: true }).last()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`campaign-${channel}-local-review.png`), fullPage: true });
    await confirm.click();
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({ channel, lead_ids: [1], outreach_review: { creationVersion: 1, channel, followUpSource: 'outreach', messages: [{ leadId: 1, followUps: [{ delayMinutes: 90, message: channel === 'email' ? 'Checking in with Asha' : 'Hello Asha' }] }] } });
    expect(mock.state.globalSettingsRequests).toEqual([]);
    expect(mock.state.batches).toEqual([]);
    expect(browserErrors).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
  });
}

test('changing business clears the local outreach and follow-up draft', async ({ page }) => {
  await installLibrary(page);
  await page.goto('/dashboard/outreach/create?channel=email&leadId=1');
  await page.getByLabel('Subject', { exact: true }).fill('Private business-one subject');
  await page.getByRole('switch', { name: 'Enable follow-ups for this outreach' }).check();
  await page.getByLabel('Follow-up 1 message').fill('Private business-one follow-up');
  await page.evaluate(() => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    sessionStorage.setItem(`active-business-profile:${user.id ?? user.user?.id}`, '4103');
    window.dispatchEvent(new Event('business-profile-changed'));
  });
  await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('');
  await expect(page.getByRole('switch', { name: 'Enable follow-ups for this outreach' })).not.toBeChecked();
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('Private business-one');
});
