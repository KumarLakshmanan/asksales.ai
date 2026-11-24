import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// Minimal drizzle-shaped fakes: select(...).from().where().orderBy().limit() and
// transaction(tx => ...) with insert(...).values().onConflictDoNothing().returning().
const selectResults: unknown[][] = [];
const insertResults: unknown[][] = [];
const inserted: unknown[] = [];
const selectChain: any = {
  from: () => selectChain, where: () => selectChain, orderBy: () => selectChain,
  limit: async () => selectResults.shift() ?? [],
};
const tx: any = {
  insert: () => ({ values: (row: unknown) => { inserted.push(row); return { onConflictDoNothing: () => ({ returning: async () => insertResults.shift() ?? [] }) }; } }),
};
const db: any = { select: () => selectChain, transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
const sync = jest.fn(async () => undefined);
jest.unstable_mockModule('../models/db', () => ({ db }));
jest.unstable_mockModule('../services/content/ContentManagedStorageService.js', () => ({
  contentAssetManagedStorageEntry: () => undefined,
  contentStorageOwner: () => undefined,
  lockContentManagedStorage: async () => undefined,
  releaseContentManagedStorage: async () => undefined,
  syncContentManagedStorage: sync,
}));

const { ContentAssetModel } = await import('../models/contentAssets/functions.js');
const { withoutGenerationKey } = await import('../utils/contentGenerationKey.js');
jest.spyOn(ContentAssetModel, 'attachTrackedMedia').mockResolvedValue(undefined);

const row = { type: 'image', title: 'Image', content: '/uploads/a.png', channel: 'instagram', status: 'draft', userId: 7, imageUrl: '/uploads/a.png' };

describe('ContentAssetModel.createOnce', () => {
  beforeEach(() => { selectResults.length = 0; insertResults.length = 0; inserted.length = 0; sync.mockClear(); });

  it('returns the existing row for a repeated generation without inserting', async () => {
    selectResults.push([{ id: 11, ...row, metadata: { generationKey: 'image:abc' } }]);
    const result = await ContentAssetModel.createOnce(row, 'image:abc');
    expect(result).toEqual({ asset: expect.objectContaining({ id: 11 }), created: false });
    expect(inserted).toHaveLength(0);
  });

  it('inserts once with the key in metadata and outside publishing copies', async () => {
    insertResults.push([{ id: 12, ...row }]);
    const result = await ContentAssetModel.createOnce({ ...row, metadata: { origin: 'social' } }, 'image:abc');
    expect(result).toEqual({ asset: expect.objectContaining({ id: 12 }), created: true });
    expect(inserted[0]).toMatchObject({ publishPlatform: null, metadata: { origin: 'social', generationKey: 'image:abc' } });
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('returns the concurrent winner when the unique index rejects the insert', async () => {
    selectResults.push([], [{ id: 13, ...row }]);
    insertResults.push([]);
    const result = await ContentAssetModel.createOnce(row, 'image:abc');
    expect(result).toEqual({ asset: expect.objectContaining({ id: 13 }), created: false });
    expect(sync).not.toHaveBeenCalled();
  });

  it('requires an owner', async () => {
    await expect(ContentAssetModel.createOnce({ ...row, userId: null }, 'image:abc')).rejects.toThrow('owner');
  });
});

describe('publishing copies', () => {
  it('drop the generation key but keep other metadata', () => {
    expect(withoutGenerationKey({ generationKey: 'image:abc', platforms: ['instagram'] })).toEqual({ platforms: ['instagram'] });
    const untouched = { platforms: ['facebook'] };
    expect(withoutGenerationKey(untouched)).toBe(untouched);
    expect(withoutGenerationKey(null)).toBeNull();
  });
});
