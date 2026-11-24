import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { chromium } from 'playwright-core';
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { withBillingScope } from '../tenancy/billingContext.js';

const connectionString = process.env.AI_VISIBILITY_SYNTHETIC_DATABASE_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55440' ||
    !url.pathname.startsWith('/synthetic_ai_visibility_qa_')
  )
    throw new Error('Requires disposable loopback synthetic database');
}
const suite = connectionString ? describe : describe.skip;
const redisQa = process.env.AI_VISIBILITY_REDIS_QA === '1';
if (
  redisQa &&
  (process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '55441')
)
  throw new Error('Redis QA requires disposable loopback port 55441');
let pool: Pool, database: ReturnType<typeof drizzle>;
let ownerId: number,
  profileId: number,
  organizationId: number,
  otherId: number,
  otherProfileId: number,
  credentialId: number;
const objects = new Map<string, Buffer>();
const objectFiles = new Map<number, Buffer>();
let completedAuditId: number, completedProjectId: number;
let fixtureModuleEnabled = true;
let httpServer: Server | undefined;
const events: Array<{ type: string; data: any }> = [];
let reportStorageFails = false;
let cmsMode = 'success';
let cmsCreates = 0;
let providerCalls = 0;
let crawlGate: (() => Promise<void>) | undefined;
let cmsLookupGate: (() => Promise<void>) | undefined;
let cmsPostGate: (() => Promise<void>) | undefined;
const fees: unknown[] = [];
const credentials = new Map<string, any>();
const warnings: unknown[] = [];
const originalFetch = global.fetch;
let fixtureProviderFetch: typeof fetch | undefined;
global.fetch = async (...args: Parameters<typeof fetch>) => {
  if (fixtureProviderFetch) return fixtureProviderFetch(...args);
  throw new Error('Fixture blocks unconfigured external fetch');
};

