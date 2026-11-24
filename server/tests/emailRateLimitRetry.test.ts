import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { DelayedError, type Job } from 'bullmq';
import { delayRejectedEmail, emailRetryTime } from '../services/outreach/emailRetry.js';

afterEach(() => { jest.restoreAllMocks(); });
const result = { success: false, retryable: true, outcomeUncertain: false, deliveryAttempted: true };
const makeJob = (data = {}, attemptsMade = 0) => ({
  data: { userId: 1, messageId: 3, ...data }, attemptsMade, opts: { attempts: 3 }, token: 'fixture-token',
  updateData: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  moveToDelayed: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
});

describe('durable email rate-limit retries', () => {
  it('delays the same job until the provider retry time after releasing the message claim', async () => {
    const job = makeJob();
    const release = jest.fn<(at: string) => Promise<void>>().mockResolvedValue(undefined);
    const retryAt = new Date(Date.now() + 7200_000).toISOString();
    await expect(delayRejectedEmail(job as unknown as Job, { ...result, retryAt }, release)).rejects.toBeInstanceOf(DelayedError);
    expect(job.updateData).toHaveBeenCalledWith({ userId: 1, messageId: 3, emailRateLimitRetries: 1 });
    expect(release).toHaveBeenCalledWith(retryAt);
    expect(job.moveToDelayed).toHaveBeenCalledWith(Date.parse(retryAt), 'fixture-token');
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(job.moveToDelayed.mock.invocationCallOrder[0]);
  });
  it.each([
    { ...result, outcomeUncertain: true }, { success: false, retryable: true },
    { ...result, retryable: false }, { ...result, success: true },
  ])('does not reschedule unproven or permanent failures: %j', async evidence => {
    const job = makeJob(); const release = jest.fn<() => Promise<void>>();
    await delayRejectedEmail(job as unknown as Job, evidence, release);
    expect(release).not.toHaveBeenCalled(); expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
  it.each([{ emailRateLimitRetries: 2 }, { emailRateLimitRetries: -1 }, { emailRateLimitRetries: 'invalid' }])('bounds retries using durable counters: %j', async data => {
    const job = makeJob(data);
    await delayRejectedEmail(job as unknown as Job, result, async () => {});
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
  it('counts ordinary queue failures against the retry budget', async () => {
    const job = makeJob({ emailRateLimitRetries: 1 }, 1);
    await delayRejectedEmail(job as unknown as Job, result, async () => {});
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
  it('does not schedule a send beyond its existing delivery confirmation', async () => {
    const job = makeJob(); const release = jest.fn<() => Promise<void>>();
    const retryAt = new Date(Date.now() + 7200_000).toISOString();
    expect(await delayRejectedEmail(job as unknown as Job, { ...result, retryAt }, release, new Date(Date.now() + 3600_000)))
      .toBe('confirmation_expired');
    expect(release).not.toHaveBeenCalled(); expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
  it('backs off exponentially for missing, malformed or elapsed provider timestamps', () => {
    expect(emailRetryTime(0, undefined, 1000)).toBe(31_000);
    expect(emailRetryTime(1, 'invalid', 1000)).toBe(61_000);
    expect(emailRetryTime(2, '2000-01-01T00:00:00Z', 2_000_000_000_000)).toBe(2_000_000_120_000);
    expect(emailRetryTime(20, undefined, 1000)).toBe(901_000);
  });
});
