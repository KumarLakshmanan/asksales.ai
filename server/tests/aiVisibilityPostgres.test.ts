import { getIntegrationOAuthCallbackUrl } from '../utils/integrationUrls.js';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

process.env.JWT_SECRET ||= 'ai-visibility-fixture-signing-only';
const connectionString = process.env.AI_VISIBILITY_QA_DATABASE_URL;
if (connectionString && !new URL(connectionString).pathname.includes('_ai_visibility_qa_'))
  throw new Error('Use a disposable AI Visibility QA database.');
const describeDatabase = connectionString ? describe : describe.skip;
let pool: Pool;
let database: NodePgDatabase;
let projectId: number, workspaceId: number, auditId: number, credentialId: number;
const assetIds: number[] = [];
const credentials = new Map<string, Record<string, unknown>>();
let wordpressCreates = 0;
const cmsRequests: Array<{ url: string; body?: string }> = [];

jest.unstable_mockModule('../models/db.js', () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        const value = database[key as keyof NodePgDatabase];
        return typeof value === 'function' ? value.bind(database) : value;
      },
    },
  ),
}));
jest.unstable_mockModule('../services/emailService.js', () => ({
  emailService: {
    sendEmailWithUserCredentials: async () => {
      throw new Error('Email is outside this fixture.');
    },
  },
}));
jest.unstable_mockModule('../services/credentialService.js', () => ({
  getCredential: async (_user: number, platform: string) => credentials.get(platform) || null,
  saveCredential: async (
    _user: number,
    platform: string,
    apiKey: string,
    apiSecret: string | undefined,
    config: Record<string, unknown>,
  ) => {
    credentials.set(platform, { id: credentialId, apiKey, apiSecret, config });
    return true;
  },
  deleteCredential: async (_user: number, platform: string) => credentials.delete(platform),
}));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  getActiveAdminCredential: async () => ({
    id: 1,
    apiKey: 'fixture-client',
    apiSecret: 'fixture-secret',
  }),
  getAllActiveAdminCredentials: async () => [],
  updateAdminCredentialLastUsed: async () => {},
}));
jest.unstable_mockModule('../utils/safeRemoteFetch.js', () => ({
  fetchPublicHttpUrl: async (url: string, options: { body?: string }) => {
    cmsRequests.push({ url, body: options.body });
    let body: unknown;
    if (url === 'https://cms-fixture.example/wp-json/wp/v2/users/me?context=edit')
      body = { id: 1, name: 'Fixture editor' };
    else if (url.startsWith('https://cms-fixture.example/wp-json/wp/v2/posts?')) body = [];
    else if (url === 'https://cms-fixture.example/wp-json/wp/v2/posts') {
      wordpressCreates++;
      body = {
        id: 501,
        status: 'draft',
        link: 'https://cms-fixture.example/?p=501',
      };
    } else if (url === 'https://catalog-fixture.myshopify.com/admin/api/2026-07/graphql.json')
      body = { data: { shop: { name: 'Fixture catalog' } } };
    else throw new Error(`Unexpected fixture HTTP request: ${url}`);
    return {
      response: new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      finalUrl: url,
      redirectCount: 0,
      redirectChain: [],
    };
  },
  readResponseBuffer: async (response: Response) => Buffer.from(await response.arrayBuffer()),
  assertPublicHttpUrl: async (url: string) => new URL(url),
}));
const { aiVisibilityService } = await import('../services/aiVisibility/AiVisibilityService.js');
const { aiVisibilityWorkspaceService } =
  await import('../services/aiVisibility/AiVisibilityWorkspaceService.js');
const { cmsDraftPublishingService } =
  await import('../services/aiVisibility/CmsDraftPublishingService.js');
const { GoogleSearchConsoleService, signGscOAuthState } =
  await import('../services/aiVisibility/GoogleSearchConsoleService.js');
const { oauthConfigurationHash } = await import('../services/OAuthBrowserFlowService.js');
const tables = await import('../models/aiVisibility/schema.js');
const { withBusinessScope } = await import('../tenancy/businessContext.js');
const { withBillingScope } = await import('../tenancy/billingContext.js');
const { createBusinessScopedPool } = await import('../tenancy/scopedPool.js');

