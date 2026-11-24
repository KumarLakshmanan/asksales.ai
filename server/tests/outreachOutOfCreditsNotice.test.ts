import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const set = jest.fn<(...args: unknown[]) => Promise<string | null>>();
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => ({ set }) }));
const createNotification = jest.fn(async (row: unknown) => ({ id: 1, ...(row as object) }));
jest.unstable_mockModule('../models/notifications/functions.js', () => ({ createNotification }));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: { publish: jest.fn(async () => undefined) } }));

const { NotificationService } = await import('../services/NotificationService.js');
const { withBusinessScope } = await import('../tenancy/businessContext.js');

beforeEach(() => { set.mockReset(); createNotification.mockClear(); });

describe('out-of-credits outreach notice', () => {
  it('tells the owner once a day per business, not once per failed message', async () => {
    set.mockResolvedValueOnce('OK').mockResolvedValue(null);
    await withBusinessScope({ userId: 9, businessProfileId: 7 }, async () => {
      expect(await NotificationService.outreachOutOfCredits(9, 'whatsapp')).toBe(true);
      expect(await NotificationService.outreachOutOfCredits(9, 'whatsapp')).toBe(false);
    });
    expect(set).toHaveBeenCalledWith('notify:outreach-credits:9:7', '1', 'EX', 86_400, 'NX');
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 9, type: 'error', title: 'Outreach stopped: wallet is empty', actionUrl: '/dashboard/billing/recharge',
    }));
  });

  it('stays quiet when it cannot check whether the notice already went out', async () => {
    set.mockRejectedValue(new Error('Redis unavailable'));
    expect(await NotificationService.outreachOutOfCredits(9, 'whatsapp')).toBe(false);
    expect(createNotification).not.toHaveBeenCalled();
  });
});
