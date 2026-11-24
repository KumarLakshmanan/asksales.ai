import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mockAuthRequest, mockResponse } from './helpers/mockHelpers.js';
import type { AuthenticatedRequest } from '../types/express.js';

const senders = [
  { id: 1, type: 'gmail', email: 'current@example.test', isVerified: true },
  { id: 2, type: 'gmail', email: 'disconnected@example.test', isVerified: true },
  { id: 3, type: 'resend', email: 'current@verified.test', isVerified: true },
  { id: 4, type: 'resend', email: 'old@revoked.test', isVerified: true },
];
const options = jest.fn(async (_userId: number, _channel: string) => ({ accounts: [{ senderId: 1, ready: false }, { senderId: 3, ready: false }] }));
jest.unstable_mockModule('../models/emailSenders/functions.js', () => ({ listByUser: async () => senders }));
jest.unstable_mockModule('../services/outreach/CreationService.js', () => ({ getCreationOptions: options }));
jest.unstable_mockModule('../models/channelCredentials/functions', () => ({ ChannelCredentialModel: { findAllByUserAndPlatform: async () => [] } }));
const { listEmailSenders } = await import('../controllers/emailSendersController.js');
beforeEach(() => { jest.clearAllMocks(); });

describe('email action inventory versus management records', () => {
  it('offers only provider-connected Gmail and Resend senders without requiring assistant readiness', async () => {
    const res = mockResponse();
    await listEmailSenders(mockAuthRequest(41, { query: { availableOnly: 'true' } }) as AuthenticatedRequest, res);
    expect(options).toHaveBeenCalledWith(41, 'email');
    expect(res._json.senders).toEqual([
      { ...senders[0], connectionActive: true }, { ...senders[2], connectionActive: true },
    ]);
  });
  it('keeps disconnected records available for management and reconnection', async () => {
    const res = mockResponse();
    await listEmailSenders(mockAuthRequest(41) as AuthenticatedRequest, res);
    expect(res._json.senders.map((sender: { id: number }) => sender.id)).toEqual([1, 2, 3, 4]);
    expect(options).not.toHaveBeenCalled();
  });
});
