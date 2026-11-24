import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { contentAssetsTable } from '../models/contentAssets/schema.js';

let predicate: SQL | undefined;
let selected: Record<string, unknown> = {};
let requestedLimit = 0;
const records = [{ id: 114, version: 3, threadId: 171, title: 'Saved creative' }];
const select = jest.fn((fields: Record<string, unknown>) => {
  selected = fields;
  return { from: () => ({ where: (where: SQL) => {
    predicate = where;
    return { limit: (limit: number) => {
      requestedLimit = limit;
      return { orderBy: async () => records };
    } };
  } }) };
});
jest.unstable_mockModule('../models/db.js', () => ({ db: { select } }));
jest.unstable_mockModule('../models/index.js', () => ({
  contentAssetsTable, leadsTable: {}, icpProfilesTable: {}, outreachCampaignsTable: {}, sentMessagesTable: {},
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const { executeQueryContentAssets } = await import('../mastra/tools/executors/dataQueryExecutor.js');
const context = { userId: 7, threadId: 171 } as Parameters<typeof executeQueryContentAssets>[1];

describe('content asset executor SQL and result contracts', () => {
  beforeEach(() => { jest.clearAllMocks(); predicate = undefined; });
  it.each([{ assetIds: [114] }, { query: 'assetId:114', filters: { limit: 1 } }])('keeps ownership in exact-ID query %j', async input => {
    const result = await executeQueryContentAssets(input, context);
    const query = new PgDialect().sqlToQuery(predicate!);
    expect(query.sql).toContain('"content_assets"."user_id" =');
    expect(query.sql).toContain('"content_assets"."id" in');
    expect(query.sql).not.toContain('ilike');
    expect(query.params).toEqual([7, 114]);
    expect(result).toMatchObject({ success: true, output: { assets: records } });
    expect(selected.version).toBe(contentAssetsTable.version);
    expect(selected.threadId).toBe(contentAssetsTable.threadId);
  });
  it('does not truncate a selected set to the default text-search limit', async () => {
    const assetIds = Array.from({ length: 25 }, (_, i) => i + 1);
    await executeQueryContentAssets({ assetIds, filters: { limit: 1 } }, context);
    expect(requestedLimit).toBe(25);
  });
  it('defaults campaign listings to the current thread instead of browsing unrelated assets', async () => {
    const result = await executeQueryContentAssets({ filters: { type: 'social_post' } }, context);
    const query = new PgDialect().sqlToQuery(predicate!);
    expect(query.sql).toContain('"content_assets"."thread_id" =');
    expect(query.params).toEqual([7, 171, 'social_post']);
    expect(result).toMatchObject({ output: { scope: 'current_campaign', threadId: 171 } });
  });
  it('supports an explicit account-wide library request', async () => {
    await executeQueryContentAssets({ scope: 'all_owned' }, context);
    expect(new PgDialect().sqlToQuery(predicate!).params).toEqual([7]);
  });
  it('fails closed if current-campaign scope has no valid conversation', async () => {
    expect(await executeQueryContentAssets({ scope: 'current_campaign' }, { ...context, threadId: 0 })).toMatchObject({ success: false });
    expect(select).not.toHaveBeenCalled();
  });
  it('rejects invalid identity input before reading the database', async () => {
    expect(await executeQueryContentAssets({ assetIds: [] }, context)).toMatchObject({ success: false });
    expect(select).not.toHaveBeenCalled();
  });
});
