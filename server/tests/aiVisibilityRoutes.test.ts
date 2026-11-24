import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { currentBusinessScope } from '../tenancy/businessContext.js';

type AsyncMock = ReturnType<typeof jest.fn<(...args: unknown[]) => Promise<unknown>>>;
const asyncMock = (): AsyncMock => jest.fn<(...args: unknown[]) => Promise<unknown>>();
const businessScope = { userId: 42, actorUserId: 42, businessProfileId: 2, role: 'owner' as const };
const oauthBinding = jest.fn<(key: string) => Promise<string | null>>();
const oauthStore = new Map<string,string>();
const oauthUser = jest.fn<() => Promise<{id:number;deletedAt:null;passwordChangedAt:null} | null>>();
const scopeLookup = jest.fn<(query: SQL) => Promise<{ rows: Record<string, unknown>[] }>>();
const dialect = new PgDialect();
// Keep real browser/session/PKCE and public/business scope middleware. Only local stores are fixtures.
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => ({
  get: async (key:string) => oauthStore.get(key) ?? null,
  set: async (key:string,value:string) => {oauthStore.set(key,value);return 'OK';},
  eval: async (_script:string,_count:number,key:string,expected?:string) => {
    if(key.startsWith('oauth:business:')) return oauthBinding(key);
    const value=oauthStore.get(key);if(expected && value!==expected)return null;
    oauthStore.delete(key);return value ?? null;
  },
}) }));
jest.unstable_mockModule('../models/users/functions.js',()=>({getUserById:oauthUser}));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: scopeLookup } }));
const importBlogForCmsReview = asyncMock();
jest.unstable_mockModule('../services/aiVisibility/ContentLibraryCmsReviewService.js', () => ({ importBlogForCmsReview }));

const moduleAccessKeys: string[] = [];
let authenticated = true;
const aiVisibilityService = {
  listProjects: asyncMock(), listWebsiteSearches: asyncMock(), resolveWebsiteSearch: asyncMock(), listBusinessProfiles: asyncMock(), resolveProject: asyncMock(), createProject: asyncMock(), getProject: asyncMock(), updateProject: asyncMock(), archiveProject: asyncMock(),
  listCompetitors: asyncMock(), suggestCompetitors: asyncMock(), competitorIntelligence: asyncMock(), generateCompetitorGapBrief: asyncMock(), addCompetitor: asyncMock(), updateCompetitor: asyncMock(), estimateAudit: asyncMock(),
  createAudit: asyncMock(), markAuditDispatchFailed: asyncMock(), listAudits: asyncMock(), getAudit: asyncMock(),
  cancelAudit: asyncMock(), overview: asyncMock(), seo: asyncMock(), prompts: asyncMock(), listAeoQuestions: asyncMock(),
  createAeoQuestion: asyncMock(), updateAeoQuestion: asyncMock(), aeoCoverage: asyncMock(), generateAeoQuestionAsset: asyncMock(), commerce: asyncMock(), ingestCommerceFeed: asyncMock(), ingestShopifyCatalog: asyncMock(),
  recommendations: asyncMock(), updateRecommendation: asyncMock(), generateRecommendationAsset: asyncMock(),
  correctPromptRun: asyncMock(), reports: asyncMock(), getReport: asyncMock(), getSharedReport: asyncMock(), exportAuditCsv: asyncMock(), listReportShares: asyncMock(), createReportShare: asyncMock(), revokeReportShare: asyncMock(), listReportDeliveries: asyncMock(), sendReportEmail: asyncMock(), assets: asyncMock(), alerts: asyncMock(),
  acknowledgeAlert: asyncMock(), updateMonitoring: asyncMock(), providerStatus: asyncMock(), workspaceAssignees: asyncMock(), assetVersions: asyncMock(), editAsset: asyncMock(), commerceProducts: asyncMock(), exportAuditEvidence: asyncMock(),
};
const addJob = asyncMock();
const refundDeduction = asyncMock();
const downloadFile = asyncMock();
const cmsDraftPublishingService = {
  connections: asyncMock(), saveConnection: asyncMock(), deleteConnection: asyncMock(), attempts: asyncMock(), createDraft: asyncMock(),
};
const verifyGscOAuthState = jest.fn<() => { userId: number; projectId: number } | null>(() => ({ userId: 42, projectId: 7 }));
const googleSearchConsoleService = {
  completeOAuth: asyncMock(), callbackRedirect: jest.fn((_result: unknown) => '/connected'), callbackErrorRedirect: jest.fn((_error: unknown, _projectId?: number) => '/error'),
  overview: asyncMock(), authorizationUrl: asyncMock(), selectProperty: asyncMock(), sync: asyncMock(), disconnect: asyncMock(),
};
const workspaceAccess = { actorUserId: 42, ownerUserId: 42, projectId: 7, workspaceId: 3, workspaceName: 'Orbit', workspaceKind: 'private', organizationId: null, role: 'owner' };
const aiVisibilityWorkspaceService = {
  listAccessibleProjects: asyncMock(), listWorkspaces: asyncMock(), createOrganization: asyncMock(), updateOrganization: asyncMock(), updateWorkspace: asyncMock(), addMember: asyncMock(), updateMember: asyncMock(),
  projectAccess: asyncMock(), auditAccess: asyncMock(), promptRunAccess: asyncMock(), decideAsset: asyncMock(), approvalHistory: asyncMock(),
  requireCapability: jest.fn(), hasCapability: jest.fn(() => true),
};

class AiVisibilityValidationError extends Error {}
class AiVisibilityNotFoundError extends Error {}
class AiVisibilityDeliveryError extends Error {}
class AiVisibilityConflictError extends Error {}
class CmsPublishingError extends Error {
  constructor(message: string, public code: string, public statusCode: number) { super(message); }
}
class GscIntegrationError extends Error {
  constructor(message: string, public statusCode: number, public code: string) { super(message); }
}
class ShopifyCatalogError extends Error {
  constructor(message: string, public code: string, public statusCode: number) { super(message); }
}
class AiVisibilityWorkspaceAccessError extends Error {
  constructor(message: string, public statusCode = 403, public code = 'AI_VISIBILITY_WORKSPACE_FORBIDDEN') { super(message); }
}

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!authenticated) return res.status(401).json({ error: 'Authentication required.' });
    req.user = { id: 42 } as express.Request['user'];
    next();
  },
}));

