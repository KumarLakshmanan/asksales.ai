import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const notify = jest.fn<(...args: any[]) => Promise<any>>();
const email = jest.fn<(...args: any[]) => Promise<any>>();
const limit = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: { notify } }));
jest.unstable_mockModule('../services/adminEmailService.js', () => ({ sendAdminEmail: email }));
jest.unstable_mockModule('../utils/emailTemplates.js', () => ({ renderAdminEmail: (data: any) => data.content }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) } }));
const { notifyOrganicPublishFailure } = await import('../services/social/OrganicPublishNotifications.js');
const failure: any = { id: 18, userId: 8, assetId: 21, status: 'failed', platform: 'instagram', reviewedPayload: { title: '<img src=x>' }, errorMessage: 'Request rejected' };
beforeEach(() => { jest.clearAllMocks(); limit.mockResolvedValue([{ email: 'fixture@example.test', name: 'Fixture', preferences: { emailNotifications: true, campaignUpdates: true } }]); });

describe('publishing failure notifications', () => {
  it('persists a calendar recovery link and escapes content in optional email', async () => {
    await notifyOrganicPublishFailure(failure);
    expect(notify).toHaveBeenCalledWith(8, expect.any(String), expect.any(String), 'error', { actionUrl: '/dashboard/content-calendar?assetId=21' });
    expect(email.mock.calls[0][0].html).toContain('&lt;img src=x&gt;');
    expect(email.mock.calls[0][0].html).not.toContain('<img');
  });
  it('respects email preferences while retaining the in-app notification', async () => {
    limit.mockResolvedValue([{ email: 'fixture@example.test', preferences: { emailNotifications: false, campaignUpdates: true } }]);
    await notifyOrganicPublishFailure(failure);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(email).not.toHaveBeenCalled();
  });
  it('respects campaign notification opt-out and ignores nonterminal retries', async () => {
    limit.mockResolvedValue([{ preferences: { campaignUpdates: false } }]);
    await notifyOrganicPublishFailure(failure);
    await notifyOrganicPublishFailure({ ...failure, status: 'retryable_failed' });
    expect(notify).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
  });
  it('guides an uncertain outcome to a status check rather than a duplicate retry', async () => {
    await notifyOrganicPublishFailure({ ...failure, status: 'ambiguous' });
    expect(notify.mock.calls[0][2]).toContain('Check provider status before retrying');
  });
});
