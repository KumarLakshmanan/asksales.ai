import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const execute = jest.fn<(...args: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>>();
const credentials = jest.fn<(userId: number) => Promise<{ accessToken: string; adAccountId: string; expiresAt?: Date } | null>>();
jest.unstable_mockModule('../models/db', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/metaPageConnections/functions.js', () => ({ getMetaAdsCreds: credentials }));
const { AnalyticsIngestionService } = await import('../services/AnalyticsIngestionService.js');

describe('managed campaign analytics authorization', () => {
  beforeEach(() => { jest.restoreAllMocks(); execute.mockReset(); credentials.mockReset(); });

  it('uses the current decrypted account credential instead of encrypted SQL config fields', async () => {
    const campaign = { id: 42, user_id: 9, platform: 'meta', platform_campaign_id: 'provider-42' };
    const unboundCampaign = { ad_platform: null, ad_account_id: null, settings: {} };
    execute.mockResolvedValueOnce({ rows: [campaign] }).mockResolvedValueOnce({ rows: [unboundCampaign] });
    credentials.mockResolvedValue({ accessToken: 'resolved-provider-token', adAccountId: 'selected-account' });
    const service = new AnalyticsIngestionService();
    const ingest = jest.spyOn(service, 'ingestMetaCampaign').mockResolvedValue({ success: true });
    const result = await service.ingestAllCampaigns('2026-09-01', '2026-09-08', 9);
    expect(credentials).toHaveBeenCalledWith(9);
    expect(ingest).toHaveBeenCalledWith(42, 9, 'provider-42', { accessToken: 'resolved-provider-token', adAccountId: 'selected-account', expiresAt: undefined }, '2026-09-01', '2026-09-08');
    expect(result.metricsIngested).toBe(1);
    expect(result.success).toBe(true);
  });

  it('records a reconnect failure without sending stale stored credentials to Meta', async () => {
    const campaign = { id: 42, user_id: 9, platform: 'meta', platform_campaign_id: 'provider-42' };
    const unboundCampaign = { ad_platform: null, ad_account_id: null, settings: {} };
    execute.mockResolvedValueOnce({ rows: [campaign] }).mockResolvedValueOnce({ rows: [unboundCampaign] });
    credentials.mockResolvedValue(null);
    const service = new AnalyticsIngestionService();
    const ingest = jest.spyOn(service, 'ingestMetaCampaign');
    const result = await service.ingestAllCampaigns('2026-09-01', '2026-09-08', 9);
    expect(ingest).not.toHaveBeenCalled();
    expect(result.errors).toEqual([expect.stringContaining('Reconnect Meta Ads')]);
    expect(result.success).toBe(false);
  });
});
