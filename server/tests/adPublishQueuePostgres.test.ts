import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client, Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import { campaignPublishFixture } from './fixtures/campaignPublish.js';

// Explicit local opt-in. All writes use connection-local TEMP tables, not
// application rows. Provider account readiness is faked, never requested live.
const connectionString = process.env.AD_PUBLISH_QA_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
const readiness = jest.fn<any>();
const metaStatus = jest.fn<any>();
const googleStatus = jest.fn<any>();
const metaCreate = jest.fn<any>();
const googleCreate = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  execute: (query: SQL) => database.execute(query),
  transaction: (callback: Parameters<typeof database.transaction>[0]) => database.transaction(callback),
} }));
const metaCredentials = () => ({ ...fixture.accounts.meta, accessToken: 'synthetic-not-a-token' });
const googleCredentials = () => ({ ...fixture.accounts.google, refreshToken: 'synthetic-not-a-token' });
jest.unstable_mockModule('../models/metaPageConnections/functions.js', () => ({ getMetaAdsCreds: metaCredentials }));
jest.unstable_mockModule('../controllers/integrationsController.js', () => ({ getGoogleAdsCredentials: googleCredentials }));
jest.unstable_mockModule('../services/ads/PaidAdAccountsService.js', () => ({ resolveCampaignMetaCredentials: metaCredentials, resolveCampaignGoogleCredentials: googleCredentials }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({ resolveContentBrandContext: jest.fn() }));
jest.unstable_mockModule('../services/ads/AdPerformanceService.js', () => ({ adPerformanceService: { revalidateAutonomousPause: async () => ({valid:true}) } }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: {} }));
jest.unstable_mockModule('../services/emailService.js', () => ({ emailService: {} }));
const forbiddenProviderCall = () => { throw new Error('Unexpected provider adapter operation in isolated PostgreSQL QA.'); };
jest.unstable_mockModule('../services/ads/MetaAdsService.js', () => ({
  MetaAdsService: class {
    createCampaign = metaCreate;
    createAdSet = async () => ({success:true,adSetId:'synthetic-meta-adset'});
    createAd = async () => ({success:true,adId:'synthetic-meta-ad'});
    updateResourceStatus = metaStatus;
  },
}));
jest.unstable_mockModule('../services/ads/GoogleAdsService.js', () => ({
  buildGoogleProviderCampaignName: (name: string) => `synthetic-${name}`,
  createGoogleAdsSearchCampaign: googleCreate,
  createGoogleResponsiveSearchAd: forbiddenProviderCall,
  findGoogleCampaignResourceGraph: async () => null,
  removeGoogleCampaignResources: forbiddenProviderCall,
  updateCampaignBudget: forbiddenProviderCall,
  updateCampaignStatus: googleStatus,
  updateGoogleAdGroupStatus: forbiddenProviderCall,
  updateGoogleAdStatus: forbiddenProviderCall,
  getGoogleAdsAccountInfo: forbiddenProviderCall,
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { AutonomousAdsService, autonomousAdsService } = await import('../services/ads/AutonomousAdsService.js');
const { AutonomousAdsActionProcessor } = await import('../services/ads/AutonomousAdsActionProcessor.js');
const { reconcileStopWidgets } = await import('../models/widgetStates/stopReconciliation.js');
const service = new AutonomousAdsService();
const worker = new AutonomousAdsActionProcessor() as any;
const originalGate = process.env.AD_PROVIDER_MUTATIONS_ENABLED;
let fixture: ReturnType<typeof campaignPublishFixture>;

describePostgres('ad approval queue against isolated local PostgreSQL tables', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Explicit local PostgreSQL is required.');
    client = new Client({ connectionString });
    await client.connect();
    // Fail rather than falling through to a real application table if a new
    // code path references a table omitted from this isolated fixture.
    await client.query('SET search_path TO pg_temp, pg_catalog');
    database = drizzle(client);
    await client.query(`
      CREATE TEMP TABLE widget_states (
        id integer PRIMARY KEY, user_id integer, tool_name text, status text, execution_result jsonb,
        execution_error text, execution_completed_at timestamptz, updated_at timestamptz
      );
      CREATE TEMP TABLE performance_ad_campaigns (
        id integer PRIMARY KEY, user_id integer, version integer, name text, objective text, ad_platform text,
        budget_type text, budget_amount numeric, currency text, spent_amount numeric, landing_page_url text,
        start_date timestamptz, end_date timestamptz, locations jsonb, targeting jsonb, auto_activate boolean,
        validation_errors jsonb, ad_creatives jsonb, settings jsonb, local_status text, status text,
        provider_status text, is_active boolean DEFAULT false, launched_at timestamptz,
        last_provider_error text, updated_at timestamptz
      );
      CREATE TEMP TABLE ad_campaign_allocations (
        id serial PRIMARY KEY, campaign_id integer, user_id integer, child_key text, platform text,
        allocated_amount numeric, spent_amount numeric, status text, updated_at timestamptz
      );
      CREATE TEMP TABLE ad_settings (user_id integer PRIMARY KEY, live_provider_mutations_enabled boolean,
        default_lifetime_budget numeric DEFAULT 100,currency text DEFAULT 'USD',locations jsonb DEFAULT '[]',
        autonomous_optimization_enabled boolean DEFAULT false,analytics_sync_minutes integer DEFAULT 15);
      CREATE TEMP TABLE ad_action_queue (
        id serial PRIMARY KEY, business_profile_id integer NOT NULL DEFAULT 71,
        campaign_id integer, user_id integer, platform text, action_type text,
        idempotency_key text, status text DEFAULT 'pending', payload jsonb, provider_outcome jsonb,
        last_error text, metrics_snapshot jsonb, rationale text, budget_impact numeric,
        locked_by text, locked_at timestamptz, completed_at timestamptz, updated_at timestamptz,
        available_at timestamptz DEFAULT NOW(), UNIQUE(business_profile_id, user_id, idempotency_key)
      );
      ALTER TABLE ad_action_queue ADD COLUMN attempts integer DEFAULT 0,
        ADD COLUMN max_attempts integer DEFAULT 4, ADD COLUMN evaluation_id integer,
        ADD COLUMN target_type text, ADD COLUMN target_key text;
      CREATE TEMP TABLE ad_provider_resources (
        id serial PRIMARY KEY, business_profile_id integer NOT NULL DEFAULT 71,
        campaign_id integer, user_id integer, platform text,
        resource_type text, local_key text, status text, error text, cleanup_status text, updated_at timestamptz,
        provider_resource_id text,provider_resource_name text,idempotency_key text,metadata jsonb,
        UNIQUE(business_profile_id,user_id,platform,idempotency_key)
      );
      CREATE TEMP TABLE ad_action_audit (
        id serial PRIMARY KEY, campaign_id integer, user_id integer, action_id integer,
        actor_type text, action_type text, rationale text, metrics_snapshot jsonb,
        budget_before numeric, budget_after numeric, provider_outcome jsonb
      );
    `);
    jest.spyOn(service, 'getAccountReadiness').mockImplementation(readiness);
    jest.spyOn(autonomousAdsService, 'getAccountReadiness').mockImplementation(readiness);
  });
  beforeEach(async () => {
    fixture = campaignPublishFixture();
    process.env.AD_PROVIDER_MUTATIONS_ENABLED = 'true';
    readiness.mockReset().mockResolvedValue({ meta: true, google: true, reasons: {}, accounts: fixture.accounts });
    metaCreate.mockReset().mockResolvedValue({success:true,campaignId:'synthetic-meta-campaign'});
    googleCreate.mockReset().mockResolvedValue({success:true,campaignResourceName:'customers/1234567890/campaigns/synthetic',budgetResourceName:'synthetic-budget',adGroupResourceNames:['synthetic-group'],adResourceNames:['synthetic-ad']});
    metaStatus.mockReset().mockResolvedValue({success:true});
    googleStatus.mockReset().mockResolvedValue({success:true});
    await client.query('TRUNCATE pg_temp.widget_states');
    await client.query('TRUNCATE pg_temp.ad_provider_resources');
    await client.query('TRUNCATE pg_temp.ad_action_queue, pg_temp.ad_action_audit, pg_temp.performance_ad_campaigns, pg_temp.ad_campaign_allocations, pg_temp.ad_settings RESTART IDENTITY');
    await client.query('INSERT INTO pg_temp.performance_ad_campaigns SELECT * FROM jsonb_populate_record(NULL::pg_temp.performance_ad_campaigns, $1::jsonb)', [JSON.stringify(fixture.campaign)]);
    for (const allocation of fixture.allocations) await client.query('INSERT INTO pg_temp.ad_campaign_allocations (campaign_id, user_id, child_key, platform, allocated_amount, spent_amount) VALUES (19, 7, $1, $2, $3, 0)', [allocation.key, allocation.platform, allocation.amount]);
    await client.query('INSERT INTO pg_temp.ad_settings(user_id,live_provider_mutations_enabled) VALUES (7, true)');
  });
  afterAll(async () => {
    await client?.end();
    jest.restoreAllMocks();
    if (originalGate === undefined) delete process.env.AD_PROVIDER_MUTATIONS_ENABLED;
    else process.env.AD_PROVIDER_MUTATIONS_ENABLED = originalGate;
  });

  it('stores the exact approved review and replays the same action without another enqueue', async () => {
    const first = await service.queueExistingCampaignPlatform(7, 19, 'meta', 'approval-one', fixture.review.revision);
    const second = await service.queueExistingCampaignPlatform(7, 19, 'meta', 'approval-one', fixture.review.revision);
    expect(second).toEqual(expect.objectContaining({ actionId: first.actionId, replayed: true, status: 'queued' }));
    const rows = (await client.query('SELECT * FROM pg_temp.ad_action_queue')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.approvedReview.snapshot).toEqual(fixture.review.snapshot);
    expect(rows[0].payload.approvedReview.scope).toBe('live_activation_and_spend');
    expect(readiness).toHaveBeenCalledTimes(1);
  });

  it('durably stops only the selected platform, even behind provider gates, and replays safely', async () => {
    await service.queueExistingCampaignPlatform(7, 19, 'meta', 'launch-meta', fixture.review.revision);
    await service.queueExistingCampaignPlatform(7, 19, 'google', 'launch-google', fixture.review.revision);
    process.env.AD_PROVIDER_MUTATIONS_ENABLED = 'false';
    const stop = await service.queueCampaignStop(7, 19, ['meta'], 'stop-one');
    expect(stop.platforms).toEqual([expect.objectContaining({ platform: 'meta', status: 'gated', providerPauseConfirmed: false })]);
    const rows = (await client.query('SELECT platform, action_type, status FROM pg_temp.ad_action_queue ORDER BY id')).rows;
    expect(rows).toEqual([
      { platform: 'meta', action_type: 'publish', status: 'cancelled' },
      { platform: 'google', action_type: 'publish', status: 'pending' },
      { platform: 'meta', action_type: 'pause', status: 'pending' },
    ]);
    const settings = (await client.query('SELECT settings FROM pg_temp.performance_ad_campaigns')).rows[0].settings;
    expect(settings.publishApprovalRevokedByPlatform.meta).toBeDefined();
    expect(settings.publishApprovalRevokedByPlatform.google).toBeUndefined();
    const replay = await service.queueCampaignStop(7, 19, ['meta'], 'stop-one');
    expect(replay.platforms[0]).toMatchObject({ actionId: stop.platforms[0].actionId, replayed: true, status: 'gated' });
    expect((await client.query("SELECT id FROM pg_temp.ad_action_queue WHERE action_type='pause'")).rows).toHaveLength(1);
  });

  it('rejects foreign ownership and empty stop selections before queueing', async () => {
    await expect(service.queueCampaignStop(8, 19, ['meta'], 'stop')).rejects.toThrow('Campaign not found');
    await expect(service.queueCampaignStop(7, 19, [], 'stop')).rejects.toThrow('exact campaign');
    expect((await client.query('SELECT id FROM pg_temp.ad_action_queue')).rows).toHaveLength(0);
  });

  it.each([true, false])('reconciles only exact stop receipts with confirmed outcomes=%s', async confirmed => {
    const stop = await service.queueCampaignStop(7, 19, ['meta', 'google'], 'stop-review');
    await client.query("INSERT INTO pg_temp.widget_states (id,user_id,tool_name,status,execution_result) VALUES (1,7,'stop_ads','queued',$1::jsonb)", [JSON.stringify({ success: true, output: { ...stop, status: 'queued' } })]);
    expect(await reconcileStopWidgets(database)).toBe(0);
    await client.query("UPDATE pg_temp.ad_action_queue SET status='succeeded', provider_outcome=$1::jsonb", [JSON.stringify({ status: 'paused' })]);
    if (!confirmed) await client.query("UPDATE pg_temp.ad_action_queue SET provider_outcome='{}'::jsonb WHERE platform='google'");
    expect(await reconcileStopWidgets(database)).toBe(1);
    const widget = (await client.query('SELECT * FROM pg_temp.widget_states')).rows[0];
    expect(widget.status).toBe(confirmed ? 'succeeded' : 'failed');
    expect(widget.execution_result.output.platforms).toHaveLength(2);
    expect(widget.execution_result.completionNotification).toEqual({ status: 'pending', eventId: 'widget-stop-completed:1' });
    expect(await reconcileStopWidgets(database)).toBe(0);
  });

  it('reports a confirmed paused receipt without requeueing a replay', async () => {
    const stop = await service.queueCampaignStop(7, 19, ['google'], 'stop-one');
    await client.query("UPDATE pg_temp.ad_action_queue SET status='succeeded', provider_outcome=$1::jsonb WHERE id=$2", [JSON.stringify({ status: 'paused', providerPauseConfirmed: true }), stop.platforms[0].actionId]);
    expect((await service.queueCampaignStop(7, 19, ['google'], 'stop-one')).platforms[0]).toMatchObject({ status: 'paused', providerPauseConfirmed: true, replayed: true });
  });

  it('returns an active receipt after the draft changes and current gates are disabled', async () => {
    const first = await service.queueExistingCampaignPlatform(7, 19, 'google', 'approval-one', fixture.review.revision);
    await client.query("UPDATE pg_temp.ad_action_queue SET status='succeeded', provider_outcome=$1::jsonb", [JSON.stringify({ activated: true })]);
    await client.query('UPDATE pg_temp.performance_ad_campaigns SET budget_amount=999');
    await client.query('UPDATE pg_temp.ad_settings SET live_provider_mutations_enabled=false');
    process.env.AD_PROVIDER_MUTATIONS_ENABLED = 'false';
    readiness.mockClear();
    const replay = await service.queueExistingCampaignPlatform(7, 19, 'google', 'approval-one', fixture.review.revision);
    expect(replay).toEqual(expect.objectContaining({ status: 'active', actionId: first.actionId, replayed: true }));
    expect(readiness).not.toHaveBeenCalled();
  });

  it('rejects a changed draft for a new approval before saving any action', async () => {
    await client.query('UPDATE pg_temp.performance_ad_campaigns SET budget_amount=999');
    await expect(service.queueExistingCampaignPlatform(7, 19, 'meta', 'new-approval', fixture.review.revision)).rejects.toThrow('changed after review');
    expect((await client.query('SELECT * FROM pg_temp.ad_action_queue')).rows).toHaveLength(0);
  });

  it('returns a typed gated outcome and does not call provider readiness', async () => {
    process.env.AD_PROVIDER_MUTATIONS_ENABLED = 'false';
    await expect(service.queueExistingCampaignPlatform(7, 19, 'meta', 'approval-one', fixture.review.revision)).rejects.toEqual(expect.objectContaining({ status: 'gated' }));
    expect(readiness).not.toHaveBeenCalled();
    expect((await client.query('SELECT * FROM pg_temp.ad_action_queue')).rows).toHaveLength(0);
  });

  it('cannot replay another tenant’s action', async () => {
    await service.queueExistingCampaignPlatform(7, 19, 'meta', 'approval-one', fixture.review.revision);
    await expect(service.queueExistingCampaignPlatform(8, 19, 'meta', 'approval-one', fixture.review.revision)).rejects.toThrow('Campaign not found');
  });

  it('a cancelled worker cannot mark activation or overwrite cancellation with failure', async () => {
    const queued = await service.queueExistingCampaignPlatform(7, 19, 'meta', 'approval-one', fixture.review.revision);
    const lockedAt = new Date();
    await client.query("UPDATE pg_temp.ad_action_queue SET status='processing', locked_by='old-worker', locked_at=$1", [lockedAt]);
    const action = (await client.query('SELECT * FROM pg_temp.ad_action_queue WHERE id=$1', [queued.actionId])).rows[0];
    await client.query("UPDATE pg_temp.ad_action_queue SET status='cancelled', last_error='Client stopped launch'");
    await expect(worker.markActivationRequested(action)).rejects.toThrow('cancelled');
    await worker.fail({ ...action, attempts: 1, max_attempts: 4 }, 'Late provider error');
    const current = (await client.query('SELECT * FROM pg_temp.ad_action_queue')).rows[0];
    expect(current.status).toBe('cancelled');
    expect(current.last_error).toBe('Client stopped launch');
    expect(current.provider_outcome).toBeNull();
  });

  it('a reclaimed lease rejects the old worker even when the worker name is reused', async () => {
    const queued = await service.queueExistingCampaignPlatform(7, 19, 'meta', 'approval-one', fixture.review.revision);
    await client.query("UPDATE pg_temp.ad_action_queue SET status='processing', locked_by='same-process', locked_at=$1", [new Date()]);
    const old = (await client.query('SELECT * FROM pg_temp.ad_action_queue WHERE id=$1', [queued.actionId])).rows[0];
    await client.query("UPDATE pg_temp.ad_action_queue SET locked_at=locked_at + INTERVAL '1 second'");
    await expect(worker.markPublishMutationStarted(old)).rejects.toThrow('worker lease changed');
    expect((await client.query('SELECT payload FROM pg_temp.ad_action_queue')).rows[0].payload.providerMutationStarted).toBeUndefined();
  });

  it('preserves PostgreSQL microseconds in a valid claim token', async () => {
    const queued = await service.queueExistingCampaignPlatform(7, 19, 'meta', 'approval-one', fixture.review.revision);
    await client.query("UPDATE pg_temp.ad_action_queue SET status='processing', locked_by='worker', locked_at='2026-09-05T00:00:00.123456Z'");
    const claimed = (await client.query('SELECT *, locked_at::text AS lease_locked_at FROM pg_temp.ad_action_queue WHERE id=$1', [queued.actionId])).rows[0];
    await worker.markPublishMutationStarted(claimed);
    expect((await client.query('SELECT payload FROM pg_temp.ad_action_queue')).rows[0].payload.providerMutationStarted).toBe(true);
    await client.query("UPDATE pg_temp.ad_action_queue SET locked_at=locked_at + INTERVAL '1 microsecond'");
    await expect(worker.markActivationRequested(claimed)).rejects.toThrow('worker lease changed');
  });

  it('does not let a superseded failure poison a successful retry on the same platform', async () => {
    const first = await service.queueExistingCampaignPlatform(7, 19, 'meta', 'approval-one', fixture.review.revision);
    await client.query("UPDATE pg_temp.ad_action_queue SET status='failed', last_error='First attempt rejected' WHERE id=$1", [first.actionId]);
    const retry = await service.queueExistingCampaignPlatform(7, 19, 'meta', 'approval-two', fixture.review.revision);
    const action = (await client.query('SELECT * FROM pg_temp.ad_action_queue WHERE id=$1', [retry.actionId])).rows[0];
    await worker.updateLocalPublished(action, 'active', 'ACTIVE');
    const campaign = (await client.query('SELECT * FROM pg_temp.performance_ad_campaigns')).rows[0];
    expect(campaign).toEqual(expect.objectContaining({ local_status: 'active', status: 'active', is_active: true, provider_status: 'ACTIVE' }));
    expect((await client.query('SELECT status, last_error FROM pg_temp.ad_action_queue WHERE id=$1', [first.actionId])).rows[0])
      .toEqual({ status: 'failed', last_error: 'First attempt rejected' });
  });

  it('still considers the latest pending action on another platform', async () => {
    const meta = await service.queueExistingCampaignPlatform(7, 19, 'meta', 'approval-one', fixture.review.revision);
    await service.queueExistingCampaignPlatform(7, 19, 'google', 'approval-one', fixture.review.revision);
    const action = (await client.query('SELECT * FROM pg_temp.ad_action_queue WHERE id=$1', [meta.actionId])).rows[0];
    await worker.updateLocalPublished(action, 'active', 'ACTIVE');
    expect((await client.query('SELECT local_status FROM pg_temp.performance_ad_campaigns')).rows[0].local_status).toBe('running');
  });

  it.each(['failure-first', 'success-first'])('preserves visible partial activation with %s completion order', async order => {
    const meta = await service.queueExistingCampaignPlatform(7, 19, 'meta', 'approval-one', fixture.review.revision);
    const google = await service.queueExistingCampaignPlatform(7, 19, 'google', 'approval-one', fixture.review.revision);
    const metaAction = (await client.query('SELECT * FROM pg_temp.ad_action_queue WHERE id=$1', [meta.actionId])).rows[0];
    await client.query("UPDATE pg_temp.ad_action_queue SET status='processing', locked_by='test-worker', locked_at=$1 WHERE id=$2", [new Date(), google.actionId]);
    const googleAction = (await client.query('SELECT *, locked_at::text AS lease_locked_at FROM pg_temp.ad_action_queue WHERE id=$1', [google.actionId])).rows[0];
    const failGoogle = () => worker.fail({ ...googleAction, attempts: 4, max_attempts: 4 }, 'Google activation rejected');
    const succeedMeta = () => worker.updateLocalPublished(metaAction, 'active', 'ACTIVE');
    if (order === 'failure-first') { await failGoogle(); await succeedMeta(); }
    else { await succeedMeta(); await failGoogle(); }
    const campaign = (await client.query('SELECT * FROM pg_temp.performance_ad_campaigns')).rows[0];
    expect(campaign.local_status).toBe('partial_success');
    expect(campaign.status).toBe('partial_success');
    expect(campaign.is_active).toBe(true);
    expect(campaign.launched_at).not.toBeNull();
    expect(campaign.last_provider_error).toContain('Google activation rejected');
    expect((await client.query("SELECT status FROM pg_temp.ad_campaign_allocations WHERE platform='meta'")).rows[0].status).toBe('active');
  });

  it('preserves another active platform when an exhausted worker lease is recovered', async () => {
    await client.query("UPDATE pg_temp.performance_ad_campaigns SET status='active',local_status='active',is_active=true");
    await client.query("UPDATE pg_temp.ad_campaign_allocations SET status='active' WHERE platform='meta'");
    await client.query(`INSERT INTO pg_temp.ad_action_queue (campaign_id,user_id,platform,action_type,idempotency_key,status,attempts,max_attempts,locked_at,locked_by)
      VALUES(19,7,'google','publish','stale-google','processing',4,4,NOW()-INTERVAL '16 minutes','dead-worker')`);
    await worker.recoverStaleClaims();
    expect((await client.query('SELECT status,local_status,is_active FROM pg_temp.performance_ad_campaigns')).rows[0])
      .toEqual({ status: 'partial_success', local_status: 'partial_success', is_active: true });
    expect((await client.query('SELECT platform,status FROM pg_temp.ad_campaign_allocations ORDER BY platform')).rows)
      .toEqual([{ platform: 'google', status: 'provider_failed' }, { platform: 'meta', status: 'active' }]);
  });

  it('keeps a granular pause lease failure scoped to the target instead of failing its campaign', async () => {
    await client.query("UPDATE pg_temp.performance_ad_campaigns SET status='active',local_status='active',is_active=true");
    await client.query("UPDATE pg_temp.ad_campaign_allocations SET status='active'");
    await client.query("INSERT INTO pg_temp.ad_provider_resources(campaign_id,user_id,platform,resource_type,local_key,status) VALUES(19,7,'meta','ad','ad-1','active')");
    await client.query(`INSERT INTO pg_temp.ad_action_queue (campaign_id,user_id,platform,action_type,idempotency_key,status,attempts,max_attempts,locked_at,locked_by,evaluation_id,target_type,target_key)
      VALUES(19,7,'meta','pause','stale-ad-pause','processing',4,4,NOW()-INTERVAL '16 minutes','dead-worker',91,'ad','ad-1')`);
    await worker.recoverStaleClaims();
    expect((await client.query('SELECT status,local_status,is_active FROM pg_temp.performance_ad_campaigns')).rows[0])
      .toEqual({ status: 'active', local_status: 'active', is_active: true });
    expect((await client.query("SELECT COUNT(*)::int AS count FROM pg_temp.ad_campaign_allocations WHERE status='active'")).rows[0].count).toBe(2);
    expect((await client.query('SELECT error FROM pg_temp.ad_provider_resources')).rows[0].error).toMatch(/lease expired/);
  });

  it('does not report the entire campaign paused when only one provider was stopped', async () => {
    await client.query("UPDATE pg_temp.performance_ad_campaigns SET status='active',local_status='active',provider_status='ACTIVE',is_active=true");
    await client.query("UPDATE pg_temp.ad_campaign_allocations SET status='active'");
    await worker.updateLocalPublished({ id: 99, campaign_id: 19, user_id: 7, platform: 'google', action_type: 'pause' }, 'paused', 'PAUSED');
    expect((await client.query('SELECT status,local_status,provider_status,is_active FROM pg_temp.performance_ad_campaigns')).rows[0])
      .toEqual({ status: 'active', local_status: 'active', provider_status: 'ACTIVE', is_active: true });
    expect((await client.query('SELECT platform,status FROM pg_temp.ad_campaign_allocations ORDER BY platform')).rows)
      .toEqual([{ platform: 'google', status: 'paused' }, { platform: 'meta', status: 'active' }]);
    await worker.updateLocalPublished({ id: 100, campaign_id: 19, user_id: 7, platform: 'meta', action_type: 'pause' }, 'paused', 'PAUSED');
    expect((await client.query('SELECT status,local_status,provider_status,is_active FROM pg_temp.performance_ad_campaigns')).rows[0])
      .toEqual({ status: 'paused', local_status: 'paused', provider_status: 'PAUSED', is_active: false });
  });

  it('publishes and activates both fake providers through real durable actions, then stops each independently', async () => {
    for (const platform of ['meta','google'] as const) await service.queueExistingCampaignPlatform(7,19,platform,'journey-review',fixture.review.revision);
    for (let index=0; index<2; index++) { const action=await worker.claim(); expect(action).not.toBeNull(); await worker.processAction(action); }
    expect((await client.query("SELECT COUNT(*)::int AS count FROM ad_action_queue WHERE status='succeeded'")).rows[0].count).toBe(2);
    expect((await client.query('SELECT local_status,is_active FROM performance_ad_campaigns')).rows[0]).toEqual({local_status:'active',is_active:true});
    expect(metaCreate).toHaveBeenCalledTimes(1); expect(googleCreate).toHaveBeenCalledTimes(1);
    const metaStop=await service.queueCampaignStop(7,19,['meta'],'journey-stop-meta');
    await worker.processAction(await worker.claim());
    expect((await service.queueCampaignStop(7,19,['meta'],'journey-stop-meta')).platforms[0]).toMatchObject({actionId:metaStop.platforms[0].actionId,status:'paused',providerPauseConfirmed:true,replayed:true});
    expect((await client.query('SELECT local_status,is_active FROM performance_ad_campaigns')).rows[0]).toEqual({local_status:'active',is_active:true});
    await service.queueCampaignStop(7,19,['google'],'journey-stop-google');
    await worker.processAction(await worker.claim());
    expect((await client.query('SELECT local_status,is_active FROM performance_ad_campaigns')).rows[0]).toEqual({local_status:'paused',is_active:false});
    expect((await client.query('SELECT COUNT(*)::int AS count FROM ad_action_audit')).rows[0].count).toBeGreaterThanOrEqual(8);
  });

  it('retains partial-provider activation and retries the same resource graph without duplicate creation', async () => {
    for (const platform of ['meta','google'] as const) await service.queueExistingCampaignPlatform(7,19,platform,'partial-review',fixture.review.revision);
    await worker.processAction(await worker.claim());
    googleStatus.mockResolvedValueOnce({success:false,error:'Synthetic Google activation rejection'});
    const failed=await worker.claim();
    await expect(worker.processAction(failed)).rejects.toThrow(/activation did not complete/);
    await worker.fail(failed,'Synthetic Google activation rejection');
    expect((await client.query('SELECT local_status,is_active FROM performance_ad_campaigns')).rows[0]).toEqual({local_status:'partial_success',is_active:true});
    expect((await client.query('SELECT provider_outcome FROM ad_action_queue WHERE id=$1',[failed.id])).rows[0].provider_outcome).toMatchObject({providerCreationComplete:true,safelyPaused:true});
    await client.query('UPDATE ad_action_queue SET available_at=NOW() WHERE id=$1',[failed.id]);
    const retry=await worker.claim(); expect(retry.id).toBe(failed.id);
    await worker.processAction(retry);
    expect(googleCreate).toHaveBeenCalledTimes(1);
    expect((await client.query('SELECT local_status,is_active FROM performance_ad_campaigns')).rows[0]).toEqual({local_status:'active',is_active:true});
  });

  it('fails an expired durable approval before reaching either fake provider', async () => {
    const queued=await service.queueExistingCampaignPlatform(7,19,'meta','expired-review',fixture.review.revision);
    await client.query("UPDATE ad_action_queue SET payload=jsonb_set(payload,'{approvedReview,approvedAt}','\"2000-01-01T00:00:00Z\"'::jsonb) WHERE id=$1",[queued.actionId]);
    const action=await worker.claim(); await expect(worker.processAction(action)).rejects.toThrow(/expired/);
    await worker.fail(action,'Approval expired');
    expect((await client.query('SELECT status FROM ad_action_queue WHERE id=$1',[queued.actionId])).rows[0].status).toBe('failed');
    expect(metaCreate).not.toHaveBeenCalled(); expect(googleCreate).not.toHaveBeenCalled();
  });

  it('rolls back claim recovery if its campaign reconciliation cannot persist', async () => {
    await client.query(`INSERT INTO ad_action_queue(campaign_id,user_id,platform,action_type,status,attempts,max_attempts,locked_at,locked_by)
      VALUES(19,7,'google','publish','processing',4,4,NOW()-INTERVAL '16 minutes','dead-worker');
      CREATE FUNCTION pg_temp.reject_ads_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic reconciliation failure'; END $$;
      CREATE TRIGGER reject_ads_recovery BEFORE UPDATE ON performance_ad_campaigns FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_ads_recovery();`);
    try {
      await expect(worker.recoverStaleClaims()).rejects.toThrow();
      expect((await client.query('SELECT status,locked_by FROM ad_action_queue')).rows[0]).toEqual({status:'processing',locked_by:'dead-worker'});
    } finally { await client.query('DROP TRIGGER reject_ads_recovery ON performance_ad_campaigns; DROP FUNCTION pg_temp.reject_ads_recovery()'); }
  });
});

