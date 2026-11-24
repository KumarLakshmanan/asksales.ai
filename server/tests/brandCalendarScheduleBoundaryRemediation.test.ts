import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express from 'express';
import type { Server } from 'node:http';
import 'sharp';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { assertBusinessScopeSchema } from '../tenancy/schemaGuard.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const database = process.env.BRAND_CALENDAR_TEST_DATABASE;
const suite = database ? describe : describe.skip;
let admin: Pool, pool: Pool, server: Server, base: string;
const databaseProxy = new Proxy({}, { get: (_target, key) => Reflect.get(drizzle(pool), key) });
jest.unstable_mockModule('../models/db.js', () => ({ db: databaseProxy }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

jest.unstable_mockModule('../controllers/contentEstimateController.js', () => ({getContentEstimate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") })}));
jest.unstable_mockModule('../controllers/contentStudioController.js', () => ({generateContentPlan: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateAdCopy: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateContent: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateCreatives: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentPlans: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateOutreachCopy: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateMetaPrompt: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generatePromptVariations: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getMediaStatus: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateEmail: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateSMS: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateSocial: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateSocialMessage: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateAdCopyContent: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateMagicPrompt: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateBlogPost: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),enhancePrompt: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getGenerationStatus: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateEmailHtmlTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateImage: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),generateVideo: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),startVideoGeneration: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),checkVideoStatus: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") })}));
jest.unstable_mockModule('../controllers/contentTemplatesController.js', () => ({getContentTemplates: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentTemplateById: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),createContentTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),updateContentTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),deleteContentTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),useTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getMostUsedTemplates: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentTemplateCounts: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),duplicateContentTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getPredefinedTemplates: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),importPredefinedTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentTemplateVersions: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),approveContentTemplate: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") })}));
jest.unstable_mockModule('../controllers/contentAssetController.js', () => ({getContentAssets: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),createContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),updateContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),deleteContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),uploadContentMedia: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),uploadMediaMiddleware: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),publishContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getOrganicPublishingAccounts: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),rescheduleContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),cancelContentAssetSchedule: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),recoverContentAssetPublishAttempt: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentAssetPublishAttempts: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),unpublishContentAsset: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),getContentAssetCounts: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") })}));
jest.unstable_mockModule('../controllers/contentAssetPreviewController.js', () => ({getContentAssetPreviews: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),createContentAssetPreview: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") }),updateContentAssetPreview: jest.fn(() => { throw new Error("Unexercised controller fixture boundary") })}));
await import('../middleware/auth.js');
await import('../middleware/platformAccess.js');
const { generateToken } = await import('../utils/jwt.js');
const { closeRedisConnections } = await import('../infrastructure/redis.js');
const { SmartThrottlingService } = await import('../services/SmartThrottlingService.js');
await import('../middleware/validation.js');
await import('../middleware/schemas.js');
await import('../controllers/brandToolkitController.js');
await import('../controllers/contentCalendarController.js');
await import('../services/StorageService.js');
await import('../services/ObjectStorageService.js');
await import('../services/content/ContentBrandContextService.js');
await import('../services/content/ApprovedTemplateResolver.js');
await import('../models/contentTemplates/functions.js');
const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
let fetchGuard: ReturnType<typeof jest.spyOn>;
let owner: number, member: number, other: number, north: number, _south: number, foreign: number;
let ownerToken: string, memberToken: string, _otherToken: string;

async function request(path: string, method = 'GET', body?: unknown, profile = north, token = ownerToken, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/api/content${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-Business-Profile-Id': String(profile), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? {} : await response.json() as Record<string, any> };
}
suite('second pass: actual mounted content router, scoped PostgreSQL, Redis and local objects', () => {
  jest.setTimeout(20000);
  beforeAll(async () => {
    if (!database?.startsWith('asksales_brand_calendar_audit') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '5546' || process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '6396' || process.env.STORAGE_BACKEND !== 'local' || !process.env.LOCAL_STORAGE_PATH?.startsWith('/tmp/asksales-brand-calendar-')) throw new Error('Only disposable local audit infrastructure is allowed');
    const config = { host: '127.0.0.1', port: 5546, user: 'postgres', database };
    admin = new Pool({ ...config, max: 2 });
    pool = createBusinessScopedPool(new Pool({ ...config, max: 8 }));
    await assertBusinessScopeSchema(admin);
    const suffix = randomUUID();
    const users = await admin.query("INSERT INTO users(email,password,name,is_verified,is_approved,is_setup_complete) VALUES($1,'fixture','Owner',true,true,true),($2,'fixture','Member',true,true,true),($3,'fixture','Other',true,true,true) RETURNING id", [`owner-${suffix}@example.invalid`, `member-${suffix}@example.invalid`, `other-${suffix}@example.invalid`]);
    [owner, member, other] = users.rows.map(row => row.id);
    const profiles = await admin.query("INSERT INTO company_settings(user_id,name,is_default,is_approved) VALUES($1,'North',true,true),($1,'South',false,true),($2,'Foreign',true,true) RETURNING id", [owner, other]);
    [north, _south, foreign] = profiles.rows.map(row => row.id);
    await admin.query("INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')", [north, member, `member-${suffix}@example.invalid`]);
    ownerToken = generateToken({ userId: owner, email: `owner-${suffix}@example.invalid` });
    memberToken = generateToken({ userId: member, email: `member-${suffix}@example.invalid` });
    _otherToken = generateToken({ userId: other, email: `other-${suffix}@example.invalid` });
    const app = express(); app.use(express.json());
    app.use('/api/content', (await import('../routes/content.routes.js')).default);
    app.get('/api/content/audit/identity', async (req, res) => {
      const { currentBusinessScope } = await import('../tenancy/businessContext.js');
      const { currentBillingScope } = await import('../tenancy/billingContext.js');
      res.json({ actor:req.user?.id,business:currentBusinessScope(),billing:currentBillingScope() });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const actualFetch = globalThis.fetch;
    fetchGuard = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${base}/`)) throw new Error('External network calls are forbidden in the brand/calendar fixture');
      return actualFetch(input, init);
    });
    const created = await request('/brand-toolkits', 'POST', { name: 'Audit brand' });
    expect(created.status).toBe(201);
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await (await import('../queues/index.js')).queueRegistry.close();
    SmartThrottlingService.getInstance().destroy();
    await closeRedisConnections();
    fetchGuard?.mockRestore();
    if (pool) await pool.end();
    if (admin) await admin.end();
  });


  it('mounted API calls the real schedule service; queue preserves original identity and cancelled work exits before providers', async () => {
    const identity = await request('/audit/identity');
    expect(identity.status).toBe(200);
    const memberIdentity = await request('/audit/identity','GET',undefined,north,memberToken);
    expect(memberIdentity.body.actor).toBe(member);
    expect(memberIdentity.body.business).toEqual(expect.objectContaining({userId:owner,actorUserId:member,businessProfileId:north}));
    expect(memberIdentity.body.billing.actorUserId).toBe(member);
    const { withBillingScope } = await import('../tenancy/billingContext.js');
    const { channelCredentialsTable } = await import('../models/channelCredentials/schema.js');
    const { socialPublishAttemptsTable } = await import('../models/socialPublishAttempts/schema.js');
    const { enqueueOrganicPublishAttempt,processOrganicPublishJob } = await import('../services/social/OrganicPublishQueue.js');
    const { queueRegistry,QUEUE_NAMES } = await import('../queues/index.js');
    const origin={ userId:owner,businessProfileId:north,businessActorUserId:owner,billingOrganizationId:identity.body.billing.organizationId,billingActorUserId:owner };
    const scoped = <T>(work:()=>T) => withBusinessScope({ userId:owner,businessProfileId:north,actorUserId:owner },()=>withBillingScope(identity.body.billing,work));
    const oldAt=new Date('2030-01-14T12:00:00Z');
    const { asset,attempt } = await scoped(async()=>{
      const executor=drizzle(pool);
      const [credential]=await executor.insert(channelCredentialsTable).values({ userId:owner,businessProfileId:north,platform:'facebook_page',credentialType:'oauth',accountIdentifier:'synthetic-no-provider',accountName:'Synthetic fixture account',isActive:true,isSelected:true }).returning();
      const [asset]=await executor.insert(contentAssetsTable).values({ userId:owner,businessProfileId:north,type:'social_post',channel:'facebook',publishPlatform:'facebook',title:'Real service schedule fixture',content:'Synthetic queue fixture',status:'scheduled',scheduledPublishAt:oldAt }).returning();
      const [attempt]=await executor.insert(socialPublishAttemptsTable).values({ userId:owner,businessProfileId:north,assetId:asset.id,platform:'facebook',credentialId:credential.id,providerAccountId:'synthetic-no-provider',idempotencyKey:randomUUID(),status:'pending',nextAttemptAt:oldAt,reviewedPayload:{ publicationOrigin:origin,platform:'facebook',caption:'Synthetic queue fixture',postType:'text',imageUrls:[],videoUrls:[],credentialId:credential.id,providerAccountId:'synthetic-no-provider',timezone:'UTC',scheduledFor:oldAt.toISOString(),approvedBy:owner,approvedAt:new Date().toISOString() } }).returning();
      return {asset,attempt};
    });
    const denied=await request('/calendar/bulk','POST',{ action:'reschedule',assetIds:[asset.id],scope:'single',scheduledDate:'2030-01-15',scheduledTime:'13:00',timezone:'UTC',expectedVersions:{[asset.id]:asset.version},expectedScheduledFor:{[asset.id]:oldAt.toISOString()},userId:other,businessProfileId:foreign,billingActorUserId:other },north,memberToken,{'Idempotency-Key':randomUUID()});
    writeFileSync('/workspace/brand-calendar-fix-evidence/schedule-http-response.json',JSON.stringify(denied,null,2));
    expect(denied.status).toBe(400); expect(denied.body.code).toBe('BUSINESS_PROFILE_MISMATCH');
    const moved=await request('/calendar/bulk','POST',{action:'reschedule',assetIds:[asset.id],scope:'single',scheduledDate:'2030-01-15',scheduledTime:'13:00',timezone:'UTC',expectedVersions:{[asset.id]:asset.version},expectedScheduledFor:{[asset.id]:oldAt.toISOString()}},north,memberToken,{'Idempotency-Key':randomUUID()});
    expect(moved.status).toBe(200); expect(moved.body.affected).toBe(1);
    const stored=(await admin.query('SELECT reviewed_payload,next_attempt_at FROM social_publish_attempts WHERE id=$1',[attempt.id])).rows[0];
    expect(stored.next_attempt_at.toISOString()).toBe('2030-01-15T13:00:00.000Z');
    expect(stored.reviewed_payload.publicationOrigin).toEqual(origin);
    await queueRegistry.initialize();
    const current={...attempt,nextAttemptAt:stored.next_attempt_at,reviewedPayload:stored.reviewed_payload};
    const jobId=await scoped(()=>enqueueOrganicPublishAttempt(current));
    const sameId=await scoped(()=>enqueueOrganicPublishAttempt(current));
    expect(jobId).toBe(sameId);
    const job=await queueRegistry.getQueue(QUEUE_NAMES.ORGANIC_PUBLISHING).getJob(jobId);
    expect(job!.data).toEqual(expect.objectContaining(origin));
    const changed=(await admin.query('SELECT version FROM content_assets WHERE id=$1',[asset.id])).rows[0];
    const cancelled=await request('/calendar/bulk','POST',{action:'cancel',assetIds:[asset.id],scope:'single',expectedVersions:{[asset.id]:changed.version}},north,memberToken,{'Idempotency-Key':randomUUID()});
    expect(cancelled.status).toBe(200);
    const outcome=await scoped(()=>processOrganicPublishJob(job!.data as any,'synthetic-audit-worker'));
    expect(outcome).toEqual({skipped:true});
    const state=(await admin.query('SELECT status FROM content_assets WHERE id=$1',[asset.id])).rows[0];
    expect(state.status).toBe('cancelled');
    writeFileSync('/workspace/brand-calendar-fix-evidence/real-schedule-queue-identity.json',JSON.stringify({baseline:'24c66b9cac2936ccbd119e39cf78b5b83b1e6212',memberIdentity:memberIdentity.body,conflictingBusinessRejected:denied,origin,scheduledFor:stored.next_attempt_at,publicationOriginAfterReschedule:stored.reviewed_payload.publicationOrigin,jobId,duplicateEnqueueSameJob:jobId===sameId,queuedIdentity:job!.data,cancellationOutcome:outcome,persistedStatus:state.status,providersCalled:false,cronWakeup:'unrun: adapter invoked explicitly'},null,2));
  });
});
