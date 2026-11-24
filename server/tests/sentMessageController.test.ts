import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const findRecentFollowUpsByUser = jest.fn<any>();
jest.unstable_mockModule('../models/sentMessages/functions', () => ({
  SentMessageModel: { findRecentFollowUpsByUser },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const { mockAuthRequest, mockRequest, mockResponse } = await import('./helpers/mockHelpers');
const { getSentMessages } = await import('../controllers/sentMessageController');

describe('sent-message follow-up activity endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findRecentFollowUpsByUser.mockResolvedValue([{ id: 4, channel: 'whatsapp', followUpStep: 2 }]);
  });

  it('returns the current user’s channel-scoped follow-up activity', async () => {
    const req = mockAuthRequest(23, { query: { followUps: 'true', channel: 'whatsapp', limit: '10' } });
    const res = mockResponse();

    await getSentMessages(req, res);

    expect(findRecentFollowUpsByUser).toHaveBeenCalledWith(23, 'whatsapp', 10, 0);
    expect(res._json).toEqual([{ id: 4, channel: 'whatsapp', followUpStep: 2 }]);
  });

  it.each(['unknown', 'linkedin', 'twitter'])('rejects unsupported channel %s instead of returning another channel’s logs', async (channel) => {
    const req = mockAuthRequest(23, { query: { followUps: 'true', channel } });
    const res = mockResponse();

    await getSentMessages(req, res);

    expect(res._status).toBe(400);
    expect(findRecentFollowUpsByUser).not.toHaveBeenCalled();
  });

  it('requires authentication for follow-up logs', async () => {
    const req = mockRequest({ query: { followUps: 'true', channel: 'linkedin' } });
    const res = mockResponse();

    await getSentMessages(req, res);

    expect(res._status).toBe(401);
    expect(findRecentFollowUpsByUser).not.toHaveBeenCalled();
  });
});