jest.unstable_mockModule('../models/db.js', () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        const value = database[key as keyof typeof database];
        return typeof value === 'function' ? value.bind(database) : value;
      },
    },
  ),
}));
jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    if (req.headers['x-fixture-actor'] === 'anonymous')
      return res.status(401).json({ error: 'Unauthorized' });
    req.user = {
      id: req.headers['x-fixture-actor'] === 'member' ? otherId : ownerId,
    };
    next();
  },
}));
jest.unstable_mockModule('../middleware/platformAccess.js', () => ({
  requireModuleAccess: (key: string) => (req: any, res: any, next: any) => {
    if (key !== 'ai_visibility') throw new Error('Unexpected module');
    if (!fixtureModuleEnabled)
      return res.status(503).json({ error: 'Module disabled' });
    next();
  },
}));
jest.unstable_mockModule('../queues/index.js', () => ({
  QUEUE_NAMES: { AI_VISIBILITY_AUDIT: 'ai-visibility-audit' },
  queueRegistry: {
    addJob: async () => {
      throw new Error('No queue dispatch in this fixture');
    },
  },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: {
    info() {},
    error() {},
    debug() {},
    warn(...args: unknown[]) {
      warnings.push(args);
    },
  },
}));
jest.unstable_mockModule('../models/creditPricing/functions.js', () => ({
  getCreditCost: async (key: string) => (key.includes('base') ? 1 : 0.1),
  getRechargeRate: async () => 10,
  getUsageRate: async () => 10,
}));
jest.unstable_mockModule('../models/wallets/functions.js', () => ({
  getBalance: async () => 1000,
}));
jest.unstable_mockModule('../services/CreditService.js', () => ({
  creditService: {
    chargeForResource: async (input: any) => {
      const result: any = await database.transaction((tx: any) =>
        input.createResource(tx),
      );
      fees.push({ type: 'base', amount: input.overrideAmount });
      return {
        success: true,
        resource: result.resource,
        transactionId: 900000 + result.resource.id,
        balanceAfter: 999,
        creditsDeducted: input.overrideAmount,
      };
    },
    deductOnceForResource: async (input: unknown) => {
      fees.push(input);
      return { success: true };
    },
    refundDeduction: async (input: unknown) => {
      fees.push({ refund: input });
      return { success: true };
    },
    settleReservation: async () => ({ success: true }),
  },
}));
jest.unstable_mockModule('../services/emailService.js', () => ({
  emailService: {
    sendEmailWithUserCredentials: async () => {
      throw new Error('Fixture refuses email');
    },
  },
}));
jest.unstable_mockModule('../services/NotificationService.js', () => ({
  NotificationService: { notify: async () => undefined },
}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({
  webSocketEmitter: {
    emit(_user: number, type: string, data: any) {
      events.push({ type, data });
    },
  },
}));
jest.unstable_mockModule('../services/StorageService.js', () => ({
  storageService: {
    upload: async (body: Buffer, input: any) => {
      if (reportStorageFails && input.mimeType === 'application/pdf')
        throw new Error('Synthetic object storage unavailable');
      const storageKey = input.storageKey || `fixture/${objects.size + 1}`;
      objects.set(storageKey, Buffer.from(body));
      const [file] = await database
        .insert(storageFilesTable)
        .values({
          userId: input.userId,
          fileName: input.originalName,
          originalName: input.originalName,
          storageKey,
          mimeType: input.mimeType,
          category: input.category,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          fileSizeBytes: body.length,
        })
        .returning();
      const fileId = file.id;
      objectFiles.set(fileId, Buffer.from(body));
      return { storageKey, fileId, fileSizeBytes: body.length };
    },
    downloadFile: async (id: number) => {
      if (!objectFiles.has(id)) throw new Error('Synthetic object missing');
      return { buffer: objectFiles.get(id) };
    },
  },
}));
jest.unstable_mockModule('../utils/browserAutomation.js', () => ({
  launchSystemChromium: async () => {
    // The CI container has the system Chromium; elsewhere use CHROMIUM_PATH or Playwright's own.
    const systemChromium = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
    const browser = await chromium.launch({
      executablePath: existsSync(systemChromium) ? systemChromium : undefined,
      headless: true,
      args: ['--no-sandbox'],
    });
    const originalNewPage = browser.newPage.bind(browser);
    browser.newPage = async (...args: any[]) => {
      const page = await originalNewPage(...args);
      await page.route('**/*', (route) => route.abort());
      return page;
    };
    return browser;
  },
}));
jest.unstable_mockModule('../services/credentialService.js', () => ({
  getCredential: async (_user: number, platform: string) =>
    credentials.get(platform) || null,
  saveCredential: async (
    _user: number,
    platform: string,
    apiKey: string,
    _secret: string,
    config: unknown,
  ) => {
    if (platform !== 'google_search_console')
      throw new Error('Fixture refuses credential writes');
    credentials.set(platform, { id: credentialId, apiKey, config });
    return true;
  },
  deleteCredential: async () => {
    throw new Error('Fixture refuses credential deletion');
  },
}));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  getActiveAdminCredential: async () => ({
    id: 1,
    apiKey: 'synthetic-client',
    apiSecret: 'synthetic-secret',
  }),
  // The competitor website lookup is not exercised here.
  getAllActiveAdminCredentials: async () => [],
}));
jest.unstable_mockModule(
  '../services/aiVisibility/ProviderObservationService.js',
  () => ({
    AI_VISIBILITY_OBSERVATION_PROVIDERS: ['openai', 'gemini'],
    providerObservationService: {
      readiness: async () =>
        ['openai', 'gemini'].map((provider) => ({
          provider,
          configured: true,
          model: 'synthetic-model',
          reason: '',
        })),
      getConfiguredModel: async () => 'synthetic-model',
      collect: async (provider: string) => {
        providerCalls++;
        return {
          provider,
          model: 'synthetic-model',
          fidelity: 'simulated',
          status: 'completed',
          answer:
            'Fixture Brand offers a documented cancellation policy. Fixture Competitor is another option.',
          citations: [
            {
              url: 'https://fixturecompetitor.example.test',
              title: 'Fixture Competitor',
            },
          ],
          inputTokens: 3,
          outputTokens: 10,
          costCents: 0,
        };
      },
    },
  }),
);
jest.unstable_mockModule(
  '../services/aiVisibility/StructuredAnswerExtractionService.js',
  () => ({
    structuredAnswerExtractionService: {
      extract: async () => ({
        status: 'completed',
        extraction: {
          brandMentioned: true,
          brandRank: 1,
          sentiment: 'neutral',
          competitors: ['Fixture Competitor'],
          recommendationReason: 'Documented policy',
          exclusionReason: null,
        },
        method: 'structured_llm_v1',
        provider: 'fixture',
        model: 'synthetic-model',
        fidelity: 'simulated',
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
      }),
    },
  }),
);
jest.unstable_mockModule('../utils/safeRemoteFetch.js', () => ({
  assertPublicHttpUrl: async (raw: string) => new URL(raw),
  readResponseBuffer: async (response: Response) =>
    Buffer.from(await response.arrayBuffer()),
  fetchPublicHttpUrl: async (raw: string, init: RequestInit = {}) => {
    const url = new URL(raw);
    if (url.hostname === 'shop-fixture.myshopify.com') {
      const payload = JSON.parse(String(init.body));
      const lookup = payload.query.includes('FindAiVisibilityArticle');
      if (lookup) {
        const nodes =
          cmsMode === 'shopify_wrong_handle'
            ? [
                {
                  id: 'gid://shopify/Article/51',
                  handle: 'unrelated',
                  isPublished: false,
                },
              ]
            : ['shopify_published', 'shopify_existing'].includes(cmsMode)
              ? [
                  {
                    id: 'gid://shopify/Article/51',
                    handle: payload.variables.query.replace(/^handle:/, ''),
                    isPublished: cmsMode === 'shopify_published',
                  },
                ]
              : [];
        return {
          response: Response.json({
            data: {
              blog:
                cmsMode === 'shopify_missing_lookup'
                  ? null
                  : { articles: { nodes } },
            },
          }),
          finalUrl: raw,
          redirectCount: 0,
          redirectChain: [],
        };
      }
      cmsCreates++;
      return {
        response: Response.json({
          data: {
            articleCreate: {
              article: {
                id: 'gid://shopify/Article/51',
                handle: payload.variables.article.handle,
                isPublished: false,
              },
              userErrors: [],
            },
          },
        }),
        finalUrl: raw,
        redirectCount: 0,
        redirectChain: [],
      };
    }
    if (url.hostname === 'cms.example.test') {
      if (init.method === 'POST') {
        cmsCreates++;
        if (cmsPostGate) await cmsPostGate();
        if (cmsMode === 'invalid_json')
          return {
            response: new Response('<html>gateway error</html>', {
              status: 201,
            }),
            finalUrl: raw,
            redirectCount: 0,
            redirectChain: [],
          };
        return {
          response: Response.json(
            { id: 501, status: 'draft' },
            { status: 201 },
          ),
          finalUrl: raw,
          redirectCount: 0,
          redirectChain: [],
        };
      }
      if (cmsLookupGate) await cmsLookupGate();
      if (cmsMode === 'wordpress_existing')
        return {
          response: Response.json([
            { id: 501, slug: url.searchParams.get('slug'), status: 'draft' },
          ]),
          finalUrl: raw,
          redirectCount: 0,
          redirectChain: [],
        };
      if (cmsMode === 'lookup_failure')
        return {
          response: Response.json({ message: 'unavailable' }, { status: 503 }),
          finalUrl: raw,
          redirectCount: 0,
          redirectChain: [],
        };
      return {
        response: Response.json([]),
        finalUrl: raw,
        redirectCount: 0,
        redirectChain: [],
      };
    }
    if (!url.hostname.endsWith('.example.test'))
      throw new Error(`Fixture blocks external request to ${url.hostname}`);
    if (url.pathname === '/robots.txt')
      return {
        response: new Response('User-agent: *\nAllow: /', {
          headers: { 'content-type': 'text/plain' },
        }),
        finalUrl: raw,
        redirectCount: 0,
        redirectChain: [],
      };
    if (url.pathname.endsWith('.xml'))
      return {
        response: new Response('', { status: 404 }),
        finalUrl: raw,
        redirectCount: 0,
        redirectChain: [],
      };
    if (crawlGate && url.hostname === 'brand.example.test') await crawlGate();
    const html =
      '<html><head><title>Fixture Brand cancellation policy and product guide</title><meta name="description" content="Read our documented cancellation policy and detailed product information for customers."><link rel="canonical" href="' +
      raw +
      '"></head><body><h1>Fixture Brand</h1><h2>Cancellation policy</h2><p>Customers can cancel a subscription from account settings. The cancellation takes effect at the end of the current billing period. ' +
      'Verified fixture content for testing only. '.repeat(80) +
      '</p></body></html>';
    return {
      response: new Response(html, {
        headers: { 'content-type': 'text/html' },
      }),
      finalUrl: raw,
      redirectCount: 0,
      redirectChain: [],
    };
  },
}));

const { aiVisibilityService } =
  await import('../services/aiVisibility/AiVisibilityService.js');
const { AuditOrchestrator } =
  await import('../services/aiVisibility/AuditOrchestrator.js');
const { cmsDraftPublishingService } =
  await import('../services/aiVisibility/CmsDraftPublishingService.js');
const { aiVisibilityWorkspaceService } =
  await import('../services/aiVisibility/AiVisibilityWorkspaceService.js');
const tables = await import('../models/aiVisibility/schema.js');
const { contentAssetsTable } =
  await import('../models/contentAssets/schema.js');
const { storageFilesTable } = await import('../models/storageFiles/schema.js');
const { default: router } = await import('../routes/aiVisibility.routes.js');
const { googleSearchConsoleService } =
  await import('../services/aiVisibility/GoogleSearchConsoleService.js');
const { generateToken } = await import('../utils/jwt.js');
const { AUTH_COOKIES } = await import('../utils/authCookies.js');
const { closeRedisConnections } = await import('../infrastructure/redis.js');
const app = express();
app.use(express.json());
app.use((req, _res, next) =>
  withBusinessScope(
    {
      userId: ownerId,
      businessProfileId: profileId,
      actorUserId:
        req.headers['x-fixture-actor'] === 'member' ? otherId : ownerId,
    },
    () => withBillingScope({ organizationId, actorUserId: ownerId }, next),
  ),
);
app.use('/api/ai-visibility', router);

