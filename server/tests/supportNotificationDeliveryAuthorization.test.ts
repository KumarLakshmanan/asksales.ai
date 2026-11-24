import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { db } from '../models/db.js';
import { SupportMemberNotificationService } from '../services/SupportMemberNotificationService.js';

afterEach(() => { jest.restoreAllMocks(); });
describe('notification worker respects the authorization claim result', () => {
  it.each(['suppressed', 'accepted', 'uncertain', 'cancelled'])('does not invoke a provider for %s', async (status) => {
    jest.spyOn(db, 'execute')
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, user_id: 9, status }] });
    const service = new SupportMemberNotificationService();
    const send = jest.fn(async () => ({ outcome: 'accepted', providerMessageId: 'qa-provider-id' }));
    Reflect.set(service, 'sendAdapter', send);
    await service.processDelivery(1, 9);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a claimed eligible delivery exactly once and persists provider acknowledgement', async () => {
    const execute = jest.spyOn(db, 'execute')
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, user_id: 9, status: 'sending', channel: 'email',
        recipient: 'qa@example.test', recipient_ciphertext: null, attempt_count: 1, max_attempts: 3 }] })
      .mockResolvedValue({ rows: [] });
    const service = new SupportMemberNotificationService();
    const send = jest.fn(async () => ({ outcome: 'accepted', providerMessageId: 'qa-provider-id', providerStatus: 'accepted' }));
    Reflect.set(service, 'sendAdapter', send);
    await service.processDelivery(1, 9);
    await service.processDelivery(1, 9); // The ledger returns no second claim.
    expect(send).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(6);
  });
});
