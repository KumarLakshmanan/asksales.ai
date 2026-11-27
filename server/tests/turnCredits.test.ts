import { describe, expect, it, jest } from '@jest/globals';

const execute = jest.fn<(query: unknown) => Promise<{ rows: unknown[] }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { attachTurnCredits } = await import('../services/turnCredits.js');

describe('credits shown under a chat reply', () => {
  it('adds the turn total to the reply and saves it on the message', async () => {
    execute.mockReset();
    execute.mockResolvedValueOnce({ rows: [{ credits: 11 }] }).mockResolvedValueOnce({ rows: [] });
    const result = await attachTurnCredits(7, 'turn-1', { threadId: 3, response: { messageId: 42, metadata: { responseId: 'r1' } } });
    expect(result.response?.metadata).toEqual({ responseId: 'r1', creditsUsed: 11 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('changes nothing when the turn cost nothing or has no saved reply', async () => {
    execute.mockReset();
    execute.mockResolvedValueOnce({ rows: [{ credits: 0 }] });
    const free = await attachTurnCredits(7, 'turn-2', { threadId: 3, response: { messageId: 43, metadata: {} } });
    expect(free.response?.metadata).toEqual({});
    expect(execute).toHaveBeenCalledTimes(1);
    const noReply = await attachTurnCredits(7, 'turn-3', { threadId: 3, response: null });
    expect(noReply.response).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never fails the turn when the ledger cannot be read', async () => {
    execute.mockReset();
    execute.mockRejectedValueOnce(new Error('database unavailable'));
    const result = await attachTurnCredits(7, 'turn-4', { threadId: 3, response: { messageId: 44 } });
    expect(result.response).toEqual({ messageId: 44 });
  });
});
