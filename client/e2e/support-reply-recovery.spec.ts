import { test, expect } from './fixtures/app';
import { fixtures } from './fixtures/ui-navigation';

for (const realm of ['member', 'owner'] as const) {
  test(`${realm}: unchanged reply retry after response loss and reload reuses one intent`, async ({ page }) => {
    const state = await fixtures(page);
    const prefix = realm === 'member' ? '/api/support-portal/tickets' : '/api/support';
    const endpoint = prefix + '/1/' + (realm === 'member' ? 'reply' : 'messages');
    let uploads = 0; const attachmentIds: number[][] = [];
    const attachment = { name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment bytes') };
    const keys: string[] = []; const durable = new Set<string>(); const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', async route => {
      const req = route.request(); const path = new URL(req.url()).pathname;
      if (path === prefix + '/1/attachments') {
        uploads++; return route.fulfill({ json: { success: true, data: { fileId: 91, name: attachment.name, type: attachment.mimeType, size: attachment.buffer.length } } });
      }
      if (path === endpoint && req.method() === 'POST') {
        const body = req.postDataJSON(); keys.push(body.idempotencyKey); attachmentIds.push(body.attachments.map((file: { fileId: number }) => file.fileId)); durable.add(body.idempotencyKey);
        return route.fulfill({ status: keys.length === 1 ? 503 : 200, json: keys.length === 1 ? { error: 'Synthetic committed response unavailable' } : { success: true, data: {} } });
      }
      if (path === prefix + '/1') return route.fulfill({ json: { id: 1, ticketNumber: 'UI-REPLY-1', subject: 'Synthetic reply recovery', status: 'open', priority: 'medium', tags: [], messages: [], channel: 'web', customerName: 'Synthetic', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', totalMessages: 0, ownershipMode: 'human_owned', assignedMemberId: 51, aiReplyEnabled: false } });
      if (path === prefix + '/1/timeline') return route.fulfill({ json: { events: [] } });
      if (path === '/api/support/teams') return route.fulfill({ json: [] });
      return route.fallback();
    });
    const path = realm === 'member' ? '/support/tickets/1' : '/dashboard/support/1';
    const label = realm === 'member' ? 'Write a customer reply' : 'Write a reply to the customer';
    await page.goto(path);
    const input = page.getByRole('textbox', { name: label });
    await page.locator('input[type=file]').setInputFiles(attachment);
    await input.fill('Reviewed synthetic response');
    await page.getByRole('button', { name: realm === 'member' ? 'Send Reply' : 'Send reply', exact: true }).click();
    await expect.poll(() => keys.length).toBe(1);
    await expect(page.getByText(/The reply may have been accepted/)).toBeVisible();
    await page.reload();
    await page.locator('input[type=file]').setInputFiles(attachment);
    await input.fill('Reviewed synthetic response');
    await page.getByRole('button', { name: realm === 'member' ? 'Send Reply' : 'Send reply', exact: true }).click();
    await expect.poll(() => keys.length).toBe(2);
    expect(keys[1]).toBe(keys[0]); expect(durable.size).toBe(1);
    expect(attachmentIds).toEqual([[91], [91]]); expect(uploads).toBe(1);
    await expect(input).toHaveValue('');
    await page.screenshot({ path: `${process.env.UI_FIX_SCREENSHOTS || '/tmp'}/${realm}-${test.info().project.name}-reply-recovered.png`, fullPage: true, animations: 'disabled' });
    expect(errors).toEqual([]); expect(state.external).toEqual([]);
  });
}
