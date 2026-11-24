import { test, expect } from './fixtures/app';
import { fixtures } from './fixtures/ui-navigation';

test('close review dialog contains focus, restores its trigger and reports pending delivery', async ({ page }) => {
  await fixtures(page); const errors: string[] = []; let closes = 0;
  let releaseClose = () => {};
  const closeResponse = new Promise<void>(resolve => { releaseClose = resolve; });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/support-portal/tickets/1**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (path.endsWith('/close')) {
      closes++; await closeResponse; return route.fulfill({ json: { success: true, data: { reviewDeliveryStatus: 'in_progress' } } });
    }
    if (path.endsWith('/timeline')) return route.fulfill({ json: { events: [] } });
    return route.fulfill({ json: { id: 1, ticketNumber: 'UI-CLOSE-1', subject: 'Synthetic close review', status: 'open', priority: 'medium', tags: [], messages: [], channel: 'web', customerName: 'Synthetic', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', totalMessages: 0, ownershipMode: 'human_owned', assignedMemberId: 51, aiReplyEnabled: false, version: 1 } });
  });
  await page.goto('/support/tickets/1');
  const trigger = page.getByRole('button', { name: 'Close & Review' });
  await trigger.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Close Ticket', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Review request message' })).toBeFocused();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
  expect(closes).toBe(0);
  await trigger.click(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trigger).toBeFocused(); expect(closes).toBe(0);
  await trigger.click();
  await page.screenshot({ path: `${process.env.UI_FIX_SCREENSHOTS || '/tmp'}/${test.info().project.name}-close-dialog.png`, fullPage: true, animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Close & Send', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Closing…', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  releaseClose();
  await expect(page.getByText(/Review delivery is in progress/)).toBeVisible();
  expect(closes).toBe(1); expect(errors).toEqual([]);
});