jest.unstable_mockModule('../middleware/platformAccess.js', () => ({
  requireModuleAccess: (key: string) => {
    moduleAccessKeys.push(key);
    return (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  },
}));

jest.unstable_mockModule('../services/aiVisibility/AiVisibilityService.js', () => ({
  AiVisibilityValidationError,
  AiVisibilityNotFoundError,
  AiVisibilityDeliveryError,
  AiVisibilityConflictError,
  aiVisibilityService,
}));

jest.unstable_mockModule('../queues/index.js', () => ({
  QUEUE_NAMES: { AI_VISIBILITY_AUDIT: 'ai-visibility-audit' },
  queueRegistry: { addJob },
}));

jest.unstable_mockModule('../services/CreditService.js', () => ({ creditService: { refundDeduction } }));
jest.unstable_mockModule('../services/StorageService.js', () => ({ storageService: { downloadFile } }));
jest.unstable_mockModule('../services/aiVisibility/CmsDraftPublishingService.js', () => ({ CmsPublishingError, cmsDraftPublishingService }));
jest.unstable_mockModule('../services/aiVisibility/GoogleSearchConsoleService.js', () => ({ GscIntegrationError, googleSearchConsoleService, verifyGscOAuthState }));
jest.unstable_mockModule('../services/aiVisibility/ShopifyCatalogService.js', () => ({ ShopifyCatalogError }));
jest.unstable_mockModule('../services/aiVisibility/AiVisibilityWorkspaceService.js', () => ({ AiVisibilityWorkspaceAccessError, aiVisibilityWorkspaceService }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

const { default: router } = await import('../routes/aiVisibility.routes.js');
const {beginOAuthBrowserFlow}=await import('../services/OAuthBrowserFlowService.js');
const {rememberOAuthBusinessState}=await import('../tenancy/oauthBusinessScope.js');
const {withBusinessScope}=await import('../tenancy/businessContext.js');
const {generateToken}=await import('../utils/jwt.js');
const {AUTH_COOKIES}=await import('../utils/authCookies.js');

const app = express();
app.use(express.json());
app.use('/api/ai-visibility', router);
app.get('/fixture/gsc-browser',async(req,res)=>{
  req.user={id:42} as express.Request['user'];
  const state=String(req.query.state);
  await withBusinessScope(businessScope,()=>rememberOAuthBusinessState(state));
  res.json(await beginOAuthBrowserFlow(req,res,'google_search_console',state,'http://localhost:8080/api/ai-visibility/gsc/oauth/callback',['synthetic-client','synthetic-secret'],true));
});
async function browserFlow(state='signed') {
  const session=`${AUTH_COOKIES.user}=${generateToken({userId:42,email:'route-fixture@example.test'})}`;
  const start=await request(app).get('/fixture/gsc-browser').set('Cookie',session).query({state});
  expect(start.status).toBe(200);expect(start.body.codeChallengeMethod).toBe('S256');
  const cookie=(start.headers['set-cookie'] as unknown as string[]).find(value=>value.startsWith('oauth_flow_'))!;
  expect(cookie).toContain('HttpOnly');expect(cookie).toContain('SameSite=Lax');
  return {state,cookies:[session,cookie.split(';')[0]],challenge:String(start.body.codeChallenge)};
}
function callback(flow:Awaited<ReturnType<typeof browserFlow>>,query:Record<string,string>,cookies=flow.cookies) {
  return request(app).get('/api/ai-visibility/gsc/oauth/callback').set('Cookie',cookies).query({state:flow.state,...query});
}

describe('AI Visibility HTTP contracts', () => {
  it('imports owned library blogs into the existing edit-gated review route without publishing', async () => {
    importBlogForCmsReview.mockResolvedValue({ linkId: 88, contentAssetId: 9, existing: false });
    const response = await request(app).post('/api/ai-visibility/projects/7/assets/import-blog').send({ contentAssetId: 9, expectedVersion: 3 });
    expect(response.status).toBe(201);
    expect(importBlogForCmsReview).toHaveBeenCalledWith(42, 7, 9, 3);
    expect(aiVisibilityWorkspaceService.requireCapability).toHaveBeenCalledWith(workspaceAccess, 'edit');
    expect(cmsDraftPublishingService.createDraft).not.toHaveBeenCalled();
    expect(addJob).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    authenticated = true;
    oauthStore.clear();
    oauthBinding.mockReset().mockImplementation(async key=>{const value=oauthStore.get(key);oauthStore.delete(key);return value ?? null;});
    oauthUser.mockReset().mockResolvedValue({id:42,deletedAt:null,passwordChangedAt:null});
    verifyGscOAuthState.mockReset().mockReturnValue({userId:42,projectId:7});
    scopeLookup.mockReset();
    scopeLookup.mockImplementation(async query => ({ rows: dialect.sqlToQuery(query).sql.includes('ai_visibility_report_shares')
      ? [{ user_id: 42, business_profile_id: 2 }]
      : [{ id: 2, user_id: 42, role: 'owner' }] }));
    aiVisibilityWorkspaceService.requireCapability.mockImplementation(() => undefined);
    aiVisibilityWorkspaceService.projectAccess.mockResolvedValue(workspaceAccess);
    aiVisibilityWorkspaceService.auditAccess.mockResolvedValue(workspaceAccess);
    aiVisibilityWorkspaceService.promptRunAccess.mockResolvedValue(workspaceAccess);
  });

  it('registers every route behind the ai_visibility module gate', () => {
    expect(moduleAccessKeys).toEqual(['ai_visibility']);
  });

  it('passes the authenticated user ID into project operations', async () => {
    aiVisibilityWorkspaceService.listAccessibleProjects.mockResolvedValue([{ id: 1, name: 'Orbit' }]);

    const response = await request(app).get('/api/ai-visibility/projects');

    expect(response.status).toBe(200);
    expect(response.body.projects).toEqual([{ id: 1, name: 'Orbit' }]);
    expect(aiVisibilityWorkspaceService.listAccessibleProjects).toHaveBeenCalledWith(42);
  });

  it('returns a successful OAuth callback to its website context', async () => {
    googleSearchConsoleService.completeOAuth.mockImplementation(async () => {
      expect(currentBusinessScope()).toMatchObject(businessScope);
      return { projectId: 7, selectedProperty: null };
    });
    const flow=await browserFlow();
    const response = await callback(flow,{code:'code'});
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/connected');
    expect(googleSearchConsoleService.completeOAuth).toHaveBeenCalledWith('code','signed',expect.objectContaining({codeVerifier:expect.any(String),configHash:expect.any(String)}));
    const verified=googleSearchConsoleService.completeOAuth.mock.calls[0][2] as {codeVerifier:string;configHash:string};
    expect(createHash('sha256').update(verified.codeVerifier).digest('base64url')).toBe(flow.challenge);
    expect(verified.configHash).toHaveLength(64);
    expect(oauthBinding).toHaveBeenCalledWith(`oauth:business:${createHash('sha256').update('signed').digest('hex')}`);
    expect(googleSearchConsoleService.callbackRedirect).toHaveBeenCalledWith({ projectId: 7, selectedProperty: null });
  });

  it('keeps the verified website context when OAuth is denied', async () => {
    const flow=await browserFlow();
    const response = await callback(flow,{error:'access_denied'});
    expect(response.status).toBe(302);
    expect(googleSearchConsoleService.completeOAuth).not.toHaveBeenCalled();
    expect(googleSearchConsoleService.callbackErrorRedirect).toHaveBeenCalledWith(expect.any(Error), 7);
  });

  it('keeps the website context when token exchange fails', async () => {
    googleSearchConsoleService.completeOAuth.mockRejectedValueOnce(new Error('Token exchange unavailable'));
    const flow=await browserFlow();
    const response = await callback(flow,{code:'code'});
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/error');
    expect(googleSearchConsoleService.callbackErrorRedirect).toHaveBeenCalledWith(expect.any(Error), 7);
  });

  it('does not trust an invalid OAuth state for an error redirect', async () => {
    verifyGscOAuthState.mockReturnValueOnce(null);
    const flow=await browserFlow('tampered');
    const response = await callback(flow,{error:'access_denied'});
    expect(response.status).toBe(302);
    expect(googleSearchConsoleService.callbackErrorRedirect).toHaveBeenCalledWith(expect.any(Error), undefined);
  });

  it('rejects an expired business binding before exchanging an OAuth code', async () => {
    oauthBinding.mockResolvedValueOnce(null);
    const flow=await browserFlow('expired');
    const response = await callback(flow,{code:'code'});
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/error');
    expect(googleSearchConsoleService.callbackErrorRedirect).toHaveBeenCalledWith(expect.objectContaining({code:'invalid_or_expired_state'}));
    expect(scopeLookup).not.toHaveBeenCalled();
    expect(googleSearchConsoleService.completeOAuth).not.toHaveBeenCalled();
    expect(googleSearchConsoleService.callbackRedirect).not.toHaveBeenCalled();
  });

  it.each([{ rows: [] }, { rows: [{ id: 2, user_id: 42, role: 'member' }] }, { rows: [{ id: 2, user_id: 99, role: 'owner' }] }])(
    'rejects revoked connection authority before the OAuth handler: %j', async ({ rows }) => {
      scopeLookup.mockResolvedValueOnce({ rows });
      const flow=await browserFlow();
    const response = await callback(flow,{code:'code'});
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('/error');
      expect(googleSearchConsoleService.completeOAuth).not.toHaveBeenCalled();
      expect(googleSearchConsoleService.callbackErrorRedirect).toHaveBeenCalledWith(expect.objectContaining({code:'permission_changed'}));
    },
  );

  it('rejects a callback from a different browser before token exchange', async()=>{
    const flow=await browserFlow();
    const response=await callback(flow,{code:'code'},[flow.cookies[0],`${flow.cookies[1].split('=')[0]}=different-browser`]);
    expect(response.status).toBe(302);expect(response.headers.location).toBe('/error');
    expect(googleSearchConsoleService.completeOAuth).not.toHaveBeenCalled();
    expect(googleSearchConsoleService.callbackErrorRedirect).toHaveBeenCalledWith(expect.objectContaining({code:'session_changed'}));
  });
  it('consumes a browser flow once and refuses a replay even with a fresh code',async()=>{
    const flow=await browserFlow();googleSearchConsoleService.completeOAuth.mockResolvedValue({projectId:7,selectedProperty:null});
    expect((await callback(flow,{code:'first-code'})).headers.location).toBe('/connected');
    expect((await callback(flow,{code:'fresh-replay-code'})).headers.location).toBe('/error');
    expect(googleSearchConsoleService.completeOAuth).toHaveBeenCalledTimes(1);
  });

  it('archives an owner project through the delete capability', async () => {
    aiVisibilityService.archiveProject.mockResolvedValue({ id: 7, status: 'archived' });

    const response = await request(app).delete('/api/ai-visibility/projects/7');

    expect(response.status).toBe(200);
    expect(response.body.project).toEqual({ id: 7, status: 'archived' });
    expect(aiVisibilityWorkspaceService.requireCapability).toHaveBeenCalledWith(expect.objectContaining({ role: 'owner' }), 'delete_project');
    expect(aiVisibilityService.archiveProject).toHaveBeenCalledWith(42, 7);
  });

  it('does not archive when the workspace role lacks the delete capability', async () => {
    aiVisibilityWorkspaceService.projectAccess.mockResolvedValue({ ...workspaceAccess, role: 'editor' });
    aiVisibilityWorkspaceService.requireCapability.mockImplementation((_access: unknown, capability: unknown) => {
      if (capability === 'delete_project') throw new AiVisibilityWorkspaceAccessError('Your editor role cannot perform this action.');
    });

    const response = await request(app).delete('/api/ai-visibility/projects/7');

    expect(response.status).toBe(403);
    expect(aiVisibilityService.archiveProject).not.toHaveBeenCalled();
  });

  it('lists agency workspaces through the authenticated actor identity', async () => {
    aiVisibilityWorkspaceService.listWorkspaces.mockResolvedValue([{ workspace: { id: 3, name: 'Orbit' }, membership: { role: 'owner' }, members: [] }]);
    const response = await request(app).get('/api/ai-visibility/workspaces');
    expect(response.status).toBe(200);
    expect(response.body.workspaces[0].membership.role).toBe('owner');
    expect(aiVisibilityWorkspaceService.listWorkspaces).toHaveBeenCalledWith(42);
  });

  it('rejects a project before owner-scoped services run when the actor has no workspace membership', async () => {
    aiVisibilityWorkspaceService.projectAccess.mockRejectedValue(new AiVisibilityWorkspaceAccessError('AI Visibility website not found.', 404, 'AI_VISIBILITY_PROJECT_NOT_FOUND'));
    const response = await request(app).get('/api/ai-visibility/projects/999/overview');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('AI_VISIBILITY_PROJECT_NOT_FOUND');
    expect(aiVisibilityService.overview).not.toHaveBeenCalled();
  });

  it('records an exact-version shared asset decision with the actor identity', async () => {
    aiVisibilityWorkspaceService.decideAsset.mockResolvedValue({ asset: { id: 22, approvalStatus: 'approved', version: 3 }, decision: { id: 31, actorUserId: 42 } });
    const response = await request(app).patch('/api/ai-visibility/projects/7/assets/19/approval').send({ decision: 'approved', assetVersion: 3 });
    expect(response.status).toBe(200);
    expect(response.body.decision.actorUserId).toBe(42);
    expect(aiVisibilityWorkspaceService.decideAsset).toHaveBeenCalledWith(42, 7, 19, { decision: 'approved', assetVersion: 3 });
    expect(aiVisibilityWorkspaceService.requireCapability).toHaveBeenCalledWith(expect.objectContaining({ role: 'owner' }), 'review_assets');
  });

  it('resolves a profile-backed project through the authenticated account', async () => {
    aiVisibilityService.resolveProject.mockResolvedValue({ project: { id: 7, businessProfileId: 2 }, provisioned: true });

    const response = await request(app).post('/api/ai-visibility/projects/resolve').send({ businessProfileId: 2 });

    expect(response.status).toBe(200);
    expect(response.body.project).toEqual({ id: 7, businessProfileId: 2 });
    expect(aiVisibilityService.resolveProject).toHaveBeenCalledWith(42, 2);
  });

  it('lists only the authenticated user’s approved Business Profiles for workspace selection', async () => {
    aiVisibilityService.listBusinessProfiles.mockResolvedValue([{ id: 2, companyName: 'Orbit', website: 'https://orbit.test' }]);

    const response = await request(app).get('/api/ai-visibility/business-profiles');

    expect(response.status).toBe(200);
    expect(response.body.profiles).toHaveLength(1);
    expect(aiVisibilityService.listBusinessProfiles).toHaveBeenCalledWith(42);
  });

  it('creates or reuses an authenticated arbitrary website search', async () => {
    aiVisibilityService.resolveWebsiteSearch.mockResolvedValue({ project: { id: 9, domain: 'https://example.com' }, created: true });

    const response = await request(app).post('/api/ai-visibility/website-searches').send({ website: 'example.com', name: 'Example', scoringProfile: 'b2b_saas', country: 'US', locale: 'en-US' });

    expect(response.status).toBe(201);
    expect(response.body.project.domain).toBe('https://example.com');
    expect(aiVisibilityService.resolveWebsiteSearch).toHaveBeenCalledWith(42, { website: 'example.com', name: 'Example', scoringProfile: 'b2b_saas', country: 'US', locale: 'en-US' });
  });

  it('returns durable website search history for the authenticated user', async () => {
    aiVisibilityService.listWebsiteSearches.mockResolvedValue([{ project: { id: 9 }, auditCount: 2 }]);

    const response = await request(app).get('/api/ai-visibility/website-searches');

    expect(response.status).toBe(200);
    expect(response.body.websites[0].auditCount).toBe(2);
    expect(aiVisibilityService.listWebsiteSearches).toHaveBeenCalledWith(42);
  });

  it('reports the wrapped active-profile website conflict without exposing database details or dispatching work', async () => {
    aiVisibilityService.resolveWebsiteSearch.mockRejectedValueOnce(new Error('Failed query: private SQL', {
      cause: Object.assign(new Error('duplicate key: private row'), {
        code: '23505', constraint: 'ai_visibility_projects_active_profile_uq',
      }),
    }));

    const response = await request(app).post('/api/ai-visibility/website-searches').send({ website: 'example.com' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'This website search conflicts with an existing active workspace.' });
    expect(aiVisibilityService.createAudit).not.toHaveBeenCalled();
    expect(addJob).not.toHaveBeenCalled();
  });

  it.each([
    ['23505', 'some_other_constraint'],
    ['42501', 'ai_visibility_projects_active_profile_uq'],
  ])('does not classify an unrelated wrapped database failure as the active-profile conflict (%s, %s)', async (code, constraint) => {
    aiVisibilityService.resolveWebsiteSearch.mockRejectedValueOnce(new Error('Failed query: private SQL', {
      cause: Object.assign(new Error('private database detail'), { code, constraint }),
    }));

    const response = await request(app).post('/api/ai-visibility/website-searches').send({ website: 'example.com' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'AI Visibility request failed.' });
    expect(addJob).not.toHaveBeenCalled();
  });

  it('syncs Shopify only through the authenticated project and exposes connection errors', async () => {
    aiVisibilityService.ingestShopifyCatalog.mockResolvedValue({ id: 12, sourceType: 'shopify', itemCount: 42 });
    const synced = await request(app).post('/api/ai-visibility/projects/7/commerce/shopify/sync');
    expect(synced.status).toBe(201);
    expect(synced.body.snapshot).toEqual(expect.objectContaining({ sourceType: 'shopify', itemCount: 42 }));
    expect(aiVisibilityService.ingestShopifyCatalog).toHaveBeenCalledWith(42, 7);

    aiVisibilityService.ingestShopifyCatalog.mockRejectedValue(new ShopifyCatalogError('Connect Shopify in Assets before syncing a catalog.', 'SHOPIFY_NOT_CONNECTED', 409));
    const missing = await request(app).post('/api/ai-visibility/projects/7/commerce/shopify/sync');
    expect(missing.status).toBe(409);
    expect(missing.body).toEqual({ error: 'Connect Shopify in Assets before syncing a catalog.', code: 'SHOPIFY_NOT_CONNECTED' });
  });

  it('returns owner-scoped Search Console opportunities', async () => {
    googleSearchConsoleService.overview.mockResolvedValue({ connected: true, opportunities: [{ query: 'orbit crm' }] });
    const response = await request(app).get('/api/ai-visibility/projects/7/gsc');
    expect(response.status).toBe(200);
    expect(response.body.opportunities[0].query).toBe('orbit crm');
    expect(googleSearchConsoleService.overview).toHaveBeenCalledWith(42, 7, undefined);
  });

  it('starts Search Console OAuth only for the authenticated project', async () => {
    googleSearchConsoleService.authorizationUrl.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth' });
    const response = await request(app).post('/api/ai-visibility/projects/7/gsc/auth-url');
    expect(response.status).toBe(200);
    expect(googleSearchConsoleService.authorizationUrl).toHaveBeenCalledWith(42,7,expect.objectContaining({user:expect.objectContaining({id:42})}),expect.objectContaining({cookie:expect.any(Function)}));
  });

  it('validates Search Console property selection', async () => {
    const response = await request(app).put('/api/ai-visibility/projects/7/gsc/property').send({ propertyUri: '' });
    expect(response.status).toBe(400);
    expect(googleSearchConsoleService.selectProperty).not.toHaveBeenCalled();
  });

  it('updates a project-owned competitor through the authenticated account', async () => {
    aiVisibilityService.updateCompetitor.mockResolvedValue({ id: 4, active: false });

    const response = await request(app).patch('/api/ai-visibility/projects/7/competitors/4').send({ active: false });

    expect(response.status).toBe(200);
    expect(response.body.competitor).toEqual({ id: 4, active: false });
    expect(aiVisibilityService.updateCompetitor).toHaveBeenCalledWith(42, 7, 4, { active: false });
  });

  it('returns only service-verified competitor suggestions with their evidence sources', async () => {
    aiVisibilityService.suggestCompetitors.mockResolvedValue({
      suggestions: [{ name: 'Verified Rival', domain: 'https://rival.test', sources: [{ type: 'business_profile_reference', label: 'Business Profile reference', evidenceCount: 1 }] }],
      sourcesUsed: ['business_profile_reference'],
      unavailableReason: null,
    });

    const response = await request(app).post('/api/ai-visibility/projects/7/suggest-competitors').send({});

    expect(response.status).toBe(200);
    expect(response.body.suggestions[0].sources[0].type).toBe('business_profile_reference');
    expect(aiVisibilityService.suggestCompetitors).toHaveBeenCalledWith(42, 7);
  });

  it('returns latest evidence-backed competitor intelligence for the authenticated project', async () => {
    aiVisibilityService.competitorIntelligence.mockResolvedValue({
      available: true,
      intelligence: { brand: { shareOfVoice: 0.4 }, competitors: [{ competitorId: 9, metrics: { shareOfVoice: 0.6 } }] },
    });

    const response = await request(app).get('/api/ai-visibility/projects/7/competitor-intelligence');

    expect(response.status).toBe(200);
    expect(response.body.intelligence.competitors[0].competitorId).toBe(9);
    expect(aiVisibilityService.competitorIntelligence).toHaveBeenCalledWith(42, 7, undefined);
  });

  it('creates a counter-content brief only through an owned verified gap', async () => {
    aiVisibilityService.generateCompetitorGapBrief.mockResolvedValue({ id: 22, type: 'content_brief', approvalStatus: 'draft' });

    const response = await request(app).post('/api/ai-visibility/projects/7/competitor-intelligence/briefs').send({ competitorId: 9, gapKey: '9:pricing' });

    expect(response.status).toBe(201);
    expect(response.body.asset).toEqual(expect.objectContaining({ id: 22, type: 'content_brief' }));
    expect(aiVisibilityService.generateCompetitorGapBrief).toHaveBeenCalledWith(42, 7, 9, '9:pricing');
  });

  it('rejects malformed competitor-gap evidence before calling the service', async () => {
    const response = await request(app).post('/api/ai-visibility/projects/7/competitor-intelligence/briefs').send({ competitorId: -1, gapKey: '' });

    expect(response.status).toBe(400);
    expect(aiVisibilityService.generateCompetitorGapBrief).not.toHaveBeenCalled();
  });

  it('returns enriched generated assets for the selected project', async () => {
    aiVisibilityService.assets.mockResolvedValue([{ id: 3, contentAssetId: 12, title: 'Improve homepage metadata', approvalStatus: 'draft' }]);

    const response = await request(app).get('/api/ai-visibility/projects/7/assets');

    expect(response.status).toBe(200);
    expect(response.body.assets[0]).toEqual(expect.objectContaining({ title: 'Improve homepage metadata', approvalStatus: 'draft' }));
    expect(aiVisibilityService.assets).toHaveBeenCalledWith(42, 7);
  });

  it('keeps CMS connection and publish operations scoped to the authenticated project owner', async () => {
    cmsDraftPublishingService.connections.mockResolvedValue([{ platform: 'wordpress', connected: true }]);
    cmsDraftPublishingService.createDraft.mockResolvedValue({ id: 31, status: 'draft_created', platform: 'wordpress' });

    const connections = await request(app).get('/api/ai-visibility/projects/7/cms-connections');
    const draft = await request(app).post('/api/ai-visibility/projects/7/assets/19/cms-drafts').send({
      platform: 'wordpress', idempotencyKey: '2d94de6e-c82c-46be-ae18-ac05a35f2522', assetVersion: 2,
    });

    expect(connections.status).toBe(200);
    expect(cmsDraftPublishingService.connections).toHaveBeenCalledWith(42, 7);
    expect(draft.status).toBe(201);
    expect(cmsDraftPublishingService.createDraft).toHaveBeenCalledWith(42, 7, 19, 'wordpress', '2d94de6e-c82c-46be-ae18-ac05a35f2522', 2, undefined);
  });

  it('maps approval and idempotency CMS conflicts without hiding the reason', async () => {
    cmsDraftPublishingService.createDraft.mockRejectedValue(new CmsPublishingError('Approve this exact asset version in Content before creating a CMS draft.', 'ASSET_APPROVAL_REQUIRED', 409));

    const response = await request(app).post('/api/ai-visibility/projects/7/assets/19/cms-drafts').send({
      platform: 'shopify', idempotencyKey: '2d94de6e-c82c-46be-ae18-ac05a35f2522', assetVersion: 2,
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: expect.stringMatching(/Approve this exact asset version/), code: 'ASSET_APPROVAL_REQUIRED' });
  });

  it('returns verified page coverage for project-owned AEO questions', async () => {
    aiVisibilityService.aeoCoverage.mockResolvedValue({
      available: true,
      summary: { total: 1, answered: 1, partial: 0, uncovered: 0 },
      coverage: [{ questionId: 8, status: 'answered', bestMatch: { url: 'https://orbit.test/help' } }],
    });

    const response = await request(app).get('/api/ai-visibility/projects/7/aeo/coverage');

    expect(response.status).toBe(200);
    expect(response.body.coverage[0]).toEqual(expect.objectContaining({ questionId: 8, status: 'answered' }));
    expect(aiVisibilityService.aeoCoverage).toHaveBeenCalledWith(42, 7, undefined);
  });

  it('creates a validated AEO draft through the project-owned question', async () => {
    aiVisibilityService.generateAeoQuestionAsset.mockResolvedValue({ id: 15, type: 'faq_page', approvalStatus: 'draft' });

    const response = await request(app).post('/api/ai-visibility/projects/7/aeo/questions/8/assets').send({ assetType: 'faq_page' });

    expect(response.status).toBe(201);
    expect(response.body.asset).toEqual(expect.objectContaining({ id: 15, type: 'faq_page' }));
    expect(aiVisibilityService.generateAeoQuestionAsset).toHaveBeenCalledWith(42, 7, 8, 'faq_page');
  });

  it('rejects unsupported AEO asset types before service execution', async () => {
    const response = await request(app).post('/api/ai-visibility/projects/7/aeo/questions/8/assets').send({ assetType: 'fabricated_answer' });

    expect(response.status).toBe(400);
    expect(aiVisibilityService.generateAeoQuestionAsset).not.toHaveBeenCalled();
  });

  it('rejects invalid project input before calling the service', async () => {
    const response = await request(app).post('/api/ai-visibility/projects').send({
      name: '', domain: 'example.com', scoringProfile: 'made_up', country: 'USA',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request.');
    expect(aiVisibilityService.createProject).not.toHaveBeenCalled();
  });

  it('maps ownership-safe not-found errors to 404', async () => {
    aiVisibilityService.getProject.mockRejectedValue(new AiVisibilityNotFoundError('Project not found.'));

    const response = await request(app).get('/api/ai-visibility/projects/999');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Project not found.');
    expect(aiVisibilityService.getProject).toHaveBeenCalledWith(42, 999);
  });

  it('returns HTTP 402 and does not enqueue when the direct wallet base charge fails', async () => {
    aiVisibilityService.createAudit.mockResolvedValue({ success: false, error: 'Insufficient credits', balanceAfter: 3 });

    const response = await request(app).post('/api/ai-visibility/projects/7/audits');

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: 'Insufficient credits', balance: 3 });
    expect(addJob).not.toHaveBeenCalled();
  });

  it('returns 202 only after charging the base usage and dispatching an idempotent audit job', async () => {
    aiVisibilityService.createAudit.mockResolvedValue({
      success: true,
      resource: { id: 11, projectId: 7, status: 'queued' },
      creditsDeducted: 25,
      balanceAfter: 75,
      transactionId: 55,
    });
    addJob.mockResolvedValue({ id: 'ai-visibility-audit-11' });

    const response = await request(app).post('/api/ai-visibility/projects/7/audits');

    expect(response.status).toBe(202);
    expect(response.body).toEqual(expect.objectContaining({ creditsCharged: 25, balanceAfter: 75 }));
    expect(response.body).not.toHaveProperty('reservedCredits');
    expect(aiVisibilityService.createAudit).toHaveBeenCalledWith(42, 7);
    expect(addJob).toHaveBeenCalledWith(
      'ai-visibility-audit',
      'run-audit',
      expect.objectContaining({ userId: 42, projectId: 7, auditId: 11 }),
      { jobId: 'ai-visibility-audit-11' },
    );
  });

  it('returns the direct base charge and marks the audit failed when queue dispatch fails', async () => {
    aiVisibilityService.createAudit.mockResolvedValue({
      success: true,
      resource: { id: 11, projectId: 7, status: 'queued' },
      creditsDeducted: 25,
      balanceAfter: 75,
      transactionId: 55,
    });
    addJob.mockRejectedValue(new Error('Redis unavailable'));
    refundDeduction.mockResolvedValue(undefined);
    aiVisibilityService.markAuditDispatchFailed.mockResolvedValue(undefined);

    const response = await request(app).post('/api/ai-visibility/projects/7/audits');

    expect(response.status).toBe(500);
    expect(refundDeduction).toHaveBeenCalledWith(expect.objectContaining({ userId: 42, transactionId: 55 }));
    expect(aiVisibilityService.markAuditDispatchFailed).toHaveBeenCalledWith(42, 11, expect.stringMatching(/returned/i));
  });

  it('rejects an empty extraction correction', async () => {
    const response = await request(app).post('/api/ai-visibility/prompt-runs/8/corrections').send({});

    expect(response.status).toBe(400);
    expect(aiVisibilityService.correctPromptRun).not.toHaveBeenCalled();
  });

  it('validates and saves supported extraction correction fields', async () => {
    aiVisibilityService.correctPromptRun.mockResolvedValue({ id: 3, promptRunId: 8 });

    const response = await request(app).post('/api/ai-visibility/prompt-runs/8/corrections').send({
      brandMentioned: true,
      brandRank: 2,
      sentiment: 'positive',
      competitors: ['Verified Rival'],
      recommendationReason: 'The answer recommends the brand for its verified capabilities.',
      exclusionReason: null,
    });

    expect(response.status).toBe(200);
    expect(aiVisibilityService.correctPromptRun).toHaveBeenCalledWith(42, 8, expect.objectContaining({
      brandMentioned: true,
      brandRank: 2,
      sentiment: 'positive',
    }));
  });

  it('acknowledges a project-owned monitoring alert through the authenticated account', async () => {
    aiVisibilityService.acknowledgeAlert.mockResolvedValue({ id: 4, acknowledgedAt: '2026-08-13T00:00:00.000Z' });

    const response = await request(app).patch('/api/ai-visibility/projects/7/alerts/4').send({});

    expect(response.status).toBe(200);
    expect(response.body.alert.id).toBe(4);
    expect(aiVisibilityService.acknowledgeAlert).toHaveBeenCalledWith(42, 7, 4);
  });

  it('rejects unsupported correction fields instead of persisting arbitrary data', async () => {
    const response = await request(app).post('/api/ai-visibility/prompt-runs/8/corrections').send({ arbitrary: 'value' });

    expect(response.status).toBe(400);
    expect(aiVisibilityService.correctPromptRun).not.toHaveBeenCalled();
  });

  it('requires a real commerce feed file', async () => {
    const response = await request(app).post('/api/ai-visibility/projects/7/commerce/feeds');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/feed file is required/i);
    expect(aiVisibilityService.ingestCommerceFeed).not.toHaveBeenCalled();
  });

  it('returns 409 while a report is not ready instead of returning placeholder content', async () => {
    aiVisibilityService.getReport.mockResolvedValue({ auditId: 11, status: 'pending', storageFileId: null });

    const response = await request(app).get('/api/ai-visibility/audits/11/report');

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/not ready/i);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('AS019 serves the saved completed PDF bytes through the authorized owner without a signed redirect or job', async () => {
    const pdf = Buffer.from('%PDF-1.4\nSynthetic transport fixture\n%%EOF');
    aiVisibilityWorkspaceService.auditAccess.mockResolvedValueOnce({ ...workspaceAccess, ownerUserId: 7, role: 'client_reviewer' });
    aiVisibilityService.getReport.mockResolvedValueOnce({ auditId: 29, status: 'completed', storageFileId: 81 });
    downloadFile.mockResolvedValueOnce({ buffer: pdf });

    const response = await request(app).get('/api/ai-visibility/audits/29/report');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toBe('attachment; filename="ai-visibility-audit-29.pdf"');
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toEqual(pdf);
    expect(aiVisibilityWorkspaceService.auditAccess).toHaveBeenCalledWith(42, 29);
    expect(aiVisibilityService.getReport).toHaveBeenCalledWith(7, 29);
    expect(downloadFile).toHaveBeenCalledWith(81, 7);
    expect(addJob).not.toHaveBeenCalled();
  });

  it('AS019 returns a file transport 404 despite completed metadata when storage cannot find the file', async () => {
    aiVisibilityService.getReport.mockResolvedValueOnce({ auditId: 29, status: 'completed', storageFileId: 81 });
    downloadFile.mockResolvedValueOnce(null);

    const response = await request(app).get('/api/ai-visibility/audits/29/report');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({ error: 'Report file not found.' });
    expect(addJob).not.toHaveBeenCalled();
  });

  it('AS019 denies unauthorized saved-report reads before accessing storage', async () => {
    aiVisibilityWorkspaceService.auditAccess.mockRejectedValueOnce(new AiVisibilityWorkspaceAccessError('Synthetic access denied.'));

    const response = await request(app).get('/api/ai-visibility/audits/29/report');

    expect(response.status).toBe(403);
    expect(aiVisibilityService.getReport).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(addJob).not.toHaveBeenCalled();
  });

  it('AS019 returns a generic transport 500 without leaking a storage error', async () => {
    aiVisibilityService.getReport.mockResolvedValueOnce({ auditId: 29, status: 'completed', storageFileId: 81 });
    downloadFile.mockRejectedValueOnce(new Error('Synthetic private storage detail.'));

    const response = await request(app).get('/api/ai-visibility/audits/29/report');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'AI Visibility request failed.' });
    expect(JSON.stringify(response.body)).not.toContain('private storage detail');
    expect(addJob).not.toHaveBeenCalled();
  });

  it('AS019 stops an unauthenticated PDF read at the auth middleware before tenant or storage access', async () => {
    authenticated = false;
    const response = await request(app).get('/api/ai-visibility/audits/29/report');
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    expect(aiVisibilityWorkspaceService.auditAccess).not.toHaveBeenCalled();
    expect(aiVisibilityService.getReport).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(addJob).not.toHaveBeenCalled();
  });

  it.each(['', '<html>Synthetic storage response</html>', '{"error":"synthetic"}'])(
    'AS019 rejects non-PDF saved bytes without a successful PDF response: %s', async bytes => {
      aiVisibilityService.getReport.mockResolvedValueOnce({ auditId: 29, status: 'completed', storageFileId: 81 });
      downloadFile.mockResolvedValueOnce({ buffer: Buffer.from(bytes) });
      const response = await request(app).get('/api/ai-visibility/audits/29/report');
      expect(response.status).toBe(502);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(response.body).toEqual({ error: 'Saved report file is not a valid PDF.' });
      expect(response.headers.location).toBeUndefined();
      expect(addJob).not.toHaveBeenCalled();
    },
  );

  it('serves a valid shared PDF with no-store and search-indexing protections', async () => {
    const token = 'a'.repeat(43);
    aiVisibilityService.getSharedReport.mockImplementation(async () => {
      expect(currentBusinessScope()).toMatchObject({ userId: 42, businessProfileId: 2 });
      return { auditId: 11, userId: 42, status: 'completed', storageFileId: 81 };
    });
    downloadFile.mockResolvedValue({ buffer: Buffer.from('%PDF-1.7 synthetic shared fixture') });

    const response = await request(app).get(`/api/ai-visibility/shared-reports/${token}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-robots-tag']).toContain('noindex');
    expect(aiVisibilityService.getSharedReport).toHaveBeenCalledWith(token);
    expect(downloadFile).toHaveBeenCalledWith(81, 42);
    expect(dialect.sqlToQuery(scopeLookup.mock.calls[0][0]).params).toEqual([createHash('sha256').update(token).digest('hex')]);
  });

  it('rejects an unknown public share before accessing report contents or storage', async () => {
    scopeLookup.mockResolvedValueOnce({ rows: [] });
    const response = await request(app).get(`/api/ai-visibility/shared-reports/${'z'.repeat(43)}`);
    expect(response.status).toBe(404);
    expect(aiVisibilityService.getSharedReport).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('fails closed for malformed public share tokens', async () => {
    const response = await request(app).get('/api/ai-visibility/shared-reports/not-a-token');

    expect(response.status).toBe(404);
    expect(aiVisibilityService.getSharedReport).not.toHaveBeenCalled();
  });

  it('lists only project-owned report share metadata', async () => {
    aiVisibilityService.listReportShares.mockResolvedValue([{ id: 4, auditId: 11, tokenPrefix: 'abcdefghij', active: true }]);

    const response = await request(app).get('/api/ai-visibility/projects/7/report-shares');

    expect(response.status).toBe(200);
    expect(response.body.shares[0]).not.toHaveProperty('tokenHash');
    expect(aiVisibilityService.listReportShares).toHaveBeenCalledWith(42, 7);
  });

  it('creates a time-bounded share only through an owned completed report', async () => {
    aiVisibilityService.createReportShare.mockResolvedValue({ share: { id: 4, auditId: 11, active: true }, token: 'b'.repeat(43) });

    const response = await request(app).post('/api/ai-visibility/audits/11/report-shares').send({ expiresInDays: 7 });

    expect(response.status).toBe(201);
    expect(response.body.token).toHaveLength(43);
    expect(aiVisibilityService.createReportShare).toHaveBeenCalledWith(42, 11, 7);
  });

  it('rejects unsupported report-share expiry periods', async () => {
    const response = await request(app).post('/api/ai-visibility/audits/11/report-shares').send({ expiresInDays: 365 });

    expect(response.status).toBe(400);
    expect(aiVisibilityService.createReportShare).not.toHaveBeenCalled();
  });

  it('revokes only a project-owned report share', async () => {
    aiVisibilityService.revokeReportShare.mockResolvedValue({ id: 4, active: false, revokedAt: '2026-08-15T00:00:00.000Z' });

    const response = await request(app).delete('/api/ai-visibility/projects/7/report-shares/4');

    expect(response.status).toBe(200);
    expect(response.body.share.active).toBe(false);
    expect(aiVisibilityService.revokeReportShare).toHaveBeenCalledWith(42, 7, 4);
  });

  it('emails an owned report through a validated durable send intent', async () => {
    aiVisibilityService.sendReportEmail.mockResolvedValue({ id: 8, auditId: 11, recipientEmail: 'client@example.com', status: 'sent' });
    const key = '2d94de6e-c82c-46be-ae18-ac05a35f2522';

    const response = await request(app).post('/api/ai-visibility/audits/11/report-deliveries').send({ recipientEmail: 'client@example.com', idempotencyKey: key });

    expect(response.status).toBe(201);
    expect(response.body.delivery.status).toBe('sent');
    expect(aiVisibilityService.sendReportEmail).toHaveBeenCalledWith(42, 11, 'client@example.com', key);
  });

  it('rejects malformed report email input before delivery starts', async () => {
    const response = await request(app).post('/api/ai-visibility/audits/11/report-deliveries').send({ recipientEmail: 'not-an-email', idempotencyKey: 'reused' });

    expect(response.status).toBe(400);
    expect(aiVisibilityService.sendReportEmail).not.toHaveBeenCalled();
  });

  it('downloads an owned completed audit as a private CSV export', async () => {
    aiVisibilityService.exportAuditCsv.mockResolvedValue('"record_type"\r\n"score"\r\n');

    const response = await request(app).get('/api/ai-visibility/audits/11/export.csv');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('ai-visibility-audit-11.csv');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(aiVisibilityService.exportAuditCsv).toHaveBeenCalledWith(42, 11);
  });

  it('queues a no-charge report retry only for a completed audit', async () => {
    aiVisibilityService.getAudit.mockResolvedValue({ id: 11, projectId: 7, status: 'completed_with_warnings' });
    addJob.mockResolvedValue({ id: 'ai-visibility-audit-report-11' });

    const response = await request(app).post('/api/ai-visibility/audits/11/report/retry');

    expect(response.status).toBe(202);
    expect(addJob).toHaveBeenCalledWith('ai-visibility-audit', 'retry-audit-report', expect.objectContaining({ auditId: 11, retryReport: true }), { jobId: expect.stringMatching(/^ai-visibility-audit-report-11-\d+$/) });
  });
});
