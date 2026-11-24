import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { assertBusinessScopeSchema } from '../tenancy/schemaGuard.js';

// Opt-in only. Requires the existing migrations in a dedicated disposable DB.
// Never load application .env files or infer a DSN from the environment.
const suite = process.env.LEAD_DISCOVERY_LOCAL_QA === '1' ? describe : describe.skip;
async function billingEvidence(kind: string, observation: Record<string, unknown>) {
  console.info(`SYNTHETIC_${kind}`, JSON.stringify(observation));
  const path = process.env.LEAD_DISCOVERY_BILLING_EVIDENCE;
  if (path) {
    if (!path.startsWith('/workspace/lead-discovery-publication-evidence/')) throw new Error('Use the local publication evidence directory');
    await appendFile(path, `${JSON.stringify({ kind, ...observation })}\n`);
  }
}
let fixtureDb: ReturnType<typeof drizzle>;
const databaseProxy = new Proxy({}, {
  get: (_target, key) => (...args: unknown[]) => Reflect.get(fixtureDb, key).apply(fixtureDb, args),
});
jest.unstable_mockModule('../models/db.js', () => ({ db: databaseProxy }));
const actor = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
const crawler = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
jest.unstable_mockModule('../services/agents/ApifyService.js', () => ({
  ApifyService: { createWithAdminCredentials: async () => ({ runActor: actor }) },
}));
jest.unstable_mockModule('../services/WebsiteCrawlerService.js', () => ({
  WebsiteCrawlerService: class { crawl = crawler; },
}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: { createProviderForUser: async () => { throw new Error('No synthetic LLM configured'); } },
}));
const { default: enrichmentRouter } = await import('../routes/enrichments.routes.js');
const { generateToken } = await import('../utils/jwt.js');
const { closeRedisConnections, getRedisConnection } = await import('../infrastructure/redis.js');
const { SmartThrottlingService } = await import('../services/SmartThrottlingService.js');
const runs = await import('../models/enrichmentRuns/functions.js');
const providerRuns = await import('../models/leadGenerationProviderRuns/functions.js');
const { eventBus } = await import('../events/EventBus.js');
const { authenticateToken } = await import('../middleware/auth.js');
const { getIcpHandler, updateIcpHandler } = await import('../controllers/icpController.js');
const { createIcpData } = await import('../models/icpData/functions.js');
// @ts-expect-error -- Existing migration modules are JavaScript.
const identifierMigration = await import('../migrations/530_widen_enrichment_source_identifiers.js');
// @ts-expect-error -- Existing migration modules are JavaScript.
const receiptMigration = await import('../migrations/531_enrichment_credit_receipts.js');

