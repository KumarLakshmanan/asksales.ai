import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
let assets: any[];
let attempts: any[];
let selects = 0;
const writes: { table: unknown; values: any; where?: unknown }[] = [];
const update = jest.fn((table: unknown) => ({ set: (values: unknown) => ({ where: async (where: unknown) => { writes.push({ table, values, where }); return []; } }) }));
const select = jest.fn(() => {
  const index = selects++;
  const result = index === 3 ? attempts : index >= 4 ? [] : assets;
  const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, for: async () => result,
    then: (resolve: (value: any) => unknown) => Promise.resolve(result).then(resolve) };
  return chain;
});
const tx = { select, update };
jest.unstable_mockModule('../models/db.js', () => ({ db: { transaction: async (callback: (db: any) => unknown) => callback(tx) } }));
jest.unstable_mockModule('../models/contentAssets/functions.js', () => ({ ContentAssetModel: { attachTrackedMedia: jest.fn() } }));
jest.unstable_mockModule('../services/social/OrganicPublishingService.js', () => ({
  OrganicPublishingError: class extends Error { constructor(message: string, public code: string, public status: number) { super(message); } },
  prepareOrganicPublishAttempt: jest.fn(),
  buildOrganicPublishReview: jest.fn(),
  resolveOrganicPublishingMedia: jest.fn(),
  // These schedule tests must never evaluate a new publication review. Keep
  // the current export/signature without silently accepting that branch.
  organicPublishReviewToken: jest.fn<typeof import('../services/social/OrganicPublishingService.js').organicPublishReviewToken>(() => {
    throw new Error('Unexpected publication review in a schedule lifecycle guard test');
  }),
}));
const { changeOrganicPublishSchedule } = await import('../services/social/OrganicPublishLifecycleService.js');
beforeEach(() => { jest.clearAllMocks(); writes.length = 0; selects = 0; assets = [{ id: 20, userId: 7, threadId: 9, status: 'scheduled', version: 3, scheduledPublishAt: new Date('2099-01-01T09:00:00Z') }]; attempts = []; });
describe('exact destination calendar lifecycle guard', () => {
  it('cancels the root platform only after locking its family, leaving siblings unchanged', async () => {
    assets.push({ id: 21, userId: 7, parentAssetId: 20, status: 'scheduled', metadata: { organicPublishAttemptId: 89 } });
    attempts = [{ id: 88, assetId: 20, status: 'pending' }, { id: 89, assetId: 21, status: 'pending' }];
    await expect(changeOrganicPublishSchedule(7, [20], undefined, { exactAssetOnly: true })).resolves.toEqual({ affected: 1, attempts: [88] });
    expect(select).toHaveBeenCalledTimes(4); expect(update).toHaveBeenCalledTimes(2);
    expect(writes.every(write => write.values.status === 'cancelled')).toBe(true);
    const predicates = writes.map(write => new PgDialect().sqlToQuery(write.where as SQL).params);
    expect(predicates).toEqual([[88], [7, 20]]);
  });
  it('retains the existing claimed-provider protection for exact posts', async () => {
    attempts = [{ id: 88, assetId: 20, status: 'claimed' }];
    await expect(changeOrganicPublishSchedule(7, [20], undefined, { exactAssetOnly: true })).rejects.toMatchObject({ code: 'PUBLISH_ATTEMPT_NOT_RESCHEDULABLE' });
    expect(update).not.toHaveBeenCalled();
  });
  it('reschedules only the selected root platform and preserves its reviewed payload', async () => {
    assets.push({ id: 21, userId: 7, parentAssetId: 20, status: 'scheduled', metadata: { organicPublishAttemptId: 89 } });
    attempts = [{ id: 88, assetId: 20, status: 'pending', platform: 'facebook', reviewedPayload: { caption: 'Reviewed', approvedBy: 7 } },
      { id: 89, assetId: 21, status: 'pending', platform: 'instagram' }];
    const when = new Date('2099-01-02T09:00:00Z');
    await expect(changeOrganicPublishSchedule(7, [20], when, { exactAssetOnly: true })).resolves.toEqual({ affected: 1, attempts: [88] });
    expect(writes[0].values).toMatchObject({ status: 'pending', nextAttemptAt: when, reviewedPayload: { caption: 'Reviewed', approvedBy: 7, scheduledFor: when.toISOString() } });
    expect(writes[1].values).toMatchObject({ status: 'scheduled', scheduledPublishAt: when });
    expect(writes.map(write => new PgDialect().sqlToQuery(write.where as SQL).params)).toEqual([[88], [7, 20]]);
  });
  it('rejects foreign IDs and past times without writes', async () => {
    assets = [];
    await expect(changeOrganicPublishSchedule(7, [20], undefined, { exactAssetOnly: true })).rejects.toMatchObject({ code: 'CONTENT_ASSET_NOT_FOUND' });
    await expect(changeOrganicPublishSchedule(7, [20], new Date(0), { exactAssetOnly: true })).rejects.toMatchObject({ code: 'INVALID_SCHEDULE' });
    expect(update).not.toHaveBeenCalled();
  });
  it.each([
    { expectedVersions: { 20: 2 } },
    { expectedScheduledFor: { 20: '2099-01-02T09:00:00Z' } },
  ])('rejects stale selected versions or timestamps under lock: %j', async options => {
    await expect(changeOrganicPublishSchedule(7, [20], undefined, { exactAssetOnly: true, ...options })).rejects.toMatchObject({ code: 'CONTENT_VERSION_CONFLICT' });
    expect(update).not.toHaveBeenCalled();
  });
  it('rejects another campaign under lock', async () => {
    await expect(changeOrganicPublishSchedule(7, [20], undefined, { exactAssetOnly: true, threadId: 99 })).rejects.toMatchObject({ code: 'CONTENT_ASSET_NOT_FOUND' });
    expect(update).not.toHaveBeenCalled();
  });
});
