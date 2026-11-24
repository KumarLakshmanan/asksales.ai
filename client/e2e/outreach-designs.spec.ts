import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { installOutreachReview } from './fixtures/outreach-review';
import type { Page, TestInfo } from '@playwright/test';

const templatesPath = '/dashboard/integrations/whatsapp/templates';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+xXikAAAAASUVORK5CYII=', 'base64');
const screenshot = async (page: Page, info: TestInfo, name: string) => {
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath(name + '.png'), fullPage: true, animations: 'disabled', style: 'nextjs-portal { visibility: hidden !important; }' });
};

test('WhatsApp recipient preview retains explicit consent, media and the reviewed account payload', async ({ page, audit }, info) => {
  const state = await installOutreachReview(page, 'light');
  await page.route(/\/compose\/templates(?:\?.*)?$/, route => route.fulfill({ json: { templates: [{ id: 'weekday', name: 'weekday_offer', language: 'en_US', headerType: 'IMAGE', body: 'Hello {{1}}, your weekday offer is ready.', footer: 'Reply here to reserve.', buttons: [{ type: 'QUICK_REPLY', text: 'Tell me more' }] }] } }));
  await page.route('**/api/outreach-conversations/compose/template-media', route => route.fulfill({ json: { mediaId: 'reviewed-header-media' } }));
  await page.goto('/dashboard/outreach/create?channel=whatsapp&leadId=1');
  await page.getByRole('button', { name: /Choose a template/ }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: /weekday_offer/ }).click();
  await drawer.getByLabel('Body variable 1').fill('{{first_name}}');
  await drawer.locator('input[type=file]').setInputFiles({ name: 'weekday.png', mimeType: 'image/png', buffer: png });
  await expect(drawer.getByText('Ready · weekday.png')).toBeVisible();
  await screenshot(page, info, 'template-media-drawer');
  await drawer.getByRole('button', { name: 'Use template', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Recipient preview', exact: true });
  await expect(preview.getByText('Hello Ada, your weekday offer is ready.')).toBeVisible();
  await expect(preview.getByRole('img', { name: 'WhatsApp template header' })).toBeVisible();
  await expect(page.getByText('consent confirmation required', { exact: false })).toBeVisible();
  expect(state.batches).toEqual([]);
  await screenshot(page, info, 'whatsapp-composer');
  await page.getByText('These recipients have agreed to receive WhatsApp messages from this business.', { exact: true }).click();
  await page.getByRole('button', { name: 'Review outreach', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review outreach', exact: true })).toBeVisible();
  expect(state.batches).toEqual([]);
  await screenshot(page, info, 'recipient-review');
  await page.getByRole('button', { name: 'Send to 1 recipient', exact: true }).click();
  await expect.poll(() => state.batches.length).toBe(1);
  expect(state.batches[0]).toMatchObject({ channel: 'whatsapp', providerAccountId: 'account-1', confirmation: { confirmed: true, recipientCount: 1 }, messages: [{ leadId: 1, templateName: 'weekday_offer', templateComponents: expect.arrayContaining([{ type: 'header', parameters: [{ type: 'image', image: { id: 'reviewed-header-media' } }] }]) }] });
  expect(audit.blockedMutations).toEqual([]);
});

test('template cards retain status filters and builder readiness focuses the actual missing field', async ({ page, audit }, info) => {
  const records = [
    { id: 1, name: 'weekday_offer', language: 'en_US', category: 'MARKETING', body: 'Your weekdays deserve a break too.', headerType: 'IMAGE', headerMediaUrl: 'data:image/png;base64,' + png.toString('base64'), footer: 'Reply here to reserve.', buttons: [{ type: 'QUICK_REPLY', text: 'Reply here' }], status: 'APPROVED', metaStatus: 'APPROVED', wabaTemplateId: 'meta-1', submissionStatus: 'approved', updatedAt: '2026-10-31T10:00:00Z' },
    { id: 2, name: 'support_ticket_assignment_v1', language: 'en_US', category: 'UTILITY', body: 'A new support ticket has been assigned to you. Please review it in AskSales.', headerType: 'NONE', status: 'APPROVED', metaStatus: 'APPROVED', wabaTemplateId: 'meta-2', submissionStatus: 'approved' },
  ];
  await page.route(/\/api\/whatsapp\/templates(?:\?.*)?$/, route => route.fulfill({ json: { templates: records, total: 2, statusCounts: { APPROVED: 2 }, languages: ['en_US'] } }));
  await page.route('**/api/whatsapp/config', route => route.fulfill({ json: { configured: true, config: { wabaName: 'Review business', businessAccountId: 'review-waba', connectionStatus: 'ready', tokenStatus: 'valid' } } }));
  await page.goto(templatesPath);
  await expect(page.getByRole('heading', { name: 'WhatsApp templates', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'support_ticket_assignment_v1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approved 2', exact: true }).click();
  await expect(page).toHaveURL(/status=APPROVED/);
  await screenshot(page, info, 'template-library');
  await page.getByRole('button', { name: 'Table view', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Create template', exact: true }).click();
  if (info.project.name.includes('mobile')) await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Fix template readiness: Add a template name', exact: true }).click();
  await expect(page.getByLabel(/Template name/)).toBeFocused();
  await page.getByLabel(/Template name/).fill('reviewed_offer');
  await page.getByLabel('Body', { exact: true }).fill('Hello {{1}}, your offer is ready.');
  if (info.project.name.includes('mobile')) await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Fix template readiness: Add the missing variable examples', exact: true }).click();
  await expect(page.getByLabel('Example for body {{1}}', { exact: true })).toBeFocused();
  await page.getByLabel('Example for body {{1}}', { exact: true }).fill('Nina');
  if (info.project.name.includes('mobile')) await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Template preview', exact: true }).getByText('Hello Nina, your offer is ready.')).toBeVisible();
  await screenshot(page, info, 'template-builder');
  await page.getByRole('button', { name: 'Review template', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit to Meta', exact: true })).toBeEnabled();
  await screenshot(page, info, 'meta-submission-review');
  expect(audit.blockedMutations).toEqual([]);
});

test('activity keeps queue snapshots, durable campaign actions and recorded messages distinct', async ({ page, audit }, info) => {
  await page.route('**/api/outreach/stats', route => route.fulfill({ json: { totalSent: 15, byChannel: {}, byStatus: { sent: 10, pending: 4, failed: 1 } } }));
  await page.route('**/api/outreach-conversations/queue', route => route.fulfill({ json: { checkedAt: '2026-10-31T10:00:00Z', channels: [{ channel: 'whatsapp', accepted: 8, delivered: 5, queued: 4, processing: 1, retrying: 2, failed: 1, review: 0, nextAttemptAt: '2026-11-01T10:00:00Z', waiting: [{ id: 'waiting-1', reason: 'daily_allowance', nextAttemptAt: '2026-11-01T10:00:00Z', error: null }] }] } }));
  await page.route('**/api/outreach/campaigns', route => route.fulfill({ json: { campaigns: [
    { id: 7, campaign_name: 'Guest return email', campaign_type: 'email', status: 'draft', job_count: 12 },
    { id: 8, campaign_name: 'Unconfirmed dispatch', campaign_type: 'email', status: 'needs_attention', job_count: 1, failed_count: 1, manual_review_count: 1, queue_issue: 'receipt_required' },
    { id: 9, campaign_name: 'Historical SMS', campaign_type: 'sms', status: 'paused', settings: { accountReviewRequired: true } },
  ] } }));
  await page.route('**/api/outreach/messages', route => route.fulfill({ json: [{ id: 1, leadName: 'Asha', channel: 'whatsapp', message: 'Your weekday offer', status: 'sent', createdAt: '2026-10-31T10:00:00Z' }] }));
  await page.goto('/dashboard/outreach/activity');
  const queue = page.getByRole('region', { name: 'Outreach queue', exact: true });
  await expect(queue.getByRole('row', { name: /^TOTAL 8 5 4 1 2 1 0/ })).toBeVisible();
  await expect(queue.getByText(/Snapshot:/)).toBeVisible();
  await expect(queue.getByText(/Daily sending allowance reached/)).toBeVisible();
  const campaignTable = page.getByRole('table', { name: 'Campaign delivery, progress and available actions' });
  await expect(campaignTable.getByRole('link', { name: 'Review delivery' })).toHaveAttribute('href', '/dashboard/outreach/campaigns/7/review');
  await expect(campaignTable.getByRole('button', { name: 'Retry failed' })).toHaveCount(0);
  await expect(campaignTable.getByText(/Queue confirmation needs review/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Recent outreach activity for the current business' }).getByText('Asha')).toBeVisible();
  await screenshot(page, info, 'campaign-activity');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await screenshot(page, info, 'campaign-activity-dark');
  expect(audit.blockedMutations).toEqual([]);
});
