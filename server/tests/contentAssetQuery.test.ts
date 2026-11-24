import { describe, expect, it } from '@jest/globals';
import { normalizeContentAssetQuery, contentAssetQuerySchema } from '../mastra/tools/contentAssetQuery.js';

describe('saved content identity lookup', () => {
  it('accepts exact IDs and removes duplicates', () => {
    expect(normalizeContentAssetQuery({ assetIds: [114, 115, 114] }).assetIds).toEqual([114, 115]);
  });
  it.each(['assetId:114', 'asset #114'])('adapts the legacy ID query %s without a body text filter', query => {
    expect(normalizeContentAssetQuery({ query })).toMatchObject({ assetIds: [114], query: undefined });
  });
  it('does not infer identity from prose or numeric title searches', () => {
    expect(normalizeContentAssetQuery({ query: '114' })).toMatchObject({ assetIds: undefined, query: '114' });
    expect(normalizeContentAssetQuery({ query: 'asset #114 launch' }).assetIds).toBeUndefined();
  });
  it.each([[], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]].map(ids => ({ ids })))('rejects invalid explicit IDs $ids', ({ ids }) => {
    expect(contentAssetQuerySchema.safeParse({ assetIds: ids }).success).toBe(false);
  });
  it('accepts media asset types used in campaign drafts', () => {
    expect(contentAssetQuerySchema.safeParse({ assetIds: [116], filters: { type: 'image' } }).success).toBe(true);
    expect(contentAssetQuerySchema.safeParse({ assetIds: [117], filters: { type: 'video' } }).success).toBe(true);
  });
});
