import { beforeEach, afterAll, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { campaignPublishFixture } from './fixtures/campaignPublish.js';

const execute = jest.fn<any>();
const transaction = jest.fn<any>(async (fn: any) => fn({ execute }));
const metaCredentials = jest.fn<any>();
const googleCredentials = jest.fn<any>();
const readiness = jest.fn<any>();
const settings = jest.fn<any>();
const revalidatePause = jest.fn<any>();
const meta = {
  createCampaign: jest.fn<any>(), createAdSet: jest.fn<any>(), createAd: jest.fn<any>(),
  updateResourceStatus: jest.fn<any>(), uploadImage: jest.fn<any>(), uploadVideo: jest.fn<any>(),
};
const googleCreate = jest.fn<any>();
const googleStatus = jest.fn<any>();
const googleFind = jest.fn<any>();
const googleRemove = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute, transaction } }));
jest.unstable_mockModule('../models/metaPageConnections/functions.js', () => ({ getMetaAdsCreds: metaCredentials }));
jest.unstable_mockModule('../controllers/integrationsController.js', () => ({ getGoogleAdsCredentials: googleCredentials }));
jest.unstable_mockModule('../services/ads/PaidAdAccountsService.js', () => ({
  resolveCampaignMetaCredentials: metaCredentials, resolveCampaignGoogleCredentials: googleCredentials,
}));
jest.unstable_mockModule('../services/ads/MetaAdsService.js', () => ({ MetaAdsService: class { constructor() { return meta; } } }));
jest.unstable_mockModule('../services/ads/GoogleAdsService.js', () => ({
  buildGoogleProviderCampaignName: (name: string, key: string) => `${name}:${key}`,
  createGoogleAdsSearchCampaign: googleCreate, findGoogleCampaignResourceGraph: googleFind,
  updateCampaignStatus: googleStatus, removeGoogleCampaignResources: googleRemove,
  createGoogleResponsiveSearchAd: jest.fn(), updateCampaignBudget: jest.fn(), updateGoogleAdGroupStatus: jest.fn(), updateGoogleAdStatus: jest.fn(),
}));
jest.unstable_mockModule('../services/ads/AutonomousAdsService.js', () => ({ autonomousAdsService: { getSettings: settings, getAccountReadiness: readiness } }));
jest.unstable_mockModule('../services/ads/AdPerformanceService.js', () => ({ adPerformanceService: { revalidateAutonomousPause: revalidatePause } }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: {} }));
jest.unstable_mockModule('../services/emailService.js', () => ({ emailService: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { AutonomousAdsActionProcessor } = await import('../services/ads/AutonomousAdsActionProcessor.js');
const dialect = new PgDialect();
const queries: ReturnType<typeof dialect.sqlToQuery>[] = [];
let fixture: ReturnType<typeof campaignPublishFixture>;
let campaign: any;
let resources: any[];
let ownsLease: boolean;
let action: any;
let worker: any;
const originalGate = process.env.AD_PROVIDER_MUTATIONS_ENABLED;

describe('review-to-worker journey with fake ad providers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fixture = campaignPublishFixture();
    campaign = structuredClone(fixture.campaign);
    resources = [];
    ownsLease = true;
    queries.length = 0;
    action = { id: 99, user_id: 7, campaign_id: 19, platform: 'meta', action_type: 'publish',
      status: 'processing', attempts: 1, max_attempts: 4, locked_by: 'fake-worker', locked_at: new Date(),
      idempotency_key: 'fake-approved-action', payload: { actorType: 'user', approvedReview: fixture.approved } };
    worker = new AutonomousAdsActionProcessor() as any;
    process.env.AD_PROVIDER_MUTATIONS_ENABLED = 'true';
    settings.mockResolvedValue({ liveProviderMutationsEnabled: true });
    revalidatePause.mockReset().mockResolvedValue({ valid: true });
    readiness.mockResolvedValue({ meta: true, google: true, reasons: {}, accounts: fixture.accounts });
    metaCredentials.mockResolvedValue({ ...fixture.accounts.meta, accessToken: 'fake-not-a-token' });
    googleCredentials.mockResolvedValue({ ...fixture.accounts.google, refreshToken: 'fake-not-a-token' });
    meta.createCampaign.mockResolvedValue({ success: true, campaignId: 'fake-meta-campaign' });
    meta.createAdSet.mockResolvedValue({ success: true, adSetId: 'fake-meta-adset' });
    meta.createAd.mockResolvedValue({ success: true, adId: 'fake-meta-ad' });
    meta.updateResourceStatus.mockResolvedValue({ success: true });
    googleFind.mockResolvedValue(null);
    googleCreate.mockResolvedValue({ success: true, campaignResourceName: 'customers/1234567890/campaigns/fake',
      budgetResourceName: 'fake-budget', adGroupResourceNames: ['fake-group'], adResourceNames: ['fake-ad'] });
    googleStatus.mockResolvedValue({ success: true });
    googleRemove.mockResolvedValue({ success: true });
    execute.mockImplementation(async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      queries.push(compiled);
      const { sql, params } = compiled;
      if (sql.includes('SELECT * FROM performance_ad_campaigns')) return { rows: [structuredClone(campaign)] };
      if (sql.includes('SELECT child_key, platform')) return { rows: fixture.allocations.map(a => ({ child_key: a.key, platform: a.platform, allocated_amount: a.amount, spent_amount: a.spent })) };
      if (sql.includes('SELECT status, locked_by')) return { rows: [{ status: ownsLease ? 'processing' : 'cancelled', locked_by: action.locked_by, locked_at: action.locked_at }] };
      if (sql.includes('SELECT * FROM ad_provider_resources')) return { rows: resources.filter(row => row.resource_type === params[3] && row.local_key === params[4]) };
      if (sql.includes('INSERT INTO ad_provider_resources')) {
        resources.push({ id: resources.length + 1, resource_type: params[3], local_key: params[4], provider_resource_id: params[5], provider_resource_name: params[6], status: params[7], metadata: JSON.parse(String(params[9])) });
      }
      if (sql.includes('COUNT(DISTINCT local_key)')) return { rows: [{ child_count: 1, ad_count: 1 }] };
      if (sql.includes('COUNT(*) AS unfinished_count')) return { rows: [{ unfinished_count: 1 }] };
      if (sql.includes('RETURNING id') && sql.includes('UPDATE ad_action_queue')) return { rows: ownsLease ? [{ id: action.id }] : [] };
      return { rows: [] };
    });
  });
  afterAll(() => {
    if (originalGate === undefined) delete process.env.AD_PROVIDER_MUTATIONS_ENABLED;
    else process.env.AD_PROVIDER_MUTATIONS_ENABLED = originalGate;
  });

  it('passes the exact approved Meta allocation, placements, destination, and creative to the provider', async () => {
    await worker.processAction(action);
    expect(meta.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ name: fixture.campaign.name, status: 'PAUSED' }));
    expect(meta.createAdSet).toHaveBeenCalledWith(expect.objectContaining({ lifetimeBudget: 6000,
      targeting: expect.objectContaining({ publisherPlatforms: ['instagram'], instagramPositions: ['stream'] }) }));
    expect(meta.createAd).toHaveBeenCalledWith(expect.objectContaining({ creative: expect.objectContaining({ objectStorySpec: expect.objectContaining({
      pageId: '34', linkData: expect.objectContaining({ link: fixture.campaign.landing_page_url, message: 'The exact approved primary text.', imageHash: 'saved-image-hash' }),
    }) }) }));
    expect(meta.updateResourceStatus.mock.calls.map(call => call[1])).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE']);
    const completed = queries.find(q => q.sql.includes("SET status = 'succeeded'"));
    expect(completed?.params.some(value => typeof value === 'string' && value.includes('"activated":true'))).toBe(true);
    expect(completed?.sql).toContain("status = 'processing' AND locked_by");
  });

  it('rejects a different Instagram identity before any provider resource is created', async () => {
    metaCredentials.mockResolvedValue({ ...fixture.accounts.meta, instagramAccountId: 'different-instagram', accessToken: 'fake-not-a-token' });
    await expect(worker.processAction(action)).rejects.toThrow(/changed after approval/);
    expect(meta.createCampaign).not.toHaveBeenCalled();
    expect(meta.createAd).not.toHaveBeenCalled();
  });

  it('passes the exact Google share, account, copy, and schedule to the provider', async () => {
    action.platform = 'google';
    await worker.processAction(action);
    expect(googleCreate).toHaveBeenCalledWith(expect.objectContaining({ customerId: '1234567890' }), expect.objectContaining({
      totalBudgetAmount: 40, finalUrl: fixture.campaign.landing_page_url,
      headlines: fixture.campaign.ad_creatives.google[0].headlines, geoTargetIds: ['geoTargetConstants/2840'], timeZone: 'UTC',
    }));
    expect(googleStatus).toHaveBeenCalledWith(expect.anything(), 'customers/1234567890/campaigns/fake', 'ENABLED');
  });

  it('blocks activation when the reviewed budget changes while paused resources are created', async () => {
    meta.createAd.mockImplementationOnce(async () => {
      campaign.budget_amount = '120.00';
      return { success: true, adId: 'fake-meta-ad' };
    });
    await expect(worker.processAction(action)).rejects.toThrow(/created; activation did not complete/);
    expect(meta.updateResourceStatus.mock.calls.map(call => call[1])).toEqual(['PAUSED']);
    expect(action.providerPauseConfirmed).toBe(true);
    expect(queries.some(q => q.sql.includes('"providerCreationComplete":true'))).toBe(true);
  });

  it('fences activation if cancellation arrives during the asynchronous readiness check', async () => {
    let checks = 0;
    readiness.mockImplementation(async () => {
      if (++checks === 3) ownsLease = false;
      return { meta: true, google: true, reasons: {}, accounts: fixture.accounts };
    });
    await expect(worker.processAction(action)).rejects.toThrow(/cancelled or its worker lease changed/);
    expect(meta.updateResourceStatus.mock.calls.map(call => call[1])).toEqual(['PAUSED']);
    queries.length = 0;
    await worker.fail(action, 'Old worker failure');
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("status = 'processing' AND locked_by");
  });

  it('never blindly creates a second Meta campaign after an unknown first response', async () => {
    meta.createCampaign.mockRejectedValueOnce(new Error('Connection lost after request'));
    await expect(worker.processAction(action)).rejects.toThrow('Connection lost');
    expect(action.payload.providerMutationStarted).toBe(true);
    await expect(worker.processAction(action)).rejects.toThrow('no durable receipt');
    expect(meta.createCampaign).toHaveBeenCalledTimes(1);
  });

  it('preserves Meta identity and original activation error if the safety pause also throws', async () => {
    meta.updateResourceStatus.mockImplementation(async (_id: string, state: string) => {
      throw new Error(state === 'PAUSED' ? 'Pause connection lost' : 'Activation connection lost');
    });
    await expect(worker.processAction(action)).rejects.toThrow(/fake-meta-campaign.*pause is not confirmed.*Activation connection lost.*Pause connection lost/);
    expect(action.providerCreationComplete).toBe(true);
    expect(action.providerPauseConfirmed).toBe(false);
    expect(meta.updateResourceStatus.mock.calls.some(call => call[1] === 'ARCHIVED')).toBe(false);
  });

  it.each(['retained', 'discovered'])('pauses and retains a %s Google graph after uncertain activation', async kind => {
    action.platform = 'google';
    if (kind === 'retained') resources.push({ resource_type: 'campaign', local_key: 'campaign', provider_resource_name: 'fake-google-campaign', metadata: { publishReviewRevision: fixture.review.revision } });
    else googleFind.mockResolvedValue({ campaignResourceName: 'fake-google-campaign', budgetResourceName: 'fake-budget',
      adGroups: [{ adGroupName: `${campaign.name} - google-1`, adGroupResourceName: 'fake-group', adResourceName: 'fake-ad', keywordResourceNames: ['fake-keyword'] }] });
    googleStatus.mockImplementation(async (_credentials: any, _id: string, state: string) => {
      if (state === 'ENABLED') throw new Error('Activation response lost');
      return { success: true };
    });
    await expect(worker.processAction(action)).rejects.toThrow(/fake-google-campaign.*retained paused/);
    expect(googleStatus.mock.calls.map(call => call[2])).toEqual(['ENABLED', 'PAUSED']);
    expect(googleCreate).not.toHaveBeenCalled();
    expect(googleRemove).not.toHaveBeenCalled();
  });

  it('refuses activation using credentials different from the approved account', async () => {
    action.action_type = 'activate';
    resources.push({ resource_type: 'campaign', local_key: 'campaign', provider_resource_id: 'fake-meta-campaign', metadata: { publishReviewRevision: fixture.review.revision } });
    metaCredentials.mockResolvedValue({ adAccountId: 'act_switched', pageId: '34', accessToken: 'fake' });
    await expect(worker.processAction(action)).rejects.toThrow('credentials acquired for activation');
    expect(meta.updateResourceStatus).not.toHaveBeenCalled();
  });

  it('refuses to activate legacy or differently reviewed resources', async () => {
    action.action_type = 'activate';
    resources.push({ resource_type: 'campaign', local_key: 'campaign', provider_resource_id: 'fake-meta-campaign', metadata: {} });
    await expect(worker.processAction(action)).rejects.toThrow('different or legacy review');
    expect(meta.updateResourceStatus).not.toHaveBeenCalled();
  });

  it('cancels a queued launch even when its first provider resource does not exist', async () => {
    action.action_type = 'pause';
    const outcome = await worker.setStatus(action, 'paused');
    expect(outcome).toEqual(expect.objectContaining({ status: 'cancelled', launchCancelled: true, providerPauseConfirmed: false }));
    const revoke = queries.findIndex(q => q.sql.includes('publishApprovalRevokedByPlatform'));
    const lookup = queries.findIndex(q => q.sql.includes('SELECT * FROM ad_provider_resources'));
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeLessThan(lookup);
    expect(meta.updateResourceStatus).not.toHaveBeenCalled();
  });

  it.each(['meta', 'google'] as const)('does not pause %s after cancellation during credential resolution', async platform => {
    action.platform = platform;
    action.action_type = 'pause';
    resources.push({ id: 1, resource_type: 'campaign', local_key: 'campaign', provider_resource_id: 'fake-campaign', provider_resource_name: 'fake-campaign', status: 'active', metadata: {} });
    const credentials = platform === 'meta' ? metaCredentials : googleCredentials;
    credentials.mockImplementationOnce(async () => {
      ownsLease = false;
      return { ...fixture.accounts[platform], accessToken: 'fake-not-a-token' };
    });
    await expect(worker.processAction(action)).rejects.toThrow(/lease/);
    expect(meta.updateResourceStatus).not.toHaveBeenCalled();
    expect(googleStatus).not.toHaveBeenCalled();
  });

  it('rechecks dual consent after asynchronous credential resolution before pausing', async () => {
    action.action_type = 'pause';
    action.evaluation_id = 101;
    action.target_type = 'ad';
    action.target_key = 'ad-1';
    resources.push({ id: 1, resource_type: 'ad', local_key: 'ad-1', provider_resource_id: 'fake-ad', status: 'active', metadata: {} });
    revalidatePause.mockResolvedValueOnce({ valid: true }).mockResolvedValue({ valid: false, reason: 'Consent revoked during credential resolution.' });
    await expect(worker.processAction(action)).rejects.toThrow(/Consent revoked/);
    expect(meta.updateResourceStatus).not.toHaveBeenCalled();
  });

  it.each(['tenant', 'environment'])('rechecks the %s mutation gate after credential resolution', async gate => {
    action.action_type = 'pause';
    resources.push({ id: 1, resource_type: 'campaign', local_key: 'campaign', provider_resource_id: 'fake-campaign', status: 'active', metadata: {} });
    metaCredentials.mockImplementationOnce(async () => {
      if (gate === 'tenant') settings.mockResolvedValue({ liveProviderMutationsEnabled: false });
      else process.env.AD_PROVIDER_MUTATIONS_ENABLED = 'false';
      return { ...fixture.accounts.meta, accessToken: 'fake-not-a-token' };
    });
    await expect(worker.processAction(action)).rejects.toThrow(/disabled before the provider status/);
    expect(meta.updateResourceStatus).not.toHaveBeenCalled();
  });
});
