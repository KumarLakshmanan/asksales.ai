import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withBusinessScope, businessOwnerUserId } from '../tenancy/businessContext.js';
const execute = jest.fn<(query: SQL) => Promise<{ rows: Record<string, unknown>[] }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
const { discoverCompetitorProfiles, getCompetitorProfileAds } = await import('../services/ads/creative-intelligence/CompetitorProfileDiscovery.js');
describe('competitor discovery business selection', () => {
  beforeEach(() => { jest.clearAllMocks(); execute.mockResolvedValue({ rows: [] }); });
  it('uses the selected profile for an authorized member instead of the account default', async () => {
    await withBusinessScope({ userId: 9, businessProfileId: 77, actorUserId: 17 }, async () => {
      const userId = businessOwnerUserId({ user: { id: 17 } } as any);
      expect(userId).toBe(9);
      expect((await discoverCompetitorProfiles(userId)).status).toBe('business_details_required');
    });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.params).toEqual([9, 77]);
    expect(query.sql).toContain('AND id=');
    expect(query.sql).not.toContain('is_default');
  });
  it('rejects an owner mismatch before reading business details', async () => {
    await expect(withBusinessScope({ userId: 9, businessProfileId: 77 }, () => discoverCompetitorProfiles(17))).rejects.toMatchObject({ status: 403 });
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects advertiser lookups by a different owner before reading business details', async () => {
    await expect(withBusinessScope({ userId: 9, businessProfileId: 77 }, () => getCompetitorProfileAds(17, 'Advertiser'))).rejects.toMatchObject({ status: 403 });
    expect(execute).not.toHaveBeenCalled();
  });
});