// The fixture owner (user 1) acts inside its own business profile and billing organization,
// the same way the authenticated request pipeline does for production traffic.
let profileId = 0;
let organizationId = 0;
function scope<T>(work: () => T): T {
  return withBusinessScope(
    { userId: 1, businessProfileId: profileId, actorUserId: 1, role: 'owner' },
    () => withBillingScope({ organizationId, actorUserId: 1 }, work),
  );
}
const scopedIt = (name: string, work: () => Promise<unknown>) => it(name, () => scope(work));

async function brief() {
  const question = await aiVisibilityService.createAeoQuestion(1, projectId, {
    question: 'What is the verified cancellation policy for this service?',
  });
  const asset = await aiVisibilityService.generateAeoQuestionAsset(
    1,
    projectId,
    question.id,
    'research_brief',
  );
  assetIds.push(asset.id);
  const link = (await aiVisibilityService.assets(1, projectId)).find(
    (item: { contentAssetId: number }) => item.contentAssetId === asset.id,
  )!;
  return { asset, link };
}

// Creates the owner, billing organization, business profile and a credential reference when
// the disposable QA database does not already have them. Runs under the system scope, as the
// application's own provisioning does, and leaves existing rows untouched.
async function seedQaFixtures(): Promise<void> {
  const admin = await pool.connect();
  try {
    await admin.query("SELECT set_config('app.business_system','on',false)");
    await admin.query(
      `INSERT INTO users (id, email, name) VALUES (1, 'ai-visibility-qa@example.test', 'AI Visibility QA')
       ON CONFLICT (id) DO NOTHING`,
    );
    await admin.query(
      `SELECT setval(pg_get_serial_sequence('users','id'), GREATEST((SELECT max(id) FROM users), 1))`,
    );
    organizationId = (await admin.query('SELECT billing_default_organization(1) AS id')).rows[0].id;
    await admin.query(
      `INSERT INTO company_settings (user_id, billing_organization_id)
       SELECT 1, $1 WHERE NOT EXISTS (SELECT 1 FROM company_settings WHERE user_id = 1)`,
      [organizationId],
    );
    profileId = (
      await admin.query('SELECT id FROM company_settings WHERE user_id = 1 ORDER BY id LIMIT 1')
    ).rows[0].id;
    await admin.query(
      `INSERT INTO api_credentials (user_id, service_name, config, business_profile_id)
       SELECT 1, 'ai_visibility_qa_fixture', '{}'::jsonb, $1
       WHERE NOT EXISTS (SELECT 1 FROM api_credentials WHERE user_id = 1)`,
      [profileId],
    );
    credentialId = (
      await admin.query('SELECT id FROM api_credentials WHERE user_id = 1 ORDER BY id LIMIT 1')
    ).rows[0].id;
  } finally {
    await admin.query("SELECT set_config('app.business_system','off',false)").catch(() => {});
    admin.release();
  }
}

