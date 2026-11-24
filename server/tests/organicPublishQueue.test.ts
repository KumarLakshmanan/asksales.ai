import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const origin = { userId: 8, businessProfileId: 18, businessActorUserId: 8, billingOrganizationId: 80, billingActorUserId: 8 };
jest.unstable_mockModule('../tenancy/jobBusinessScope.js', () => ({ captureJobBusiness: async (data: unknown) => data }));

const find = jest.fn<(...args: any[]) => Promise<any>>();
const claimReconciliation = jest.fn<(...args: any[]) => Promise<boolean>>();
const release = jest.fn<(...args: any[]) => Promise<void>>();
const execute = jest.fn<(...args: any[]) => Promise<any>>();
const reconcile = jest.fn<(...args: any[]) => Promise<any>>();
const addJob = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../models/socialPublishAttempts/functions.js', () => ({ SocialPublishAttemptModel: {
  findByIdForUser: find, claimReconciliation, releaseReconciliation: release,
} }));
jest.unstable_mockModule('../queues/index.js', () => ({ queueRegistry: { addJob }, QUEUE_NAMES: { ORGANIC_PUBLISHING: 'organic-publishing' } }));
jest.unstable_mockModule('../services/social/OrganicPublishingService.js', () => ({ executeOrganicPublishAttempt: execute, reconcileAmbiguousOrganicAttempt: reconcile }));
const { enqueueOrganicPublishAttempt, processOrganicPublishJob } = await import('../services/social/OrganicPublishQueue.js');
const attempt = (status = 'pending') => ({ id: 17, userId: 8, businessProfileId: 18, reviewedPayload: { approvedBy: 8, publicationOrigin: origin }, status, nextAttemptAt: new Date(Date.now() - 1000) });

beforeEach(() => { jest.clearAllMocks(); claimReconciliation.mockResolvedValue(true); release.mockResolvedValue(undefined); });

describe('organic publishing queue delivery', () => {
  it('deduplicates a due delivery and gives later retries a distinct key', async () => {
    const first = attempt();
    await enqueueOrganicPublishAttempt(first as any);
    await enqueueOrganicPublishAttempt(first as any);
    expect(addJob.mock.calls[0][3]).toEqual(addJob.mock.calls[1][3]);
    expect(addJob.mock.calls[0][3]).toMatchObject({ removeOnFail: true });
    await enqueueOrganicPublishAttempt({ ...first, nextAttemptAt: new Date(first.nextAttemptAt.getTime() + 60_000) } as any);
    expect(addJob.mock.calls[2][3]).not.toEqual(addJob.mock.calls[0][3]);
  });
  it.each(['cancelled', 'succeeded', 'failed', 'claimed', 'remote_deleted'])('ignores stale jobs for %s attempts', async status => {
    find.mockResolvedValue(attempt(status));
    expect(await processOrganicPublishJob({ ...origin, userId: 8, attemptId: 17 }, 'worker')).toEqual({ skipped: true });
    expect(execute).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });
  it('does not send a scheduled post early after it was rescheduled', async () => {
    find.mockResolvedValue({ ...attempt(), nextAttemptAt: new Date(Date.now() + 60_000) });
    await processOrganicPublishJob({ ...origin, userId: 8, attemptId: 17 }, 'worker');
    expect(execute).not.toHaveBeenCalled();
  });
  it('reconciles uncertain outcomes under a lease instead of publishing again', async () => {
    find.mockResolvedValue(attempt('ambiguous'));
    reconcile.mockResolvedValue({ status: 'succeeded' });
    await processOrganicPublishJob({ ...origin, userId: 8, attemptId: 17 }, 'worker');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(17, 8, 'worker');
    claimReconciliation.mockResolvedValue(false);
    await processOrganicPublishJob({ ...origin, userId: 8, attemptId: 17 }, 'other-worker');
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
  it('delegates a known provider receipt to the finalizer that owns its lease', async () => {
    find.mockResolvedValue(attempt('provider_succeeded'));
    execute.mockRejectedValueOnce(new Error('status unavailable'));
    await expect(processOrganicPublishJob({ ...origin, userId: 8, attemptId: 17 }, 'worker')).rejects.toThrow('status unavailable');
    expect(claimReconciliation).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
