import { describe, expect, it, jest } from '@jest/globals';
import { withStartupConnectionRetry } from '../models/db.js';

describe('startup database connection retry', () => {
  it('retries a connection timeout and returns the eventual result', async () => {
    const timeout = Object.assign(new Error('Connection terminated due to connection timeout'), {
      cause: new Error('Connection terminated unexpectedly'),
    });
    const work = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5432'))
      .mockResolvedValue('ready');

    await expect(withStartupConnectionRetry(work, 4, 1)).resolves.toBe('ready');
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('does not retry schema problems', async () => {
    const work = jest
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Apply migration 299_business_profile_isolation before starting the application.'));

    await expect(withStartupConnectionRetry(work, 4, 1)).rejects.toThrow('Apply migration 299');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt limit', async () => {
    const work = jest
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Connection terminated due to connection timeout'));

    await expect(withStartupConnectionRetry(work, 3, 1)).rejects.toThrow('connection timeout');
    expect(work).toHaveBeenCalledTimes(3);
  });
});
