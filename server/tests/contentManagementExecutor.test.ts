import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let predicate: SQL;
let rows: unknown[] = [];
let pageLimit = 0;
let pageOffset = 0;
const select = jest.fn(() => ({ from: () => ({ where: (where: SQL) => {
  predicate = where;
  return { orderBy: () => ({ limit: (limit: number) => {
    pageLimit = limit;
    return { offset: async (offset: number) => { pageOffset = offset; return rows; } };
  } }) };
} }) }));
const find = jest.fn<(...args: unknown[]) => Promise<any>>();
const update = jest.fn<(...args: any[]) => Promise<any>>();
const change = jest.fn<(...args: any[]) => Promise<any>>();
const validate = jest.fn();
const brand = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { select } }));
jest.unstable_mockModule('../models/contentAssets/functions.js', () => ({ ContentAssetModel: { findByIdForUser: find } }));
jest.unstable_mockModule('../services/social/OrganicPublishLifecycleService.js', () => ({ changeOrganicPublishSchedule: change, updateEditableContentAsset: update }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({ resolveContentBrandContext: brand, brandContextSnapshot: () => ({ owned: true }) }));
// Preserve real schema validation while isolate the owned compliance context.
const compliance = await import('../services/content/ContentComplianceService.js');
jest.unstable_mockModule('../services/content/ContentComplianceService.js', () => ({ ...compliance, validateGeneratedContent: validate }));
const { executeQueryScheduledPosts, executeEditSavedContent, executeChangeScheduledPost } = await import('../mastra/tools/executors/contentManagementExecutor.js');
const context = { userId: 7, threadId: 9 } as Parameters<typeof executeEditSavedContent>[1];
const scheduleIdentity = { expected_version: 3, expected_scheduled_for: '2099-01-01T09:00:00Z' };
const draft = () => ({ id: 20, userId: 7, threadId: 9, type: 'social_post', title: 'Saved', status: 'draft', version: 3, channel: 'linkedin', businessProfileId: 12, brandToolkitId: 13,
  content: JSON.stringify({ caption: 'Before', imageUrl: 'https://example.com/saved.png', hashtags: ['#saved'] }), metadata: { preserved: true } });
beforeEach(() => {
  jest.clearAllMocks(); rows = []; find.mockResolvedValue(draft()); brand.mockResolvedValue({ businessProfile: { id: 12 }, brandToolkit: { id: 13 } });
  update.mockImplementation(async (userId, id, patch) => ({ ...draft(), ...patch, id, userId }));
  change.mockResolvedValue({ affected: 1, attempts: [88] });
});
describe('bounded existing content operations', () => {
  it('queries owned schedules with exact IDs, timezone bounds and honest pagination', async () => {
    rows = [{ id: 20 }, { id: 21 }];
    const result = await executeQueryScheduledPosts({ asset_id: 20, from: '2026-09-10T00:00:00+05:30', to: '2026-09-10T23:59:59+05:30', platform: 'linkedin', limit: 1, offset: 3 }, context);
    const sql = new PgDialect().sqlToQuery(predicate);
    expect(sql.sql).toContain('"content_assets"."user_id" =');
    expect(sql.params).toContain(7); expect(sql.params).toContain(20); expect(sql.params).toContain('scheduled');
    expect(pageLimit).toBe(2); expect(pageOffset).toBe(3);
    expect(result).toMatchObject({ success: true, output: { posts: [{ id: 20 }], hasMore: true, nextOffset: 4 } });
    expect(change).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });
  it('rejects invalid identity, oversized bounds and local timestamps before queries', async () => {
    for (const input of [{ limit: 101 }, { from: 'tomorrow' }, { from: '2026-09-10T09:00:00' }, { from: '2026-09-12T00:00:00Z', to: '2026-09-10T00:00:00Z' }]) {
      expect(await executeQueryScheduledPosts(input, context)).toMatchObject({ success: false });
    }
    expect(await executeQueryScheduledPosts({}, { ...context, userId: NaN })).toMatchObject({ success: false });
    expect(select).not.toHaveBeenCalled();
  });
  it('edits the same versioned asset, preserves media, and clears approval', async () => {
    expect(await executeEditSavedContent({ asset_id: 20, expected_version: 3, text_fields: { caption: 'Revised' } }, context)).toMatchObject({ success: true, output: { assetId: 20, version: 4, approvalStatus: 'draft', published: false } });
    expect(find).toHaveBeenCalledWith(20, 7);
    expect(brand).toHaveBeenCalledWith(7, { businessProfileId: 12, brandToolkitId: 13 });
    const patch = update.mock.calls[0][2];
    expect(patch).toMatchObject({ version: 4, approvalStatus: 'draft', approvedBy: null, approvedAt: null });
    expect(JSON.parse(patch.content)).toMatchObject({ caption: 'Revised', imageUrl: 'https://example.com/saved.png', hashtags: ['#saved'] });
    expect(patch).not.toHaveProperty('metadata'); expect(change).not.toHaveBeenCalled();
  });
  it.each(['scheduled', 'processing', 'published'])('rejects %s assets without implicitly cancelling', async status => {
    find.mockResolvedValue({ ...draft(), status });
    expect(await executeEditSavedContent({ asset_id: 20, expected_version: 3, title: 'New' }, context)).toMatchObject({ success: false });
    expect(update).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  });
  it('rejects stale versions, foreign assets, unsafe fields and wrong content fields', async () => {
    expect(await executeEditSavedContent({ asset_id: 20, expected_version: 2, title: 'New' }, context)).toMatchObject({ success: false });
    expect(await executeEditSavedContent({ asset_id: 20, expected_version: 3, text_fields: { body: 'Wrong type' } }, context)).toMatchObject({ success: false });
    expect(await executeEditSavedContent({ asset_id: 20, expected_version: 3, title: 'New', approvalStatus: 'approved' }, context)).toMatchObject({ success: false });
    find.mockResolvedValue(undefined);
    expect(await executeEditSavedContent({ asset_id: 20, expected_version: 3, title: 'New' }, context)).toMatchObject({ success: false });
    expect(update).not.toHaveBeenCalled();
  });
  it('propagates locked concurrent-edit conflicts without claiming success', async () => {
    update.mockRejectedValue(new Error('Content changed while this edit was being prepared'));
    expect(await executeEditSavedContent({ asset_id: 20, expected_version: 3, title: 'New' }, context)).toMatchObject({ success: false, error: expect.stringContaining('Content changed') });
  });
  it('defaults to this campaign and requires explicit all_owned scope for another campaign', async () => {
    find.mockResolvedValue({ ...draft(), threadId: 100 });
    expect(await executeEditSavedContent({ asset_id: 20, expected_version: 3, title: 'New' }, context)).toMatchObject({ success: false });
    expect(update).not.toHaveBeenCalled();
    expect(await executeEditSavedContent({ scope: 'all_owned', asset_id: 20, expected_version: 3, title: 'New' }, context)).toMatchObject({ success: true });
  });
  it('delegates only one exact destination to the owned lifecycle', async () => {
    expect(await executeChangeScheduledPost({ ...scheduleIdentity, asset_id: 20, action: 'cancel' }, context)).toMatchObject({ success: true, output: { action: 'cancel', providerSendPerformed: false } });
    const options = { exactAssetOnly: true, expectedVersions: { 20: 3 }, expectedScheduledFor: { 20: scheduleIdentity.expected_scheduled_for }, threadId: 9 };
    expect(change).toHaveBeenLastCalledWith(7, [20], undefined, options);
    await executeChangeScheduledPost({ ...scheduleIdentity, asset_id: 20, action: 'reschedule', scheduled_for: '2099-01-01T09:00:00+05:30' }, context);
    expect(change).toHaveBeenLastCalledWith(7, [20], new Date('2099-01-01T09:00:00+05:30'), options);
  });
  it('fails closed for invalid or ambiguous schedule changes', async () => {
    expect(await executeChangeScheduledPost({ asset_id: 20, action: 'reschedule' }, context)).toMatchObject({ success: false });
    expect(await executeChangeScheduledPost({ asset_id: 20, action: 'cancel', scheduled_for: '2099-01-01T09:00:00Z' }, context)).toMatchObject({ success: false });
    expect(change).not.toHaveBeenCalled();
    change.mockRejectedValue(new Error('Select an exact destination'));
    expect(await executeChangeScheduledPost({ ...scheduleIdentity, asset_id: 20, action: 'cancel' }, context)).toMatchObject({ success: false, error: 'Select an exact destination' });
  });
});