function scope<T>(work: () => T) {
  return withBusinessScope(
    {
      userId: ownerId,
      businessProfileId: profileId,
      actorUserId: ownerId,
      role: 'owner',
    },
    () => withBillingScope({ organizationId, actorUserId: ownerId }, work),
  );
}
async function project() {
  return scope(() =>
    aiVisibilityService.resolveWebsiteSearch(ownerId, {
      website: 'brand.example.test',
      name: 'Fixture Brand',
      category: 'software',
    }),
  );
}
async function audit() {
  const { project: p } = await project();
  const result = await scope(() =>
    aiVisibilityService.createAudit(ownerId, p.id),
  );
  expect(result.success).toBe(true);
  return { p, id: result.resource.id };
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
async function approvedAsset() {
  const { p, id } = await audit();
  return scope(async () => {
    const [asset] = await database
      .insert(contentAssetsTable)
      .values({
        userId: ownerId,
        type: 'blog',
        title: 'Approved fixture article',
        content: '<p>Reviewed synthetic content.</p>',
        channel: 'ai_visibility',
        status: 'draft',
        approvalStatus: 'approved',
        approvedBy: ownerId,
        approvedAt: new Date(),
      })
      .returning();
    const [link] = await database
      .insert(tables.aiVisibilityGeneratedAssetLinksTable)
      .values({
        userId: ownerId,
        projectId: p.id,
        auditId: id,
        contentAssetId: asset.id,
      })
      .returning();
    await database
      .insert(tables.aiVisibilityAssetApprovalDecisionsTable)
      .values({
        workspaceId: p.workspaceId,
        projectId: p.id,
        generatedAssetLinkId: link.id,
        contentAssetId: asset.id,
        assetVersion: asset.version,
        actorUserId: ownerId,
        decision: 'approved',
      });
    credentials.set('wordpress', {
      id: credentialId,
      apiSecret: 'synthetic-only',
      config: { siteUrl: 'https://cms.example.test', username: 'fixture' },
    });
    credentials.set('shopify', {
      id: credentialId,
      apiSecret: 'synthetic-only',
      config: {
        storeDomain: 'shop-fixture.myshopify.com',
        blogId: 'gid://shopify/Blog/1',
        authorName: 'Fixture',
      },
    });
    return { p, asset, link };
  });
}

suite(
  'AI Visibility actual product orchestration on synthetic PostgreSQL',
  () => {
    beforeAll(async () => {
      pool = new Pool({ connectionString, max: 12 });
      database = drizzle(createBusinessScopedPool(pool));
      const admin = await pool.connect();
      try {
        await admin.query(
          "SELECT set_config('app.business_system','on',false)",
        );
        ownerId = (
          await admin.query(
            "INSERT INTO users(email,name) VALUES($1,'Fixture Owner') RETURNING id",
            [`visibility-owner-${Date.now()}@example.test`],
          )
        ).rows[0].id;
        otherId = (
          await admin.query(
            "INSERT INTO users(email,name) VALUES($1,'Other Fixture') RETURNING id",
            [`visibility-other-${Date.now()}@example.test`],
          )
        ).rows[0].id;
        organizationId = (
          await admin.query(
            "INSERT INTO billing_organizations(owner_user_id,name,billing_eligibility_at) VALUES($1,'Synthetic Org',now()) RETURNING id",
            [ownerId],
          )
        ).rows[0].id;
        await admin.query(
          "INSERT INTO billing_organization_memberships(organization_id,user_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
          [organizationId, ownerId, `visibility-${ownerId}@example.test`],
        );
        profileId = (
          await admin.query(
            "INSERT INTO company_settings(user_id,name,company_name,website,billing_organization_id) VALUES($1,'Fixture Business','Fixture Brand','https://brand.example.test',$2) RETURNING id",
            [ownerId, organizationId],
          )
        ).rows[0].id;
        otherProfileId = (
          await admin.query(
            "INSERT INTO company_settings(user_id,name,billing_organization_id) VALUES($1,'Other Business',$2) RETURNING id",
            [otherId, organizationId],
          )
        ).rows[0].id;
        credentialId = (
          await admin.query(
            "INSERT INTO api_credentials(user_id,business_profile_id,service_name,api_key) VALUES($1,$2,'wordpress','synthetic-only') RETURNING id",
            [ownerId, profileId],
          )
        ).rows[0].id;
        await admin.query(
          "INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')",
          [profileId, otherId, `member-${otherId}@example.test`],
        );
      } finally {
        await admin.query('RESET ALL');
        admin.release();
      }
    });
    afterAll(async () => {
      global.fetch = originalFetch;
      if (redisQa) await closeRedisConnections();
      if (httpServer)
        await new Promise<void>((resolve, reject) =>
          httpServer!.close((error) => (error ? reject(error) : resolve())),
        );
      if (pool) await pool.end();
    });
    beforeEach(() => {
      fixtureProviderFetch = undefined;
      fixtureModuleEnabled = true;
      reportStorageFails = false;
      cmsMode = 'success';
      cmsCreates = 0;
      providerCalls = 0;
      crawlGate = undefined;
      cmsLookupGate = undefined;
      cmsPostGate = undefined;
      fees.length = 0;
      events.length = 0;
      warnings.length = 0;
    });

    it('runs all 13 production stages, renders a real PDF, and reloads durable outputs without repeated provider usage', async () => {
      const { p, id } = await audit();
      completedAuditId = id;
      completedProjectId = p.id;
      const orchestrator = new AuditOrchestrator();
      const result = await scope(() => orchestrator.run(id, ownerId));
      const saved = await scope(() =>
        aiVisibilityService.getAudit(ownerId, id),
      );
      expect(result.status).toMatch(/^completed/);
      expect(saved.stages).toHaveLength(13);
      expect(
        saved.stages.every((s: any) =>
          ['completed', 'skipped', 'warning'].includes(s.status),
        ),
      ).toBe(true);
      expect(warnings).toEqual([]);
      expect(providerCalls).toBeGreaterThan(0);
      expect(
        (
          await scope(() =>
            database
              .select()
              .from(tables.aiVisibilityCompetitorSnapshotsTable)
              .where(
                eq(tables.aiVisibilityCompetitorSnapshotsTable.auditId, id),
              ),
          )
        ).length,
      ).toBe(1);
      expect(
        (await scope(() => aiVisibilityService.recommendations(ownerId, p.id)))
          .length,
      ).toBeGreaterThan(0);
      const [report] = await scope(() =>
        database
          .select()
          .from(tables.aiVisibilityReportsTable)
          .where(eq(tables.aiVisibilityReportsTable.auditId, id)),
      );
      expect(objects.get(report.storageKey!)?.subarray(0, 5).toString()).toBe(
        '%PDF-',
      );
      const calls = providerCalls;
      await scope(() => new AuditOrchestrator().run(id, ownerId));
      expect(providerCalls).toBe(calls);
      expect(
        (await scope(() => aiVisibilityService.overview(ownerId, p.id)))
          .latestAudit.id,
      ).toBe(id);
    }, 30000);

    it('honors cancellation accepted during the final stage', async () => {
      const { id } = await audit();
      const orchestrator = new AuditOrchestrator();
      const entered = latch(),
        release = latch();
      const original = (orchestrator as any).finalSnapshot.bind(orchestrator);
      (orchestrator as any).finalSnapshot = async (...args: any[]) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      };
      const running = scope(() => orchestrator.run(id, ownerId));
      await entered.promise;
      await scope(() => aiVisibilityService.cancelAudit(ownerId, id));
      release.resolve();
      expect((await running).status).toBe('cancelled');
      expect(
        (await scope(() => aiVisibilityService.getAudit(ownerId, id))).status,
      ).toBe('cancelled');
      expect(
        events.some((e) => e.type === 'ai_visibility_audit_completed'),
      ).toBe(false);
    }, 30000);

    it('does not execute a second audit runner while the first runner is collecting a crawl', async () => {
      const { id } = await audit();
      const entered = latch(),
        release = latch();
      let enteredCount = 0;
      crawlGate = async () => {
        enteredCount++;
        entered.resolve();
        await release.promise;
      };
      const first = scope(() => new AuditOrchestrator().run(id, ownerId));
      await entered.promise;
      const second = scope(() => new AuditOrchestrator().run(id, ownerId));
      // A second caller must return without entering the provider adapter.
      const secondResult = await Promise.race([
        second,
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]);
      release.resolve();
      await Promise.allSettled([first, second]);
      expect(enteredCount).toBe(1);
      expect(secondResult?.status).toBe('running');
      const saved = await scope(() =>
        aiVisibilityService.getAudit(ownerId, id),
      );
      expect(saved.stages.every((s: any) => s.attemptCount <= 1)).toBe(true);
    }, 30000);

    it('retries failed report storage using durable evidence without repeated providers or audit charges', async () => {
      const { id } = await audit();
      reportStorageFails = true;
      await scope(() => new AuditOrchestrator().run(id, ownerId));
      const before = providerCalls,
        charged = fees.length;
      reportStorageFails = false;
      await scope(() => new AuditOrchestrator().retryReport(id, ownerId));
      expect(providerCalls).toBe(before);
      expect(fees).toHaveLength(charged);
      const reportStage = (
        await scope(() => aiVisibilityService.getAudit(ownerId, id))
      ).stages.find((s: any) => s.stageKey === 'report_generation');
      expect(reportStage.status).toBe('completed');
    }, 30000);

    it('enforces database profile isolation against another owner', async () => {
      const { id } = await audit();
      await expect(
        withBusinessScope(
          { userId: otherId, businessProfileId: otherProfileId },
          () => aiVisibilityService.getAudit(otherId, id),
        ),
      ).rejects.toThrow('Audit not found');
      const rows = await withBusinessScope(
        { userId: otherId, businessProfileId: otherProfileId },
        () =>
          database
            .select()
            .from(tables.aiVisibilityAuditsTable)
            .where(eq(tables.aiVisibilityAuditsTable.id, id)),
      );
      expect(rows).toEqual([]);
    });

    it('does not create a WordPress draft when remote reconciliation is unavailable', async () => {
      const { p, link } = await approvedAsset();
      cmsMode = 'lookup_failure';
      await expect(
        scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            'wordpress',
            crypto.randomUUID(),
          ),
        ),
      ).rejects.toThrow();
      expect(cmsCreates).toBe(0);
    });

    it('persists an uncertain CMS create response as ambiguous for safe reconciliation', async () => {
      const { p, link } = await approvedAsset();
      cmsMode = 'invalid_json';
      await expect(
        scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            'wordpress',
            crypto.randomUUID(),
          ),
        ),
      ).rejects.toThrow();
      const attempts = await scope(() =>
        cmsDraftPublishingService.attempts(ownerId, p.id),
      );
      expect(cmsCreates).toBe(1);
      expect(attempts[0].status).toBe('ambiguous');
    });

    it('keeps an uncertain CMS intent read-only when a retry cannot find its draft', async () => {
      const { p, link } = await approvedAsset();
      const key = crypto.randomUUID();
      cmsMode = 'invalid_json';
      await expect(
        scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            'wordpress',
            key,
            1,
          ),
        ),
      ).rejects.toThrow();
      cmsMode = 'lookup_failure';
      await expect(
        scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            'wordpress',
            key,
            1,
          ),
        ),
      ).rejects.toThrow();
      expect(
        (
          await scope(() => cmsDraftPublishingService.attempts(ownerId, p.id))
        )[0].status,
      ).toBe('ambiguous');
      cmsMode = 'success';
      await expect(
        scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            'wordpress',
            key,
            1,
          ),
        ),
      ).rejects.toThrow('uncertain');
      expect(cmsCreates).toBe(1);
    });

    it('recovers an uncertain intent only by finding its exact existing unpublished draft', async () => {
      const { p, link } = await approvedAsset();
      const key = crypto.randomUUID();
      cmsMode = 'invalid_json';
      await expect(
        scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            'wordpress',
            key,
            1,
          ),
        ),
      ).rejects.toThrow();
      cmsMode = 'wordpress_existing';
      const recovered = await scope(() =>
        cmsDraftPublishingService.createDraft(
          ownerId,
          p.id,
          link.id,
          'wordpress',
          key,
          1,
        ),
      );
      expect(recovered.reconciliationCount).toBe(1);
      expect(cmsCreates).toBe(1);
    });

    it.each(["wordpress", "shopify"] as const)(
      "reconciles a stranded %s sending intent without another create",
      async (platform) => {
        const { p, asset, link } = await approvedAsset();
        const key = crypto.randomUUID();
        const created = await scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            platform,
            key,
            asset.version,
          ),
        );
        await scope(() =>
          database
            .update(tables.aiVisibilityCmsPublishAttemptsTable)
            .set({
              status: "sending",
              destinationId: null,
              destinationUrl: null,
              completedAt: null,
              updatedAt: new Date(Date.now() - 86400000),
            })
            .where(
              eq(tables.aiVisibilityCmsPublishAttemptsTable.id, created.id),
            ),
        );
        cmsMode =
          platform === "wordpress" ? "wordpress_existing" : "shopify_existing";
        await expect(
          scope(() =>
            cmsDraftPublishingService.createDraft(
              ownerId,
              p.id,
              link.id,
              platform,
              key,
              asset.version,
            ),
          ),
        ).rejects.toMatchObject({ code: "PUBLISH_IN_PROGRESS" });
        let recovered;
        if (platform === "wordpress") {
          const response = await request(app)
            .post(
              `/api/ai-visibility/projects/${p.id}/assets/${link.id}/cms-drafts`,
            )
            .send({
              platform,
              idempotencyKey: key,
              assetVersion: asset.version,
              checkOutcomeOnly: true,
            });
          expect(response.status).toBe(201);
          recovered = response.body.attempt;
        } else
          recovered = await scope(() =>
            cmsDraftPublishingService.createDraft(
              ownerId,
              p.id,
              link.id,
              platform,
              key,
              asset.version,
              true,
            ),
          );
        expect(recovered).toMatchObject({
          id: created.id,
          status: "draft_created",
          idempotencyKey: key,
          payloadFingerprint: created.payloadFingerprint,
          attemptCount: 1,
          reconciliationCount: 1,
        });
        expect(cmsCreates).toBe(1);
      },
    );

    it("keeps a sending intent uncertain when an explicit outcome check finds no draft or the lookup fails", async () => {
      const { p, asset, link } = await approvedAsset();
      const key = crypto.randomUUID();
      const created = await scope(() =>
        cmsDraftPublishingService.createDraft(
          ownerId,
          p.id,
          link.id,
          "wordpress",
          key,
          asset.version,
        ),
      );
      await scope(() =>
        database
          .update(tables.aiVisibilityCmsPublishAttemptsTable)
          .set({
            status: "sending",
            destinationId: null,
            destinationUrl: null,
            completedAt: null,
          })
          .where(eq(tables.aiVisibilityCmsPublishAttemptsTable.id, created.id)),
      );
      for (const mode of ["success", "lookup_failure"]) {
        cmsMode = mode;
        await expect(
          scope(() =>
            cmsDraftPublishingService.createDraft(
              ownerId,
              p.id,
              link.id,
              "wordpress",
              key,
              asset.version,
              true,
            ),
          ),
        ).rejects.toMatchObject({ statusCode: 502 });
        expect(
          (
            await scope(() => cmsDraftPublishingService.attempts(ownerId, p.id))
          )[0],
        ).toMatchObject({
          id: created.id,
          status: "sending",
          idempotencyKey: key,
          attemptCount: 1,
        });
      }
      expect(cmsCreates).toBe(1);
    });

    it("refuses an outcome check without an existing intent instead of creating one", async () => {
      const { p, asset, link } = await approvedAsset();
      await expect(
        scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            "wordpress",
            crypto.randomUUID(),
            asset.version,
            true,
          ),
        ),
      ).rejects.toMatchObject({
        code: "PUBLISH_INTENT_NOT_FOUND",
        statusCode: 409,
      });
      expect(
        (
          await scope(() => cmsDraftPublishingService.attempts(ownerId, p.id))
        ).filter((attempt: { generatedAssetLinkId: number }) => attempt.generatedAssetLinkId === link.id),
      ).toEqual([]);
      expect(cmsCreates).toBe(0);
    });

    it("does not downgrade a reconciled intent when the original active dispatch later loses its acknowledgement", async () => {
      const { p, asset, link } = await approvedAsset();
      const key = crypto.randomUUID();
      const entered = latch(),
        release = latch();
      cmsPostGate = async () => {
        entered.resolve();
        await release.promise;
        throw new Error("Synthetic acknowledgement interrupted");
      };
      const dispatched = scope(() =>
        cmsDraftPublishingService.createDraft(
          ownerId,
          p.id,
          link.id,
          "wordpress",
          key,
          asset.version,
        ),
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await entered.promise;
      cmsMode = "wordpress_existing";
      try {
        const found = await scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            "wordpress",
            key,
            asset.version,
            true,
          ),
        );
        expect(found.status).toBe("draft_created");
      } finally {
        release.resolve();
      }
      expect(await dispatched).toMatchObject({
        value: { status: "draft_created", idempotencyKey: key },
      });
      expect(
        (
          await scope(() => cmsDraftPublishingService.attempts(ownerId, p.id))
        )[0].status,
      ).toBe("draft_created");
      expect(cmsCreates).toBe(1);
    });

    it('preserves uncertainty when saving a successful remote acknowledgement fails', async () => {
      const { p, link } = await approvedAsset();
      const save = jest.spyOn(database, 'update').mockImplementationOnce(() => {
        throw new Error('Synthetic persistence interruption');
      });
      try {
        await expect(
          scope(() =>
            cmsDraftPublishingService.createDraft(
              ownerId,
              p.id,
              link.id,
              'wordpress',
              crypto.randomUUID(),
              1,
            ),
          ),
        ).rejects.toThrow();
      } finally {
        save.mockRestore();
      }
      expect(
        (
          await scope(() => cmsDraftPublishingService.attempts(ownerId, p.id))
        )[0].status,
      ).toBe('ambiguous');
      expect(cmsCreates).toBe(1);
    });

    it.each([
      'shopify_missing_lookup',
      'shopify_wrong_handle',
      'shopify_published',
    ])('refuses a Shopify create when reconciliation is %s', async (mode) => {
      const { p, link } = await approvedAsset();
      cmsMode = mode;
      await expect(
        scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            'shopify',
            crypto.randomUUID(),
            1,
          ),
        ),
      ).rejects.toThrow();
      expect(cmsCreates).toBe(0);
    });

    it('serves production HTTP evidence, exports and share revocation with real SQL permissions', async () => {
      const root = `/api/ai-visibility/projects/${completedProjectId}`;
      expect((await request(app).get(root)).status).toBe(200);
      expect(
        (await request(app).get(root).set('x-fixture-actor', 'anonymous'))
          .status,
      ).toBe(401);
      fixtureModuleEnabled = false;
      expect((await request(app).get(root)).status).toBe(503);
      fixtureModuleEnabled = true;
      const forbidden = await request(app)
        .post(`${root}/assets/1/cms-drafts`)
        .set('x-fixture-actor', 'member')
        .send({ platform: 'wordpress', idempotencyKey: crypto.randomUUID() });
      expect(forbidden.status).toBe(403);
      expect(cmsCreates).toBe(0);
      const csv = await request(app).get(
        `/api/ai-visibility/audits/${completedAuditId}/export.csv`,
      );
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      const exported = await request(app).get(
        `/api/ai-visibility/audits/${completedAuditId}/export.json`,
      );
      expect(exported.status).toBe(200);
      expect(JSON.stringify(exported.body)).not.toMatch(
        /"(?:storageKey|rawHtmlKey|storageFileId)"/,
      );
      expect(
        (
          await request(app).post(`${root}/assets/1/cms-drafts`).send({
            platform: 'wordpress',
            idempotencyKey: crypto.randomUUID(),
          })
        ).status,
      ).toBe(400);
      const shared = await request(app)
        .post(`/api/ai-visibility/audits/${completedAuditId}/report-shares`)
        .send({ expiresInDays: 1 });
      expect(shared.status).toBe(201);
      const sharedPath = `/api/ai-visibility/shared-reports/${shared.body.token}`;
      const pdf = await request(app)
        .get(sharedPath)
        .set('x-fixture-actor', 'anonymous');
      expect(pdf.status).toBe(200);
      expect(pdf.headers['cache-control']).toContain('no-store');
      expect(pdf.headers['x-robots-tag']).toContain('noindex');
      const revoke = `${root}/report-shares/${shared.body.share.id}`;
      expect((await request(app).delete(revoke)).status).toBe(200);
      expect((await request(app).delete(revoke)).status).toBe(200);
      expect((await request(app).get(sharedPath)).status).toBe(404);
      const expired = await request(app)
        .post(`/api/ai-visibility/audits/${completedAuditId}/report-shares`)
        .send({ expiresInDays: 1 });
      await scope(() =>
        database
          .update(tables.aiVisibilityReportSharesTable)
          .set({ expiresAt: new Date('2000-01-01') })
          .where(
            eq(tables.aiVisibilityReportSharesTable.id, expired.body.share.id),
          ),
      );
      expect(
        (
          await request(app).get(
            `/api/ai-visibility/shared-reports/${expired.body.token}`,
          )
        ).status,
      ).toBe(404);
    });

    it('rejects a cancellation that loses a race to terminal completion', async () => {
      const { id } = await audit();
      const original = aiVisibilityService.getAudit.bind(aiVisibilityService);
      const read = jest
        .spyOn(aiVisibilityService, 'getAudit')
        .mockImplementationOnce(async (userId: number, auditId: number) => {
          const active = await original(userId, auditId);
          await database
            .update(tables.aiVisibilityAuditsTable)
            .set({ status: 'completed' })
            .where(eq(tables.aiVisibilityAuditsTable.id, id));
          return active;
        });
      try {
        await expect(
          scope(() => aiVisibilityService.cancelAudit(ownerId, id)),
        ).rejects.toThrow('finished before cancellation');
      } finally {
        read.mockRestore();
      }
      expect(
        (await scope(() => original(ownerId, id))).cancellationRequested,
      ).toBe(false);
      await scope(() =>
        database
          .delete(tables.aiVisibilityAuditsTable)
          .where(eq(tables.aiVisibilityAuditsTable.id, id)),
      );
    });

    it('rejects a stale reviewed CMS version even when a newer version was separately approved', async () => {
      const { p, link } = await approvedAsset();
      await scope(() =>
        aiVisibilityService.editAsset(ownerId, p.id, link.id, ownerId, {
          version: 1,
          title: 'Revised article',
          content: 'New reviewed fixture content',
        }),
      );
      await scope(() =>
        aiVisibilityWorkspaceService.decideAsset(ownerId, p.id, link.id, {
          decision: 'approved',
          assetVersion: 2,
        }),
      );
      await expect(
        scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            'wordpress',
            crypto.randomUUID(),
            1,
          ),
        ),
      ).rejects.toThrow('changed');
      expect(cmsCreates).toBe(0);
    });

    it('deduplicates concurrent CMS intents with different browser keys and a later reload', async () => {
      const { p, link } = await approvedAsset();
      const entered = latch(),
        release = latch();
      cmsLookupGate = async () => {
        entered.resolve();
        await release.promise;
      };
      const first = scope(() =>
        cmsDraftPublishingService.createDraft(
          ownerId,
          p.id,
          link.id,
          'wordpress',
          crypto.randomUUID(),
          1,
        ),
      );
      await entered.promise;
      const second = scope(() =>
        cmsDraftPublishingService.createDraft(
          ownerId,
          p.id,
          link.id,
          'wordpress',
          crypto.randomUUID(),
          1,
        ),
      );
      await new Promise<void>((r) => setTimeout(r, 150));
      release.resolve();
      const results = await Promise.allSettled([first, second]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      expect(cmsCreates).toBe(1);
      const reloaded = await scope(() =>
        cmsDraftPublishingService.createDraft(
          ownerId,
          p.id,
          link.id,
          'wordpress',
          crypto.randomUUID(),
          1,
        ),
      );
      expect(reloaded.status).toBe('draft_created');
      expect(cmsCreates).toBe(1);
    });

    (process.env.AI_VISIBILITY_BROWSER_QA === '1' ? it : it.skip)(
      'renders every workspace view at 1440, 768 and 390px and creates an exact-version CMS intent through HTTP',
      async () => {
        httpServer = await new Promise<Server>((resolve) => {
          const listening = app.listen(3101, '127.0.0.1', () =>
            resolve(listening),
          );
        });
        await mkdir('/workspace/visibility-audit-evidence/browser', {
          recursive: true,
        });
        const { link } = await approvedAsset();
        const browser = await chromium.launch({
          executablePath: '/usr/bin/chromium',
          headless: true,
          args: ['--no-sandbox'],
        });
        const sentVersions: number[] = [];
        const sentKeys: string[] = [];
        const unknownApi: string[] = [];
        try {
          for (const width of [1440, 768, 390]) {
            const context = await browser.newContext({
              viewport: { width, height: 900 },
              deviceScaleFactor: 1,
            });
            await context.route('**/*', (route) =>
              ['127.0.0.1', 'localhost'].includes(
                new URL(route.request().url()).hostname,
              )
                ? route.continue()
                : route.abort(),
            );
            const page = await context.newPage();
            await page.addInitScript(() => {
              localStorage.setItem('token', 'synthetic-fixture-only');
              const NativeWebSocket = (globalThis as any).WebSocket;
              class FixtureSocket extends EventTarget {
                static OPEN = 1;
                static CONNECTING = 0;
                static CLOSED = 3;
                readyState = 1;
                onopen: any;
                onclose: any;
                onerror: any;
                onmessage: any;
                send() {}
                close() {
                  this.readyState = 3;
                }
                constructor() {
                  super();
                  queueMicrotask(() => this.onopen?.(new Event('open')));
                }
              }
              (globalThis as any).WebSocket = class {
                static OPEN = 1;
                static CONNECTING = 0;
                static CLOSED = 3;
                constructor(url: string, protocols: any) {
                  return String(url).includes('/_next/')
                    ? new NativeWebSocket(url, protocols)
                    : new FixtureSocket();
                }
              } as any;
            });
            await page.route('**/api/**', async (route) => {
              const req = route.request(),
                url = new URL(req.url()),
                path = url.pathname;
              if (path.startsWith('/api/ai-visibility/')) {
                if (path.endsWith('/cms-drafts')) {
                  sentVersions.push(req.postDataJSON().assetVersion);
                  sentKeys.push(req.postDataJSON().idempotencyKey);
                }
                const response = await route.fetch({
                  url: `http://127.0.0.1:3101${path}${url.search}`,
                });
                return route.fulfill({ response });
              }
              let body: unknown;
              if (path === '/api/auth/me')
                body = {
                  user: {
                    id: ownerId,
                    name: 'Fixture Owner',
                    email: 'fixture@example.test',
                    isSetupComplete: true,
                    isApproved: true,
                    hasBusinessProfile: true,
                    hasBrandToolkit: true,
                  },
                };
              else if (path === '/api/platform/access')
                body = {
                  maintenance: { enabled: false, message: '' },
                  modules: [
                    'campaigns',
                    'lead_generation',
                    'content',
                    'performance_marketing',
                    'ai_visibility',
                    'outreach',
                    'crm',
                    'support',
                    'support_ai',
                    'proposals',
                    'knowledge_base',
                    'integrations',
                    'billing',
                    'storage',
                  ].map((key) => ({
                    key,
                    name: key,
                    status: 'available',
                    enabled: true,
                    mode: 'enabled',
                    message: null,
                  })),
                };
              else if (path === '/api/settings/business-profiles')
                body = [
                  {
                    id: profileId,
                    name: 'Fixture Business',
                    companyName: 'Fixture Brand',
                    isDefault: true,
                    role: 'owner',
                  },
                ];
              else if (path === '/api/settings/preferences')
                body = { theme: 'light', language: 'en', timezone: 'UTC' };
              else if (path === '/api/organizations')
                body = { organizations: [] };
              else if (path === '/api/notifications/unread/count')
                body = { count: 0 };
              else if (path === '/api/wallet') body = { balance: 1000 };
              else if (path === '/api/chat/threads')
                body = { threads: [], total: 0 };
              else {
                unknownApi.push(path);
                body = {};
              }
              await route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify(body),
              });
            });
            for (const [view, heading] of [
              ['overview', 'Visibility overview'],
              ['seo', 'SEO health'],
              ['aeo', 'AEO coverage'],
              ['geo', 'GEO observations'],
              ['commerce', 'Commerce readiness'],
              ['competitors', 'Competitors'],
              ['fixes', 'Prioritized fixes'],
              ['assets', 'Generated assets'],
              ['reports', 'Reports'],
            ]) {
              const suffix = view === 'overview' ? '' : `/${view}`;
              await page.goto(
                `http://127.0.0.1:3100/dashboard/ai-visibility/websites/${completedProjectId}${suffix}?audit=${completedAuditId}${view === 'assets' ? `&asset=${link.id}` : ''}`,
              );
              await page
                .getByRole('heading', { name: heading, exact: true })
                .first()
                .waitFor({ timeout: 90000 });
              await page.waitForTimeout(150);
              expect(
                await page.evaluate(
                  () =>
                    (globalThis as any).document.documentElement.scrollWidth <=
                    (globalThis as any).innerWidth + 1,
                ),
              ).toBe(true);
              await page.screenshot({
                path: `/workspace/visibility-audit-evidence/browser/${width}-${view}.png`,
                fullPage: true,
              });
              if (width === 1440 && view === 'assets') {
                const response = page.waitForResponse((response) =>
                  response.url().endsWith('/cms-drafts'),
                );
                await page
                  .getByRole('button', {
                    name: 'Create wordpress draft',
                    exact: true,
                  })
                  .click();
                expect((await response).status()).toBe(201);
                const uncertain = await approvedAsset();
                cmsMode = 'invalid_json';
                await page.goto(
                  `http://127.0.0.1:3100/dashboard/ai-visibility/websites/${completedProjectId}/assets?asset=${uncertain.link.id}`,
                );
                const uncertainResponse = page.waitForResponse((response) =>
                  response.url().endsWith('/cms-drafts'),
                );
                await page
                  .getByRole('button', {
                    name: 'Create wordpress draft',
                    exact: true,
                  })
                  .click();
                expect((await uncertainResponse).status()).toBe(502);
                cmsMode = 'success';
                await page.reload();
                const reconcileResponse = page.waitForResponse((response) =>
                  response.url().endsWith('/cms-drafts'),
                );
                await page
                  .getByRole('button', {
                    name: 'Reconcile wordpress draft',
                    exact: true,
                  })
                  .click();
                expect((await reconcileResponse).status()).toBe(502);
                expect(sentKeys[2]).toBe(sentKeys[1]);
                expect(cmsCreates).toBe(2);
              }
            }
            await context.close();
          }
          expect(sentVersions).toEqual([1, 1, 1]);
          expect(cmsCreates).toBe(2);
          expect(unknownApi).toEqual([]);
        } finally {
          await browser.close();
        }
      },
      240000,
    );

    (redisQa ? it : it.skip)(
      'binds GSC OAuth in real Redis and persists compared synthetic Search Console snapshots',
      async () => {
        const { project: website } = await project();
        const queries: any[] = [];
        const exchanges: URLSearchParams[] = [];
        const tokenRequests: URLSearchParams[] = [];
        // The singleton captures the guarded fetch above. Inject only Google
        // response bytes; keep the real routes, browser guards and PKCE flow.
        fixtureProviderFetch = (async (url: string, init: RequestInit) => {
          if (url === 'https://oauth2.googleapis.com/token') {
            const body = new URLSearchParams(String(init.body));
            tokenRequests.push(body);
            if (body.get('grant_type') === 'authorization_code')
              exchanges.push(body);
            return Response.json({
              access_token: 'synthetic-access',
              refresh_token: 'synthetic-refresh',
            });
          }
          if (url === 'https://www.googleapis.com/webmasters/v3/sites')
            return Response.json({
              siteEntry: [
                {
                  siteUrl: 'sc-domain:brand.example.test',
                  permissionLevel: 'siteOwner',
                },
              ],
            });
          if (url.endsWith('/searchAnalytics/query')) {
            queries.push(JSON.parse(String(init.body)));
            return Response.json({
              rows: [
                {
                  keys: ['fixture query', 'https://brand.example.test/'],
                  clicks: 2,
                  impressions: 40,
                  ctr: 0.05,
                  position: 4,
                },
              ],
            });
          }
          throw new Error('Unexpected synthetic Google request');
        }) as typeof fetch;
        const session = `${AUTH_COOKIES.user}=${generateToken({
          userId: ownerId,
          email: 'visibility-fixture@example.test',
        })}`;
        const start = async () => {
          const response = await request(app)
            .post(`/api/ai-visibility/projects/${website.id}/gsc/auth-url`)
            .set('Cookie', session);
          expect(response.status).toBe(200);
          expect(response.headers['cache-control']).toContain('no-store');
          const url = new URL(response.body.url);
          expect(url.searchParams.get('scope')).toBe(
            'https://www.googleapis.com/auth/webmasters.readonly',
          );
          expect(url.searchParams.get('code_challenge_method')).toBe('S256');
          expect(url.searchParams.get('code_challenge')).toMatch(
            /^[A-Za-z0-9_-]{43}$/,
          );
          expect(url.searchParams.has('code_verifier')).toBe(false);
          const cookie = (
            response.headers['set-cookie'] as unknown as string[]
          ).find((value) => value.startsWith('oauth_flow_'))!;
          expect(cookie).toContain('HttpOnly');
          expect(cookie).toContain('SameSite=Lax');
          return {
            url,
            state: url.searchParams.get('state')!,
            cookies: [session, cookie.split(';')[0]],
          };
        };
        type Flow = Awaited<ReturnType<typeof start>>;
        const callback = (
          flow: Flow,
          query: Record<string, string>,
          cookies = flow.cookies,
        ) =>
          request(app)
            .get('/api/ai-visibility/gsc/oauth/callback')
            .set('Cookie', cookies)
            .query({ state: flow.state, ...query });

        const cancelled = await start();
        const denied = await callback(cancelled, { error: 'access_denied' });
        expect(denied.status).toBe(302);
        expect(denied.headers.location).toContain(
          `/websites/${website.id}/seo`,
        );
        expect(new URL(denied.headers.location).searchParams.get('gsc')).toBe(
          'error',
        );
        expect(exchanges).toHaveLength(0);
        const cancelledReplay = await callback(cancelled, {
          code: 'cancelled-replay',
        });
        expect(
          new URL(cancelledReplay.headers.location).searchParams.get('gsc'),
        ).toBe('error');
        expect(exchanges).toHaveLength(0);

        // Cancellation consumes its flow. A successful connection must begin
        // fresh, and a different browser or tampered state cannot exchange it.
        const flow = await start();
        const differentBrowser = [
          session,
          `${flow.cookies[1].split('=')[0]}=different-browser`,
        ];
        const rejectedBrowser = await callback(
          flow,
          { code: 'wrong-browser' },
          differentBrowser,
        );
        expect(
          new URL(rejectedBrowser.headers.location).searchParams.get('gsc'),
        ).toBe('error');
        const rejectedState = await callback(flow, {
          state: `${flow.state}tampered`,
          code: 'wrong-state',
        });
        expect(
          new URL(rejectedState.headers.location).searchParams.get('gsc'),
        ).toBe('error');
        expect(exchanges).toHaveLength(0);

        const connected = await callback(flow, { code: 'synthetic-code' });
        expect(connected.status).toBe(302);
        expect(connected.headers['cache-control']).toContain('no-store');
        expect(connected.headers['referrer-policy']).toBe('no-referrer');
        expect(
          new URL(connected.headers.location).searchParams.get('gsc'),
        ).toBe('connected');
        expect(exchanges).toHaveLength(1);
        const verifier = exchanges[0].get('code_verifier')!;
        expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
          flow.url.searchParams.get('code_challenge'),
        );
        const replayed = await callback(flow, {
          code: 'fresh-code-reusing-state',
        });
        expect(new URL(replayed.headers.location).searchParams.get('gsc')).toBe(
          'error',
        );
        expect(exchanges).toHaveLength(1);
        expect(
          (
            await scope(() =>
              googleSearchConsoleService.overview(ownerId, website.id),
            )
          ).connection?.selectedProperty,
        ).toBe('sc-domain:brand.example.test');
        const sync = await scope(() =>
          googleSearchConsoleService.sync(ownerId, website.id, {
            startDate: '2026-10-01',
            endDate: '2026-10-10',
            compare: true,
          }),
        );
        expect(sync.comparisonSnapshotId).toBeGreaterThan(0);
        expect(sync.rowCount).toBe(1);
        expect(queries.map((q) => [q.startDate, q.endDate])).toEqual([
          ['2026-09-21', '2026-09-30'],
          ['2026-10-01', '2026-10-10'],
        ]);
        await expect(
          scope(() =>
            googleSearchConsoleService.selectProperty(
              ownerId,
              website.id,
              'sc-domain:other.example.test',
            ),
          ),
        ).rejects.toThrow('Choose a property');
        const savedCredential = credentials.get('google_search_console')!;
        expect(savedCredential.apiKey).toBe('synthetic-client');
        const requestedTokens = tokenRequests.length;
        savedCredential.apiKey = 'different-client';
        try {
          await expect(
            scope(() =>
              googleSearchConsoleService.sync(ownerId, website.id, {
                startDate: '2026-10-01',
                endDate: '2026-10-10',
              }),
            ),
          ).rejects.toThrow('settings changed');
          expect(tokenRequests).toHaveLength(requestedTokens);
        } finally {
          savedCredential.apiKey = 'synthetic-client';
        }
        expect(fees).toEqual([]);
      },
    );

    it.each(['success', 'shopify_existing'])(
      'creates or reconciles an exact unpublished Shopify draft: %s',
      async (mode) => {
        const { p, link } = await approvedAsset();
        cmsMode = mode;
        const result = await scope(() =>
          cmsDraftPublishingService.createDraft(
            ownerId,
            p.id,
            link.id,
            'shopify',
            crypto.randomUUID(),
            1,
          ),
        );
        expect(result.status).toBe('draft_created');
        expect(cmsCreates).toBe(mode === 'success' ? 1 : 0);
        expect(result.reconciliationCount).toBe(
          mode === 'shopify_existing' ? 1 : 0,
        );
      },
    );

    it('resumes a running audit from its committed stage checkpoint', async () => {
      const { id } = await audit();
      await scope(async () => {
        await database
          .update(tables.aiVisibilityAuditsTable)
          .set({ status: 'running', startedAt: new Date() })
          .where(eq(tables.aiVisibilityAuditsTable.id, id));
        await database
          .update(tables.aiVisibilityAuditStagesTable)
          .set({
            status: 'completed',
            attemptCount: 1,
            output: { durable: true },
          })
          .where(
            and(
              eq(tables.aiVisibilityAuditStagesTable.auditId, id),
              eq(tables.aiVisibilityAuditStagesTable.stageKey, 'intake'),
            ),
          );
        expect((await new AuditOrchestrator().run(id, ownerId)).status).toMatch(
          /^completed/,
        );
        const intake = (
          await aiVisibilityService.getAudit(ownerId, id)
        ).stages.find((s: any) => s.stageKey === 'intake');
        expect(intake.attemptCount).toBe(1);
        expect(intake.output).toEqual({ durable: true });
      });
    }, 30000);

    it('cancels before collection, refunds only the synthetic base transaction and stays terminal on retry', async () => {
      const { id } = await audit();
      await scope(() => aiVisibilityService.cancelAudit(ownerId, id));
      expect(
        (await scope(() => new AuditOrchestrator().run(id, ownerId))).status,
      ).toBe('cancelled');
      const saved = await scope(() =>
        aiVisibilityService.getAudit(ownerId, id),
      );
      expect(Number(saved.actualCredits)).toBe(0);
      expect(fees.filter((f: any) => f.refund)).toHaveLength(1);
      expect(providerCalls).toBe(0);
      await scope(() => new AuditOrchestrator().run(id, ownerId));
      expect(fees.filter((f: any) => f.refund)).toHaveLength(1);
    });

    it('ingests and reloads a synthetic commerce feed and freezes the catalog version for a new audit', async () => {
      const { project: p } = await project();
      const feed = (id: string) => ({
        originalname: 'fixture-products.json',
        mimetype: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            products: [
              {
                id,
                title: 'Fixture widget',
                description: 'Synthetic product',
                image: 'https://brand.example.test/widget.jpg',
                price: 10,
                currency: 'USD',
                availability: 'in_stock',
                variants: ['blue'],
                shipping: 'free',
                returns: '30 days',
                reviews: 12,
              },
            ],
          }),
        ),
      });
      const first = await scope(() =>
        aiVisibilityService.ingestCommerceFeed(ownerId, p.id, feed('sku-1')),
      );
      expect(first.validItemCount).toBe(1);
      const held = await scope(() =>
        aiVisibilityService.createAudit(ownerId, p.id),
      );
      await scope(() =>
        aiVisibilityService.ingestCommerceFeed(ownerId, p.id, feed('sku-2')),
      );
      expect(
        (
          await scope(() =>
            aiVisibilityService.getAudit(ownerId, held.resource.id),
          )
        ).inputSnapshot.commerceSnapshotId,
      ).toBe(first.id);
      const products = await scope(() =>
        aiVisibilityService.commerceProducts(ownerId, p.id, {
          snapshotId: first.id,
          offset: 0,
          limit: 20,
        }),
      );
      expect(products.products[0].identifier).toBe('sku-1');
      expect(
        (await scope(() => aiVisibilityService.commerce(ownerId, p.id)))
          .latestSnapshot.id,
      ).not.toBe(first.id);
    });
  },
);
