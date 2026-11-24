import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
const execute = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { executeQueryAdCampaigns, adCampaignQuerySchema } = await import('../mastra/tools/adCampaignQuery.js');
const context = { userId: 7, threadId: 171 } as Parameters<typeof executeQueryAdCampaigns>[1];

describe('paid campaign lookup', () => {
  beforeEach(() => { execute.mockReset().mockResolvedValue({ rows: [] }); });
  it('keeps exact campaign lookup tenant-scoped and read-only', async () => {
    await executeQueryAdCampaigns({ campaignId: 19 }, context);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain('WHERE user_id =');
    expect(query.sql).toContain('AND id =');
    expect(query.params).toEqual([7, 19, 21, 0]);
    expect(query.sql).not.toContain('SELECT *');
    expect(query.sql).not.toMatch(/UPDATE|INSERT|DELETE/);
  });
  it('returns only public fields and distinguishes pagination from complete inventory', async () => {
    execute.mockResolvedValue({ rows: [{ id: 19, name: 'Resort', settings: { accessToken: 'secret' }, access_token: 'secret', ad_platform: 'meta' }, { id: 20 }] });
    const result = await executeQueryAdCampaigns({ limit: 1 }, context);
    expect(result.output.campaigns).toHaveLength(1);
    expect(result.output).toMatchObject({ hasMore: true, providerVerified: false, scope: 'current_user_saved_paid_campaigns' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.output.campaigns[0].campaignId).toBe(19);
  });
  it('validates identity and bounds before touching the database', async () => {
    await expect(executeQueryAdCampaigns({ campaignId: 0 }, context)).rejects.toThrow();
    await expect(executeQueryAdCampaigns({}, { ...context, userId: 0 })).rejects.toThrow('authenticated');
    expect(adCampaignQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
    expect(adCampaignQuerySchema.safeParse({ userId: 99 }).success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