describePostgres('ad worker concurrency on independent PostgreSQL connections', () => {
  const schema = `ads_concurrency_${process.pid}`;
  let pool: Pool;
  let admin: Client;
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Explicit local PostgreSQL is required.');
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema},pg_catalog`);
    await admin.query(`
      CREATE TABLE performance_ad_campaigns(id integer PRIMARY KEY,user_id integer,status text,local_status text,provider_status text,is_active boolean,launched_at timestamptz,last_provider_error text,updated_at timestamptz);
      CREATE TABLE ad_campaign_allocations(id serial PRIMARY KEY,campaign_id integer,user_id integer,platform text,status text,updated_at timestamptz);
      CREATE TABLE ad_action_queue(id serial PRIMARY KEY,campaign_id integer,user_id integer,platform text,action_type text,status text,attempts integer DEFAULT 0,max_attempts integer DEFAULT 4,locked_at timestamptz,locked_by text,available_at timestamptz,updated_at timestamptz,last_error text);
      CREATE FUNCTION overlap_platform_updates() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.05); RETURN NEW; END $$;
      CREATE TRIGGER overlap_updates BEFORE UPDATE ON ad_campaign_allocations FOR EACH ROW EXECUTE FUNCTION overlap_platform_updates();
    `);
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema},pg_catalog` });
    database = drizzle(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE ad_action_queue,ad_campaign_allocations,performance_ad_campaigns RESTART IDENTITY');
    await pool.query("INSERT INTO performance_ad_campaigns(id,user_id,status,local_status,provider_status,is_active) VALUES(19,7,'active','active','ACTIVE',true)");
    await pool.query("INSERT INTO ad_campaign_allocations(campaign_id,user_id,platform,status) VALUES(19,7,'meta','active'),(19,7,'google','active')");
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it('claims each due action once across eight concurrent connections and leaves delayed work pending', async () => {
    await pool.query("INSERT INTO ad_action_queue(campaign_id,user_id,platform,action_type,status,available_at) SELECT 19,7,'meta','pause','pending',NOW()-INTERVAL '1 second' FROM generate_series(1,8)");
    await pool.query("INSERT INTO ad_action_queue(campaign_id,user_id,platform,action_type,status,available_at) VALUES(19,7,'google','publish','pending',NOW()+INTERVAL '1 hour')");
    const claims = (await Promise.all(Array.from({ length: 12 }, () => worker.claim()))).filter(Boolean);
    expect(claims).toHaveLength(8);
    expect(new Set(claims.map((row: any) => row.id)).size).toBe(8);
    expect(claims.every((row: any) => row.attempts === 1 && typeof row.lease_locked_at === 'string')).toBe(true);
    expect((await pool.query("SELECT status,attempts FROM ad_action_queue WHERE platform='google'")).rows[0]).toEqual({ status: 'pending', attempts: 0 });
  });

  it('skips a row locked by another transaction without waiting or double claiming it', async () => {
    await pool.query("INSERT INTO ad_action_queue(campaign_id,user_id,platform,action_type,status,available_at) VALUES(19,7,'meta','pause','pending',NOW()),(19,7,'google','pause','pending',NOW())");
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM ad_action_queue WHERE id=1 FOR UPDATE');
      const claimed = await worker.claim();
      expect(claimed.id).toBe(2);
      expect(await worker.claim()).toBeNull();
      await blocker.query('COMMIT');
      expect((await worker.claim()).id).toBe(1);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });

  it('reconciles simultaneous provider stops to paused only after both active allocations stop', async () => {
    await Promise.all(['meta', 'google'].map((platform, index) => worker.updateLocalPublished({ id: 90 + index, campaign_id: 19, user_id: 7, platform, action_type: 'pause' }, 'paused', 'PAUSED')));
    expect((await pool.query('SELECT status,local_status,provider_status,is_active FROM performance_ad_campaigns')).rows[0])
      .toEqual({ status: 'paused', local_status: 'paused', provider_status: 'PAUSED', is_active: false });
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM ad_campaign_allocations WHERE status='paused'")).rows[0].count).toBe(2);
  });
});