describeDatabase('AI Visibility real PostgreSQL acceptance (external HTTP fixtures)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 5 });
    await seedQaFixtures();
    database = drizzle(createBusinessScopedPool(pool));
    await scope(async () => {
      const project = await aiVisibilityService.createProject(1, {
        name: `Visibility integration fixture ${Date.now()}`,
        domain: 'https://visibility-fixture.example',
        country: 'IN',
        locale: 'en-IN',
      });
      projectId = project.id;
      workspaceId = project.workspaceId;
      const [audit] = await database
        .insert(tables.aiVisibilityAuditsTable)
        .values({
          projectId,
          userId: 1,
          status: 'completed',
          inputSnapshot: { project },
          completedAt: new Date(),
        })
        .returning();
      auditId = audit.id;
    });
  });
  afterAll(async () => {
    if (!pool) return;
    const admin = await pool.connect();
    try {
      await admin.query("SELECT set_config('app.business_system','on',false)");
      if (projectId)
        await admin.query('DELETE FROM ai_visibility_projects WHERE id=$1', [projectId]);
      if (workspaceId)
        await admin.query('DELETE FROM ai_visibility_workspaces WHERE id=$1', [workspaceId]);
      if (assetIds.length)
        await admin.query('DELETE FROM content_assets WHERE id=ANY($1::int[])', [assetIds]);
    } finally {
      admin.release();
      await pool.end();
    }
  });
  scopedIt('persists excluded and skipped provider outcomes without violating the migrated constraints', async () => {
    const [prompt] = await database
      .insert(tables.aiVisibilityPromptsTable)
      .values({
        userId: 1,
        projectId,
        auditId,
        kind: 'geo',
        intent: 'discovery',
        prompt: 'Fixture prompt',
        normalizedPrompt: 'fixture prompt',
        promptHash: 'a'.repeat(64),
        locale: 'en-IN',
        isGeneric: true,
      })
      .returning();
    await database.insert(tables.aiVisibilityPromptRunsTable).values([
      {
        userId: 1,
        auditId,
        promptId: prompt.id,
        provider: 'openai',
        model: 'unconfigured',
        status: 'excluded',
        fidelity: 'live_api',
      },
      {
        userId: 1,
        auditId,
        promptId: prompt.id,
        provider: 'gemini',
        model: 'fixture-model',
        status: 'skipped',
        fidelity: 'live_api',
      },
    ]);
    const result = await aiVisibilityService.prompts(1, projectId, 'geo');
    expect(result.runs.map((item: { status: string }) => item.status).sort()).toEqual([
      'excluded',
      'skipped',
    ]);
    await expect(
      aiVisibilityService.correctPromptRun(1, result.runs[0].id, {
        brandMentioned: true,
      }),
    ).rejects.toThrow('Only a collected provider answer');
  });
  scopedIt('runs question → research brief → concurrent edits → exact-version approval → CMS draft with durable idempotency', async () => {
    const { asset, link } = await brief();
    expect(asset.type).toBe('content_brief');
    expect(asset.content).toContain('an answer has not been verified');
    const attempts = await Promise.allSettled([
      aiVisibilityService.editAsset(1, projectId, link.id, 1, {
        version: 1,
        title: 'Editorial brief A',
        content:
          'Reviewed research brief A. Source verification is still required before publishing an answer.',
      }),
      aiVisibilityService.editAsset(1, projectId, link.id, 1, {
        version: 1,
        title: 'Editorial brief B',
        content:
          'Reviewed research brief B. Source verification is still required before publishing an answer.',
      }),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const versions = await aiVisibilityService.assetVersions(1, projectId, link.id);
    expect(versions.map((item: { version: number }) => item.version)).toEqual([2, 1]);
    await expect(
      aiVisibilityWorkspaceService.decideAsset(1, projectId, link.id, {
        decision: 'approved',
        assetVersion: 1,
      }),
    ).rejects.toThrow('version not found');
    await cmsDraftPublishingService.saveConnection(1, projectId, {
      platform: 'wordpress',
      siteUrl: 'https://cms-fixture.example',
      username: 'fixture',
      applicationPassword: 'fixture-not-real',
    });
    await expect(
      cmsDraftPublishingService.createDraft(
        1,
        projectId,
        link.id,
        'wordpress',
        crypto.randomUUID(),
      ),
    ).rejects.toThrow('Approve');
    const decision = await aiVisibilityWorkspaceService.decideAsset(1, projectId, link.id, {
      decision: 'approved',
      comment: 'Approved as an internal research brief, not finished customer copy.',
      assetVersion: 2,
    });
    expect(decision.asset.version).toBe(2);
    const intent = crypto.randomUUID();
    const first = await cmsDraftPublishingService.createDraft(
      1,
      projectId,
      link.id,
      'wordpress',
      intent,
    );
    const second = await cmsDraftPublishingService.createDraft(
      1,
      projectId,
      link.id,
      'wordpress',
      intent,
    );
    expect(first.status).toBe('draft_created');
    expect(second.id).toBe(first.id);
    expect(wordpressCreates).toBe(1);
    const body = JSON.parse(cmsRequests.find((item) => item.url.endsWith('/posts'))!.body!);
    expect(body.status).toBe('draft');
    expect(first.reviewedPayload.assetVersion).toBe(2);
    await aiVisibilityService.editAsset(1, projectId, link.id, 1, {
      version: 2,
      title: 'Revised brief',
      content: 'This third version needs its own review and approval.',
    });
    await expect(
      cmsDraftPublishingService.createDraft(
        1,
        projectId,
        link.id,
        'wordpress',
        crypto.randomUUID(),
      ),
    ).rejects.toThrow('Approve');
    const history = await aiVisibilityWorkspaceService.approvalHistory(1, projectId);
    expect(history[0].decision.assetVersion).toBe(2);
    expect(history[0].decision.comment).toContain('internal research brief');
  });
  scopedIt('connects a Shopify catalog without blog settings and refuses article publishing until configured', async () => {
    const connection = await cmsDraftPublishingService.saveConnection(1, projectId, {
      platform: 'shopify',
      storeDomain: 'catalog-fixture.myshopify.com',
      accessToken: 'fixture-token',
    });
    expect(connection.connected).toBe(true);
    expect(connection.publishingReady).toBe(false);
    const { link } = await brief();
    await aiVisibilityWorkspaceService.decideAsset(1, projectId, link.id, {
      decision: 'approved',
      assetVersion: 1,
    });
    await expect(
      cmsDraftPublishingService.createDraft(1, projectId, link.id, 'shopify', crypto.randomUUID()),
    ).rejects.toThrow('Connect a Shopify blog');
  });
  scopedIt('completes signed GSC OAuth, persists compared date ranges, and exposes more than 50 opportunities', async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        ...(url.endsWith('/query') ? { body: JSON.parse(String(init?.body)) } : {}),
      });
      if (url === 'https://oauth2.googleapis.com/token')
        return Response.json({
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
        });
      if (url === 'https://www.googleapis.com/webmasters/v3/sites')
        return Response.json({
          siteEntry: [
            {
              siteUrl: 'sc-domain:visibility-fixture.example',
              permissionLevel: 'siteOwner',
            },
          ],
        });
      if (url.endsWith('/searchAnalytics/query'))
        return Response.json({
          rows: Array.from({ length: 75 }, (_, index) => ({
            keys: [`fixture query ${index}`, `https://visibility-fixture.example/page-${index}`],
            clicks: 2,
            impressions: 200,
            ctr: 0.01,
            position: 8,
          })),
        });
      throw new Error(`Unexpected Google fixture endpoint: ${url}`);
    };
    const gsc = new GoogleSearchConsoleService(fakeFetch);
    const connected = await gsc.completeOAuth(
      'fixture-code',
      signGscOAuthState({ userId: 1, projectId }),
      { codeVerifier: 'synthetic-gsc-verifier', configHash: oauthConfigurationHash(['fixture-client','fixture-secret',getIntegrationOAuthCallbackUrl('googleSearchConsole')]) },
    );
    expect(connected.selectedProperty).toBe('sc-domain:visibility-fixture.example');
    expect(gsc.callbackRedirect(connected)).toContain(`/websites/${projectId}/seo?gsc=connected`);
    await gsc.sync(1, projectId, {
      startDate: '2026-08-10',
      endDate: '2026-08-16',
      compare: true,
    });
    const result = await gsc.overview(1, projectId);
    expect(result.opportunities).toHaveLength(75);
    expect(result.rows).toHaveLength(75);
    expect(result.comparison?.snapshot.startDate).toBe('2026-08-03');
    expect(result.comparison?.snapshot.endDate).toBe('2026-08-09');
    expect(
      requests.filter((item) => item.url.endsWith('/query')).map((item) => item.body?.startDate),
    ).toEqual(['2026-08-03', '2026-08-10']);
    await expect(gsc.selectProperty(1, projectId, 'sc-domain:unowned.example')).rejects.toThrow();
    await expect(
      gsc.sync(1, projectId, {
        startDate: '2026-01-01',
        endDate: '2026-08-16',
      }),
    ).rejects.toThrow('1–90 days');
  });
  scopedIt('persists every generated fix, including a critical issue after the first forty', async () => {
    const { auditOrchestrator } = await import('../services/aiVisibility/AuditOrchestrator.js');
    const [project] = await database
      .select()
      .from(tables.aiVisibilityProjectsTable)
      .where(eq(tables.aiVisibilityProjectsTable.id, projectId));
    const [audit] = await database
      .insert(tables.aiVisibilityAuditsTable)
      .values({
        projectId,
        userId: 1,
        status: 'completed',
        inputSnapshot: { project },
        completedAt: new Date(),
      })
      .returning();
    await database.insert(tables.aiVisibilitySeoIssuesTable).values(
      Array.from({ length: 81 }, (_, index) => ({
        auditId: audit.id,
        projectId,
        userId: 1,
        ruleId: 'metadata.missing_title',
        group: 'on_page',
        severity: index === 80 ? 'critical' : 'low',
        affectedUrl: `https://visibility-fixture.example/page-${index}`,
        recommendation: `Fix fixture page ${index}`,
      })),
    );
    await (
      auditOrchestrator as unknown as {
        fixGeneration(context: { audit: typeof audit; project: typeof project }): Promise<unknown>;
      }
    ).fixGeneration({ audit, project });
    const rows = await database
      .select()
      .from(tables.aiVisibilityRecommendationsTable)
      .where(eq(tables.aiVisibilityRecommendationsTable.auditId, audit.id));
    expect(rows).toHaveLength(81);
    expect(rows.find((row) => row.affectedUrl?.endsWith('/page-80'))).toMatchObject({
      severity: 'critical',
      status: 'open',
      verificationStatus: 'unverified',
    });
    expect(new Set(rows.map((row) => row.issueKey)).size).toBe(81);
  });
  scopedIt('versions a manual correction while preserving the raw answer and historical score', async () => {
    const [prompt] = await database
      .insert(tables.aiVisibilityPromptsTable)
      .values({
        userId: 1,
        projectId,
        auditId,
        kind: 'geo',
        intent: 'discovery',
        prompt: 'Correction fixture',
        normalizedPrompt: 'correction fixture',
        promptHash: 'b'.repeat(64),
        locale: 'en-IN',
        isGeneric: true,
      })
      .returning();
    const [run] = await database
      .insert(tables.aiVisibilityPromptRunsTable)
      .values({
        userId: 1,
        auditId,
        promptId: prompt.id,
        provider: 'gemini',
        model: 'fixture-model',
        status: 'completed',
        fidelity: 'live_api',
        answer: 'Raw fixture answer names Example brand.',
        brandMentioned: false,
        extractionStatus: 'completed',
      })
      .returning();
    const [score] = await database
      .insert(tables.aiVisibilityScoreSnapshotsTable)
      .values({
        userId: 1,
        projectId,
        auditId,
        scoringProfile: 'general',
        inputFingerprint: 'c'.repeat(64),
        overallScore: '50',
        geoScore: '0',
        pillarStatuses: { geo: 'scored' },
      })
      .returning();
    await aiVisibilityService.correctPromptRun(1, run.id, { brandMentioned: true, brandRank: 1 });
    const [corrected] = await database
      .select()
      .from(tables.aiVisibilityPromptRunsTable)
      .where(eq(tables.aiVisibilityPromptRunsTable.id, run.id));
    const [correctedAudit] = await database
      .select()
      .from(tables.aiVisibilityAuditsTable)
      .where(eq(tables.aiVisibilityAuditsTable.id, auditId));
    const [unchangedScore] = await database
      .select()
      .from(tables.aiVisibilityScoreSnapshotsTable)
      .where(eq(tables.aiVisibilityScoreSnapshotsTable.id, score.id));
    expect(corrected).toMatchObject({
      answer: run.answer,
      brandMentioned: true,
      brandRank: 1,
      extractionStatus: 'corrected',
    });
    expect(correctedAudit.correctionRevision).toBe(1);
    expect(correctedAudit.correctedAt).toBeInstanceOf(Date);
    expect(unchangedScore).toEqual(score);
    expect(
      (await aiVisibilityService.reports(1, projectId)).find(
        (report: { auditId: number }) => report.auditId === auditId,
      ),
    ).toMatchObject({ correctionRevision: 1 });
  });
  scopedIt('returns a failed report stage even when storage failed before a report row could be created', async () => {
    await database.insert(tables.aiVisibilityAuditStagesTable).values({
      userId: 1,
      auditId,
      stageKey: 'report_generation',
      status: 'warning',
      attemptCount: 2,
      warning: 'Storage limit exceeded. Fixture quota.',
    });
    const report = (await aiVisibilityService.reports(1, projectId)).find(
      (item: { auditId: number }) => item.auditId === auditId,
    );
    expect(report).toMatchObject({
      status: 'missing',
      error: 'Storage limit exceeded. Fixture quota.',
      generationAttempt: 2,
      generationStatus: 'warning',
    });
  });
  scopedIt('exports complete evidence without report storage identifiers', async () => {
    await database
      .update(tables.aiVisibilityAuditStagesTable)
      .set({
        output: {
          storageFileId: 123,
          storageKey: 'private/report.pdf',
          rawHtmlKey: 'private/page.html',
          reportCreated: true,
        },
      })
      .where(eq(tables.aiVisibilityAuditStagesTable.auditId, auditId));
    const exported = await aiVisibilityService.exportAuditEvidence(1, auditId);
    const stage = exported.audit.stages.find(
      (item: typeof tables.aiVisibilityAuditStagesTable.$inferSelect) =>
        item.stageKey === 'report_generation',
    );
    expect(stage?.output).toEqual({ reportCreated: true });
    expect(JSON.stringify(exported)).not.toMatch(/"(storageFileId|storageKey|rawHtmlKey)":/);
  });
  scopedIt('discovers competitors in the same analysis, preserves manual exclusions, and resumes without duplicates', async () => {
    const { discoverAuditCompetitors, auditCompetitors } =
      await import('../services/aiVisibility/CompetitorDiscoveryService.js');
    const [project] = await database
      .select()
      .from(tables.aiVisibilityProjectsTable)
      .where(eq(tables.aiVisibilityProjectsTable.id, projectId));
    const manual = await aiVisibilityService.addCompetitor(1, projectId, {
      name: 'Manual',
      domain: 'https://manual.example',
    });
    const disabled = await aiVisibilityService.addCompetitor(1, projectId, {
      name: 'Disabled',
      domain: 'https://disabled.example',
    });
    await aiVisibilityService.updateCompetitor(1, projectId, disabled.id, { active: false });
    const inputSnapshot = {
      project,
      competitors: [manual, { ...disabled, active: false }],
      competitorDiscoveryLimit: 5,
    };
    const [audit] = await database
      .insert(tables.aiVisibilityAuditsTable)
      .values({
        userId: 1,
        projectId,
        status: 'running',
        inputSnapshot,
      })
      .returning();
    await database
      .insert(tables.aiVisibilityAuditStagesTable)
      .values({ auditId: audit.id, userId: 1, stageKey: 'competitor_analysis' });
    const request = {
      audit,
      project,
      observations: [
        {
          id: 1,
          provider: 'gemini',
          competitors: ['Rival', 'Disabled', 'Unverified Name'],
          citations: [
            { url: 'https://rival.example/product' },
            { url: 'https://disabled.example/' },
            { url: 'https://directory.example/unverified' },
          ],
          capturedAt: new Date(),
        },
      ],
    };
    const discovered = await discoverAuditCompetitors(request);
    expect(discovered.discoveredCompetitors).toHaveLength(1);
    expect(discovered.discoveredCompetitors[0]).toMatchObject({
      name: 'Rival',
      domain: 'https://rival.example',
      active: true,
    });
    const again = await discoverAuditCompetitors(request);
    expect(again.discoveredCompetitors.map((item: { id: number }) => item.id)).toEqual(
      discovered.discoveredCompetitors.map((item: { id: number }) => item.id),
    );
    expect((await auditCompetitors(audit)).map((item) => item.name).sort()).toEqual([
      'Manual',
      'Rival',
    ]);
    const [stored] = await database
      .select()
      .from(tables.aiVisibilityAuditsTable)
      .where(eq(tables.aiVisibilityAuditsTable.id, audit.id));
    expect(stored.inputSnapshot).toEqual(JSON.parse(JSON.stringify(inputSnapshot)));
    expect(
      (await aiVisibilityService.listCompetitors(1, projectId)).find(
        (item: { id: number }) => item.id === disabled.id,
      )?.active,
    ).toBe(false);
    const { auditOrchestrator } = await import('../services/aiVisibility/AuditOrchestrator.js');
    const engine = auditOrchestrator as unknown as {
      crawlCompetitors(
        context: unknown,
        selected?: Array<{ name: string }>,
      ): Promise<{ output: Record<string, unknown> }>;
      competitorAnalysis(context: unknown): Promise<{ output: Record<string, unknown> }>;
    };
    const crawl = jest
      .spyOn(engine, 'crawlCompetitors')
      .mockResolvedValue({ output: { competitors: 1 } });
    try {
      const result = await engine.competitorAnalysis({ audit, project });
      expect(crawl).toHaveBeenCalledWith(
        { audit, project },
        expect.arrayContaining([expect.objectContaining({ name: 'Rival' })]),
      );
      expect(result.output.competitors).toBe(2);
      const snapshots = await database
        .select()
        .from(tables.aiVisibilityCompetitorSnapshotsTable)
        .where(eq(tables.aiVisibilityCompetitorSnapshotsTable.auditId, audit.id));
      expect(snapshots).toHaveLength(2);
    } finally {
      crawl.mockRestore();
    }
  });
});