suite('lead discovery audit: real PostgreSQL/RLS/auth/HTTP/Redis, synthetic providers', () => {
  let admin: Pool;
  let scoped: Pool;
  let owner: number;
  let outsider: number;
  let north: number;
  let south: number;
  let token: string;
  let outsiderToken: string;
  let organization: number;
  let app: express.Express;
  const business = <T>(profile: number, work: () => T) => withBusinessScope({ userId: owner, businessProfileId: profile }, work);
  const get = (path: string, profile = north) => request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Business-Profile-Id', String(profile));
  const post = (body: Record<string, unknown>, key = randomUUID()) => request(app).post('/api/enrichments/by-handle').set('Authorization', `Bearer ${token}`).set('X-Business-Profile-Id', String(north)).set('Idempotency-Key', key).send(body);
  const terminal = async (id: number) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const row = (await admin.query('SELECT * FROM enrichment_runs WHERE id=$1', [id])).rows[0];
      if (['completed', 'failed'].includes(row?.status)) {
        // Completion is emitted after the write; drain the remaining microtasks.
        await new Promise(resolve => setTimeout(resolve, 30));
        return row;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Synthetic enrichment ${id} never reached a terminal state`);
  };
  const priced = async (balance: number, work: () => Promise<void>) => {
    await admin.query("INSERT INTO credit_pricing(event_key,name,category,credits_per_unit,is_active) VALUES('lead_enrichment','Synthetic enrichment cost','lead',5,true)");
    await admin.query('UPDATE wallets SET balance=$1 WHERE organization_id=$2', [balance, organization]);
    try { await work(); } finally { await admin.query("DELETE FROM credit_pricing WHERE event_key='lead_enrichment'"); }
  };

  beforeAll(async () => {
    if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_NAME !== 'lead_audit'
      || process.env.DB_PORT !== '55432' || process.env.REDIS_HOST !== '127.0.0.1'
      || process.env.REDIS_PORT !== '56379') throw new Error('Use only the disposable lead-audit containers');
    admin = new Pool({ host: '127.0.0.1', port: 55432, database: 'lead_audit', user: 'lead_audit', password: 'disposable_fixture', max: 2 });
    await assertBusinessScopeSchema(admin);
    scoped = createBusinessScopedPool(new Pool({ host: '127.0.0.1', port: 55432, database: 'lead_audit', user: 'lead_audit', password: 'disposable_fixture', max: 6 }));
    fixtureDb = drizzle(scoped);
    const suffix = randomUUID();
    const users = await admin.query("INSERT INTO users(email,password,name,is_approved,is_setup_complete) VALUES($1,'synthetic','Discovery owner',true,true),($2,'synthetic','Discovery outsider',true,true) RETURNING id", [`discovery-${suffix}@example.invalid`, `outsider-${suffix}@example.invalid`]);
    [owner, outsider] = users.rows.map(row => row.id);
    const profiles = await admin.query("INSERT INTO company_settings(user_id,name,is_default) VALUES($1,'Discovery North',true),($1,'Discovery South',false) RETURNING id", [owner]);
    [north, south] = profiles.rows.map(row => row.id);
    await admin.query("INSERT INTO company_settings(user_id,name,is_default) VALUES($1,'Discovery Other',true)", [outsider]);
    organization = (await admin.query('SELECT billing_organization_id FROM company_settings WHERE id=$1', [north])).rows[0].billing_organization_id;
    await admin.query('INSERT INTO wallets(user_id,organization_id,balance) VALUES($1,$2,1000) ON CONFLICT(organization_id) DO UPDATE SET balance=1000', [owner, organization]);
    token = generateToken({ userId: owner, email: `discovery-${suffix}@example.invalid` });
    outsiderToken = generateToken({ userId: outsider, email: `outsider-${suffix}@example.invalid` });
    expect(await getRedisConnection().ping()).toBe('PONG');
    app = express();
    app.use(express.json());
    app.use('/api/enrichments', enrichmentRouter);
    app.get('/api/icp/profile/:id', authenticateToken, getIcpHandler);
    app.put('/api/icp/:id', authenticateToken, updateIcpHandler);
  }, 30000);
  beforeEach(async () => {
    actor.mockReset().mockResolvedValue({ success: true, items: [], runId: 'synthetic-provider-run', datasetId: 'synthetic-dataset' });
    crawler.mockReset().mockResolvedValue({ pages: [], combinedContent: '' });
    await admin.query('UPDATE wallets SET balance=1000 WHERE organization_id=$1', [organization]);
    await admin.query("DELETE FROM user_module_access WHERE user_id=$1 AND module_key='lead_generation'", [owner]);
  });
  afterAll(async () => {
    SmartThrottlingService.getInstance().destroy();
    await closeRedisConnections();
    await scoped?.end();
    await admin?.end();
  });

  it('requires an actual user session and rejects another account selecting the profile', async () => {
    expect((await request(app).get('/api/enrichments')).status).toBe(401);
    expect((await request(app).get('/api/enrichments').set('Authorization', `Bearer ${outsiderToken}`).set('X-Business-Profile-Id', String(north))).status).toBe(403);
    expect(actor).not.toHaveBeenCalled();
  });
  it('lists and opens only the selected business, with ordered persisted steps', async () => {
    const run = await business(north, () => runs.createEnrichmentRun({ userId: owner, leadName: 'Synthetic North' }));
    await business(north, () => scoped.query("INSERT INTO enrichment_steps(run_id,step_number,step_type,status) VALUES($1,2,'handle_discovery','completed'),($1,1,'actor_run','completed')", [run.id]));
    const response = await get(`/api/enrichments/${run.id}`);
    expect(response.status).toBe(200);
    expect(response.body.data.steps.map((step: { stepNumber: number }) => step.stepNumber)).toEqual([1, 2]);
    expect((await get(`/api/enrichments/${run.id}`, south)).status).toBe(404);
    expect((await get('/api/enrichments', south)).body.data).toEqual([]);
  });
  it('saves ICP configuration, invalidates prior approval, and isolates the updated profile', async () => {
    const icp = await business(north, () => createIcpData({ userId: owner, businessId: north, campaignName: 'Synthetic ICP', industry: 'Software', primaryChannels: ['LinkedIn'], approved: true, revision: 1, approvedRevision: 1 }));
    const changed = await request(app).put(`/api/icp/${icp.id}`).set('Authorization', `Bearer ${token}`).set('X-Business-Profile-Id', String(north))
      .send({ campaignName: 'Synthetic revised ICP', primaryRegions: ['Canada'], primaryJobTitles: ['Founder'], approved: true, approvedRevision: 99, revision: 99 });
    expect(changed.status).toBe(200);
    expect(changed.body.icp).toEqual(expect.objectContaining({ campaignName: 'Synthetic revised ICP', primaryRegions: ['Canada'], primaryJobTitles: ['Founder'], approved: false, approvedRevision: null, revision: 2 }));
    expect((await get(`/api/icp/profile/${icp.id}`)).body.campaignName).toBe('Synthetic revised ICP');
    expect((await get(`/api/icp/profile/${icp.id}`, south)).status).toBe(404);
    const retired = await request(app).put(`/api/icp/${icp.id}`).set('Authorization', `Bearer ${token}`).set('X-Business-Profile-Id', String(north)).send({ primaryChannels: ['Yelp'] });
    expect(retired.status).toBe(400);
    expect(actor).not.toHaveBeenCalled();
  });
  it('blocks disabled module and empty-wallet mutation before starting a provider', async () => {
    await admin.query("INSERT INTO user_module_access(user_id,module_key,is_enabled) VALUES($1,'lead_generation',false)", [owner]);
    expect((await post({ platform: 'twitter', identifier: 'synthetic_subject' })).status).toBe(403);
    await admin.query("DELETE FROM user_module_access WHERE user_id=$1 AND module_key='lead_generation'", [owner]);
    await admin.query('UPDATE wallets SET balance=0 WHERE organization_id=$1', [organization]);
    expect((await post({ platform: 'twitter', identifier: 'synthetic_subject' })).status).toBe(402);
    expect(actor).not.toHaveBeenCalled();
  });
  it('refuses enrichment when the positive balance cannot cover its configured cost', async () => {
    const existing = await admin.query("SELECT id FROM credit_pricing WHERE event_key='lead_enrichment'");
    if (existing.rowCount) throw new Error('Use a fresh disposable fixture without enrichment pricing');
    await admin.query("INSERT INTO credit_pricing(event_key,name,category,credits_per_unit,is_active) VALUES('lead_enrichment','Synthetic enrichment cost','lead',5,true)");
    const { creditService } = await import('../services/CreditService.js');
    const deduct = creditService.deductForEvent.bind(creditService);
    const deductionResults: Awaited<ReturnType<typeof deduct>>[] = [];
    const deductionSpy = jest.spyOn(creditService, 'deductForEvent').mockImplementation(async options => {
      const result = await deduct(options);
      deductionResults.push(result);
      return result;
    });
    const reservationSpy = jest.spyOn(creditService, 'reserveForResource');
    try {
      await admin.query('UPDATE wallets SET balance=1 WHERE organization_id=$1', [organization]);
      const transactionsBefore = Number((await admin.query('SELECT count(*) FROM wallet_transactions WHERE organization_id=$1', [organization])).rows[0].count);
      const resourcesBefore = (await admin.query('SELECT (SELECT count(*) FROM enrichment_runs WHERE user_id=$1) AS runs,(SELECT count(*) FROM leads WHERE user_id=$1) AS leads', [owner])).rows[0];
      const response = await post({ platform: 'twitter', identifier: 'synthetic_credit_denial' });
      if (response.body.data?.runId) await terminal(response.body.data.runId);
      const balanceAfter = Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [organization])).rows[0].balance);
      const transactionsAfter = Number((await admin.query('SELECT count(*) FROM wallet_transactions WHERE organization_id=$1', [organization])).rows[0].count);
      const reserveCall = reservationSpy.mock.results[0];
      const reservationResult = reserveCall?.type === 'return' ? await reserveCall.value : undefined;
      const observation = {
        configuredCost: 5, balanceBefore: 1, balanceAfter, deductionResults,
        reservationCalls: reservationSpy.mock.calls.length,
        reservationResult: reservationResult ? { success: reservationResult.success, creditsDeducted: reservationResult.creditsDeducted, balanceAfter: reservationResult.balanceAfter, error: reservationResult.error } : null,
        newWalletTransactions: transactionsAfter - transactionsBefore,
        status: response.status, providerCalls: actor.mock.calls.length,
      };
      await billingEvidence('CREDIT_REPRO', observation);
      expect({ status: response.status, providerCalls: actor.mock.calls.length, reservationCalls: reservationSpy.mock.calls.length }).toEqual({ status: 402, providerCalls: 0, reservationCalls: 1 });
      expect(deductionResults).toEqual([]);
      expect(reservationResult).toEqual(expect.objectContaining({ success: false, creditsDeducted: 0, balanceAfter: 1 }));
      expect(balanceAfter).toBe(1);
      expect(transactionsAfter).toBe(transactionsBefore);
      expect((await admin.query('SELECT (SELECT count(*) FROM enrichment_runs WHERE user_id=$1) AS runs,(SELECT count(*) FROM leads WHERE user_id=$1) AS leads', [owner])).rows[0]).toEqual(resourcesBefore);
    } finally {
      deductionSpy.mockRestore();
      reservationSpy.mockRestore();
      await admin.query("DELETE FROM credit_pricing WHERE event_key='lead_enrichment'");
    }
  });
  it('reserves the fixed fee before provider IO, settles once, and replays at an exhausted balance without another call', async () => {
    await priced(5, async () => {
      const key = randomUUID();
      const body = { platform: 'twitter', identifier: 'synthetic_funded' };
      const balancesAtProvider: number[] = [];
      actor.mockImplementation(async () => {
        balancesAtProvider.push(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [organization])).rows[0].balance));
        return { success: true, items: [], runId: 'synthetic-funded-run', datasetId: 'synthetic-funded-dataset' };
      });
      const response = await post(body, key);
      expect(response.status).toBe(200);
      const row = await terminal(response.body.data.runId);
      expect(row.status).toBe('completed');
      expect(row.billing_status).toBe('settled');
      expect(Number(row.billing_credits)).toBe(5);
      expect(row.provider_dispatch_started_at).not.toBeNull();
      expect(balancesAtProvider).toEqual([0]);
      const ledger = await admin.query("SELECT type,amount FROM wallet_transactions WHERE organization_id=$1 AND (id=$2 OR reference_id=$3) ORDER BY id", [organization, row.billing_transaction_id, String(row.billing_transaction_id)]);
      expect(ledger.rows).toEqual([{ type: 'deduction', amount: '-5.00' }, { type: 'refund', amount: '0.00' }]);
      const replay = await post(body, key);
      expect(replay.status).toBe(200);
      expect(replay.body.data).toEqual(expect.objectContaining({ runId: row.id, replayed: true }));
      expect(actor).toHaveBeenCalledTimes(1);
      expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [organization])).rows[0].balance)).toBe(0);
      await billingEvidence('FUNDED_ENRICHMENT', { configuredCost: 5, balanceBefore: 5, balancesAtProvider, balanceAfter: 0, providerCalls: actor.mock.calls.length, replayStatus: replay.status, billingStatus: row.billing_status });
    });
  });
  it('claims and charges one durable request across concurrent HTTP starts and rejects changed inputs', async () => {
    await priced(20, async () => {
      const key = randomUUID();
      const body = { platform: 'twitter', identifier: 'synthetic_concurrent' };
      const responses = await Promise.all(Array.from({ length: 6 }, () => post(body, key)));
      expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
      const ids = new Set(responses.map(response => response.body.data.runId));
      expect(ids.size).toBe(1);
      const row = await terminal(responses[0].body.data.runId);
      expect(row.billing_status).toBe('settled');
      expect(actor).toHaveBeenCalledTimes(1);
      expect(Number((await admin.query("SELECT count(*) FROM wallet_transactions WHERE organization_id=$1 AND type='deduction' AND reference_type='enrichment_run' AND reference_id=$2", [organization, String(row.id)])).rows[0].count)).toBe(1);
      expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [organization])).rows[0].balance)).toBe(15);
      expect((await post({ ...body, identifier: 'different_subject' }, key)).status).toBe(409);
      expect(actor).toHaveBeenCalledTimes(1);
    });
  });
  it('scopes request keys to the selected business profile', async () => {
    await priced(20, async () => {
      const key = randomUUID(), body = { platform: 'twitter', identifier: 'synthetic_profile_scope' };
      const first = await post(body, key);
      await terminal(first.body.data.runId);
      const second = await request(app).post('/api/enrichments/by-handle').set('Authorization', `Bearer ${token}`).set('X-Business-Profile-Id', String(south)).set('Idempotency-Key', key).send(body);
      expect(second.status).toBe(200);
      expect(second.body.data.runId).not.toBe(first.body.data.runId);
      const row = await terminal(second.body.data.runId);
      expect(row.business_profile_id).toBe(south);
      expect(actor).toHaveBeenCalledTimes(2);
      expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [organization])).rows[0].balance)).toBe(10);
    });
  });
  it('does not misreport a generic reservation outage as insufficient funds or dispatch a provider', async () => {
    await priced(10, async () => {
      const { creditService } = await import('../services/CreditService.js');
      const reservation = jest.spyOn(creditService, 'reserveForResource').mockResolvedValue({ success: false, creditsDeducted: 0, balanceAfter: 0, error: 'Credit reservation error' });
      try {
        expect((await post({ platform: 'twitter', identifier: 'synthetic_reservation_outage' })).status).toBe(503);
        expect(actor).not.toHaveBeenCalled();
        expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [organization])).rows[0].balance)).toBe(10);
      } finally { reservation.mockRestore(); }
    });
  });
  it('releases the fixed fee when initialization fails before any provider dispatch', async () => {
    await priced(10, async () => {
      const { ApifyService } = await import('../services/agents/ApifyService.js');
      const factory = jest.spyOn(ApifyService, 'createWithAdminCredentials').mockRejectedValue(new Error('Synthetic initialization unavailable'));
      try {
        const key = randomUUID(), body = { platform: 'twitter', identifier: 'synthetic_unstarted' };
        const response = await post(body, key);
        expect(response.status).toBe(200);
        const row = await terminal(response.body.data.runId);
        expect(row.status).toBe('failed');
        expect(row.billing_status).toBe('released');
        expect(row.provider_dispatch_started_at).toBeNull();
        expect(actor).not.toHaveBeenCalled();
        expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [organization])).rows[0].balance)).toBe(10);
        expect((await post(body, key)).body.data.runId).toBe(row.id);
        expect(factory).toHaveBeenCalledTimes(1);
      } finally { factory.mockRestore(); }
    });
  });
  it('releases the fixed fee for an authoritative failed provider receipt without a blind retry', async () => {
    await priced(10, async () => {
      actor.mockResolvedValue({ success: false, status: 'FAILED', runId: 'synthetic-failed-run', items: [], error: 'Synthetic terminal failure' });
      const key = randomUUID(), body = { platform: 'twitter', identifier: 'synthetic_terminal_failure' };
      const response = await post(body, key);
      const row = await terminal(response.body.data.runId);
      expect(row.status).toBe('failed');
      expect(row.billing_status).toBe('released');
      expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [organization])).rows[0].balance)).toBe(10);
      expect((await post(body, key)).body.data.runId).toBe(row.id);
      expect(actor).toHaveBeenCalledTimes(1);
    });
  });
  it.each(['connection_lost', 'unidentified_failure'])('holds an ambiguous %s attempt for review and never dispatches it again on replay', async mode => {
    await priced(10, async () => {
      if (mode === 'connection_lost') actor.mockRejectedValue(new Error('Synthetic connection lost after dispatch'));
      else actor.mockResolvedValue({ success: false, status: 'FAILED', items: [], error: 'Synthetic failure without a provider receipt' });
      const key = randomUUID(), body = { platform: 'twitter', identifier: 'synthetic_uncertain' };
      const response = await post(body, key);
      const row = await terminal(response.body.data.runId);
      expect(row.status).toBe('failed');
      expect(row.billing_status).toBe('held');
      expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [organization])).rows[0].balance)).toBe(5);
      expect((await post(body, key)).body.data.runId).toBe(row.id);
      expect(actor).toHaveBeenCalledTimes(1);
      expect(Number((await admin.query("SELECT count(*) FROM wallet_transactions WHERE organization_id=$1 AND type='refund' AND reference_id=$2", [organization, String(row.billing_transaction_id)])).rows[0].count)).toBe(0);
    });
  });
  it('releases an unused reservation after a real SQL dispatch-receipt write failure', async () => {
    await priced(10, async () => {
      const key = randomUUID(), name = `enrichment_receipt_failure_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.request_key='${key}' AND NEW.billing_transaction_id IS NOT NULL THEN RAISE EXCEPTION 'Synthetic dispatch receipt write unavailable'; END IF;
        RETURN NEW; END $$;
        CREATE TRIGGER ${name} BEFORE UPDATE ON enrichment_runs FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      try {
        const body = { platform: 'twitter', identifier: 'synthetic_dispatch_write_failure' };
        const response = await post(body, key);
        expect(response.status).toBe(503);
        const row = (await admin.query('SELECT id,status,billing_status FROM enrichment_runs WHERE request_key=$1 AND user_id=$2', [key, owner])).rows[0];
        expect(row).toEqual(expect.objectContaining({ status: 'failed', billing_status: 'released' }));
        expect(actor).not.toHaveBeenCalled();
        expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [organization])).rows[0].balance)).toBe(10);
        expect((await post(body, key)).body.data.runId).toBe(row.id);
        expect(actor).not.toHaveBeenCalled();
      } finally {
        await admin.query(`DROP TRIGGER ${name} ON enrichment_runs; DROP FUNCTION ${name}()`);
      }
    });
  });
  it('does not release a completed provider fee when settlement itself is unavailable', async () => {
    await priced(10, async () => {
      const { creditService } = await import('../services/CreditService.js');
      const settle = jest.spyOn(creditService, 'settleReservation').mockResolvedValue({ success: false, creditsRefunded: 0, balanceAfter: 5, error: 'Synthetic settlement unavailable' });
      try {
        const response = await post({ platform: 'twitter', identifier: 'synthetic_settlement_failure' });
        const row = await terminal(response.body.data.runId);
        expect(row.billing_status).toBe('held');
        expect(row.status).toBe('failed');
        expect(settle).toHaveBeenCalledTimes(1);
        expect(settle).toHaveBeenCalledWith(expect.objectContaining({ actualCredits: 5 }));
        expect(actor).toHaveBeenCalledTimes(1);
        expect(Number((await admin.query('SELECT balance FROM wallets WHERE organization_id=$1', [organization])).rows[0].balance)).toBe(5);
      } finally { settle.mockRestore(); }
    });
  });
  it.each([{ platform: 'yelp', identifier: 'synthetic' }, { platform: 'twitter', identifier: '' }, { platform: 'twitter', identifier: 'ok', extra: true }])('rejects malformed source input: %j', async body => {
    expect((await post(body)).status).toBe(400);
    expect(actor).not.toHaveBeenCalled();
  });
  it('persists empty provider success and a completed step, visible after a fresh HTTP read', async () => {
    const response = await post({ platform: 'twitter', identifier: 'synthetic_empty' });
    expect(response.status).toBe(200);
    const row = await terminal(response.body.data.runId);
    expect(row.status).toBe('completed');
    expect(row.business_profile_id).toBe(north);
    const refreshed = await get(`/api/enrichments/${row.id}`);
    expect(refreshed.body.data.steps[0]).toEqual(expect.objectContaining({ status: 'completed', itemsCount: 0 }));
    expect(actor).toHaveBeenCalledTimes(1);
  });
  it('persists provider failures rather than reporting an empty success', async () => {
    actor.mockResolvedValue({ success: false, items: [], error: 'Synthetic provider unavailable' });
    const response = await post({ platform: 'twitter', identifier: 'synthetic_failure' });
    expect(response.status).toBe(200);
    const row = await terminal(response.body.data.runId);
    expect(row.status).toBe('failed');
    const refreshed = await get(`/api/enrichments/${row.id}`);
    expect(refreshed.body.data.steps[0].status).toBe('failed');
  });
  it.each([{ success: true, items: [] }, { success: false, items: [] }, { success: true, items: [{ name: 'Synthetic source' }] }])('retains standalone provider provenance for %j', async result => {
    actor.mockResolvedValue({ ...result, runId: 'synthetic-provider-run', datasetId: 'synthetic-dataset', error: result.success ? undefined : 'Synthetic failure' });
    const response = await post({ platform: 'twitter', identifier: 'synthetic_provenance' });
    expect(response.status).toBe(200);
    const row = await terminal(response.body.data.runId);
    const refreshed = await get(`/api/enrichments/${row.id}`);
    expect(refreshed.body.data.steps[0].output).toEqual(expect.objectContaining({ actorRunId: 'synthetic-provider-run', datasetId: 'synthetic-dataset' }));
  });
  it.each([{ items: [] }, { items: [{ name: 'Synthetic source' }] }])('retains deep enrichment provider provenance for %j', async ({ items }) => {
    actor.mockResolvedValue({ success: true, items, runId: 'synthetic-provider-run', datasetId: 'synthetic-dataset' });
    const { leadEnrichmentOrchestrator } = await import('../services/enrichment/index.js');
    await business(north, async () => {
      const leadId = (await scoped.query("INSERT INTO leads(uuid,user_id,name,twitter_handle,source,status) VALUES($1,$2,'Synthetic deep subject','synthetic_deep','synthetic','new') RETURNING id", [randomUUID(), owner])).rows[0].id;
      await leadEnrichmentOrchestrator.enrichLead(owner, leadId);
      const [run] = await runs.getEnrichmentRunsByLead(owner, leadId);
      const detail = await runs.getEnrichmentRunWithSteps(run.id);
      expect(detail?.steps[0].output).toEqual(expect.objectContaining({ actorRunId: 'synthetic-provider-run', datasetId: 'synthetic-dataset' }));
    });
  });
  it('rejects fractional pagination before querying PostgreSQL', async () => {
    const response = await get('/api/enrichments?limit=1.5&offset=0.5');
    expect(response.status).toBe(400);
  });
  it('rejects infinite pagination before querying PostgreSQL', async () => {
    expect((await get('/api/enrichments?offset=Infinity')).status).toBe(400);
  });
  it.each([300, 650, 2000])('accepts a website URL with %i path characters and retains its full source identifier', async length => {
    const identifier = `https://fixture.example.invalid/${'a'.repeat(length)}`;
    const response = await post({ platform: 'website', identifier });
    expect(response.status).toBe(200);
    const row = await terminal(response.body.data.runId);
    expect(row.status).toBe('failed'); // The synthetic crawler deliberately returns no pages.
    expect(row.lead_name).toBe(`website: ${identifier}`);
    const detail = await get(`/api/enrichments/${row.id}`);
    expect(detail.body.data.steps[0].identifier).toBe(identifier);
  });
  it('claims one durable provider receipt under concurrent requests and keeps provider provenance', async () => {
    const threadId = await business(north, async () => (await scoped.query("INSERT INTO chat_threads(user_id,title) VALUES($1,'Synthetic discovery') RETURNING id", [owner])).rows[0].id);
    const input = { userId: owner, threadId, executionId: `synthetic-${randomUUID()}`, idempotencyKey: `synthetic-${randomUUID()}`, platform: 'twitter', workflowId: 'synthetic-workflow', nodeKey: 'profile', actorId: 'synthetic/provider' };
    const results = await Promise.all(Array.from({ length: 8 }, () => business(north, () => providerRuns.claimLeadGenerationProviderRun(input))));
    expect(results.filter(value => value.created)).toHaveLength(1);
    expect(new Set(results.map(value => value.run.id)).size).toBe(1);
    await business(north, () => providerRuns.updateLeadGenerationProviderRun(results[0].run.id, { actorRunId: 'synthetic-run', datasetId: 'synthetic-dataset', status: 'succeeded_empty' }));
    const saved = await business(north, () => providerRuns.getLeadGenerationProviderRunsByExecution(input.executionId));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(expect.objectContaining({ actorRunId: 'synthetic-run', datasetId: 'synthetic-dataset', status: 'succeeded_empty' }));
    expect(await business(south, () => providerRuns.getLeadGenerationProviderRunsByExecution(input.executionId))).toEqual([]);
  });
  it('leases a stale microsecond heartbeat once, only for the exact approved input', async () => {
    const receipt = await business(north, async () => {
      const threadId = (await scoped.query("INSERT INTO chat_threads(user_id,title) VALUES($1,'Synthetic recovery') RETURNING id", [owner])).rows[0].id;
      const inputId = (await scoped.query("INSERT INTO lead_inputs(user_id,thread_id,platform,inputs) VALUES($1,$2,'twitter','{}') RETURNING id", [owner, threadId])).rows[0].id;
      const workflowId = `synthetic-${randomUUID()}`;
      await scoped.query('INSERT INTO conversation_workflow_runs(id,user_id,thread_id) VALUES($1,$2,$3)', [workflowId, owner, threadId]);
      await scoped.query("INSERT INTO lead_input_sets(id,run_id,user_id,thread_id,status,input_ids) VALUES($1,$2,$3,$4,'approved',$5)", [randomUUID(), workflowId, owner, threadId, JSON.stringify([inputId])]);
      const result = await providerRuns.claimLeadGenerationProviderRun({ userId: owner, threadId, leadInputId: inputId, executionId: workflowId, idempotencyKey: workflowId, platform: 'twitter', workflowId: 'synthetic-workflow', nodeKey: 'profile', actorId: 'synthetic/provider' });
      await scoped.query("UPDATE lead_generation_provider_runs SET heartbeat_at=TIMESTAMP '2020-01-01 00:00:00.123456' WHERE id=$1", [result.run.id]);
      return result.run;
    });
    const claimed = await Promise.all(Array.from({ length: 6 }, () => business(north, () => providerRuns.claimRecoverableLeadGenerationProviderRunsForThread(receipt.threadId, owner, new Date(Date.now() - 60000)))));
    expect(claimed.flat().map(value => value.id)).toEqual([receipt.id]);
    await business(north, async () => {
      await scoped.query("UPDATE lead_generation_provider_runs SET heartbeat_at=TIMESTAMP '2020-01-01' WHERE id=$1", [receipt.id]);
      await scoped.query("UPDATE lead_input_sets SET status='draft' WHERE thread_id=$1", [receipt.threadId]);
      expect(await providerRuns.claimRecoverableLeadGenerationProviderRunsForThread(receipt.threadId, owner, new Date())).toEqual([]);
    });
  });
  it('deduplicates provider batches, retains both source receipts, and hands the saved identity to CRM', async () => {
    const { WorkflowExecutorService } = await import('../services/WorkflowExecutorService.js');
    type PersistenceResult = { savedLeads: Array<{ id: number }>; duplicateLeads: Array<{ id: number }> };
    const persist = (WorkflowExecutorService as unknown as {
      persistReviewedLeadRecords: (records: Record<string, unknown>[], context: Record<string, unknown>, threadId: number) => Promise<PersistenceResult>;
    }).persistReviewedLeadRecords.bind(WorkflowExecutorService);
    await business(north, async () => {
      const threadId = (await scoped.query("INSERT INTO chat_threads(user_id,title) VALUES($1,'Synthetic deduplication') RETURNING id", [owner])).rows[0].id;
      const executionId = `synthetic-${randomUUID()}`;
      const context = {
        executionId, workflowId: 'synthetic-workflow', status: 'running', startTime: new Date(),
        nodesExecuted: new Map(), errors: [], logs: [], threadId, userId: owner, platform: 'google_maps',
        semanticLeadClassificationBudget: { remainingBatches: 0, remainingLeads: 0 }, persistedLeadCount: 0,
        providerMetrics: new Map(), countedLeadIds: new Set(),
      };
      const record = { userId: owner, name: 'Synthetic discovered contact', email: `${randomUUID()}@example.invalid`, phone: '+14155550123', source: 'google_maps', rawData: { synthetic: true } };
      const first = await persist([record], context, threadId);
      expect(first.savedLeads).toHaveLength(1);
      context.executionId = `synthetic-second-${randomUUID()}`;
      context.platform = 'linkedin';
      const second = await persist([record], context, threadId);
      expect(second.savedLeads).toHaveLength(0);
      expect(second.duplicateLeads.map(lead => lead.id)).toEqual([first.savedLeads[0].id]);
      const saved = (await scoped.query('SELECT campaign_data,raw_data FROM leads WHERE id=$1', [first.savedLeads[0].id])).rows[0];
      expect(saved.campaign_data.sourceReceipts).toHaveLength(2);
      expect(saved.raw_data._sourceRecords.map((source: { platform: string }) => source.platform)).toEqual(['google_maps', 'linkedin']);
      const contact = await scoped.query('SELECT lead_id,email FROM crm_contacts WHERE lead_id=$1', [first.savedLeads[0].id]);
      expect(contact.rows).toEqual([{ lead_id: first.savedLeads[0].id, email: record.email }]);
    });
  });
  it('records completion only after a fresh read can retrieve the terminal summary', async () => {
    const original = eventBus.emitToolEvent.bind(eventBus);
    const observations: string[] = [];
    const spy = jest.spyOn(eventBus, 'emitToolEvent').mockImplementation(async (phase, payload) => {
      if (phase === 'completed' && payload.toolName === 'handle_enrichment') {
        const id = (payload.data as { runId: number }).runId;
        observations.push((await admin.query('SELECT status FROM enrichment_runs WHERE id=$1', [id])).rows[0].status);
      }
      return original(phase, payload);
    });
    try {
      const response = await post({ platform: 'twitter', identifier: 'synthetic_order' });
      expect(response.status).toBe(200);
      await terminal(response.body.data.runId);
      expect(observations).toEqual(['completed']);
    } finally { spy.mockRestore(); }
  });
  it('repeats migration 530 safely and refuses a rollback that would truncate provenance', async () => {
    const client = await admin.connect();
    const schema = `enrichment_migration_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path="${schema}",pg_catalog`);
      await client.query('CREATE TABLE enrichment_runs(id SERIAL PRIMARY KEY,lead_name VARCHAR(255)); CREATE TABLE enrichment_steps(id SERIAL PRIMARY KEY,identifier VARCHAR(500))');
      await identifierMigration.up(client);
      await identifierMigration.up(client);
      const identifier = `https://fixture.example.invalid/${'a'.repeat(2000)}`;
      await client.query('INSERT INTO enrichment_runs(lead_name) VALUES($1);', [`website: ${identifier}`]);
      await client.query('INSERT INTO enrichment_steps(identifier) VALUES($1)', [identifier]);
      await client.query('SAVEPOINT before_guarded_rollback');
      await expect(identifierMigration.down(client)).rejects.toThrow('exceed the legacy limits');
      await client.query('ROLLBACK TO SAVEPOINT before_guarded_rollback');
      expect((await client.query('SELECT identifier FROM enrichment_steps')).rows[0].identifier).toBe(identifier);
      await client.query('DELETE FROM enrichment_runs; DELETE FROM enrichment_steps');
      await identifierMigration.down(client);
      const columns = await client.query("SELECT character_maximum_length FROM information_schema.columns WHERE table_schema=$1 AND column_name IN('lead_name','identifier') ORDER BY character_maximum_length", [schema]);
      expect(columns.rows.map(value => value.character_maximum_length)).toEqual([255, 500]);
      await identifierMigration.up(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('repeats migration 531, scopes request uniqueness, and refuses to drop durable receipts on rollback', async () => {
    const client = await admin.connect();
    const schema = `enrichment_receipt_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path="${schema}",pg_catalog`);
      await client.query('CREATE TABLE enrichment_runs(id SERIAL PRIMARY KEY,business_profile_id INTEGER,user_id INTEGER)');
      await receiptMigration.up(client);
      await receiptMigration.up(client);
      await client.query("INSERT INTO enrichment_runs(business_profile_id,user_id,request_key,billing_status) VALUES(1,1,'synthetic-key','reserved'),(2,1,'synthetic-key','reserved')");
      await client.query('SAVEPOINT before_duplicate');
      await expect(client.query("INSERT INTO enrichment_runs(business_profile_id,user_id,request_key) VALUES(1,1,'synthetic-key')")).rejects.toThrow('enrichment_runs_request_key_uq');
      await client.query('ROLLBACK TO SAVEPOINT before_duplicate');
      await client.query('SAVEPOINT before_receipt_rollback');
      await expect(receiptMigration.down(client)).rejects.toThrow('receipts must be reviewed');
      await client.query('ROLLBACK TO SAVEPOINT before_receipt_rollback');
      await client.query('DELETE FROM enrichment_runs');
      await receiptMigration.down(client);
      expect((await client.query("SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND column_name='request_key'", [schema])).rows[0].count).toBe('0');
      await receiptMigration.up(client);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
