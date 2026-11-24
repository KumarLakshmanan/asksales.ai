import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express from 'express';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { assertBusinessScopeSchema } from '../tenancy/schemaGuard.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const database = process.env.BRAND_CALENDAR_TEST_DATABASE;
const browserOrigin = process.env.BRAND_CALENDAR_BROWSER_URL || 'http://127.0.0.1:3049';
if (!['http://127.0.0.1:3049', 'http://127.0.0.1:3050'].includes(browserOrigin)) throw new Error('Only loopback audit browser origins are allowed');
const suite = database ? describe : describe.skip;
let admin: Pool, pool: Pool, server: Server, base: string;
const databaseProxy = new Proxy({}, { get: (_target, key) => Reflect.get(drizzle(pool), key) });
jest.unstable_mockModule('../models/db.js', () => ({ db: databaseProxy }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const changeSchedule = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ affected: 1 });
jest.unstable_mockModule('../services/social/OrganicPublishLifecycleService.js', () => ({
  changeOrganicPublishSchedule: changeSchedule, publishAttemptCapabilities: () => ({}),
}));
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
const { objectStorage } = await import('../services/ObjectStorageService.js');
const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
let fetchGuard: ReturnType<typeof jest.spyOn>;
let owner: number, member: number, other: number, north: number, south: number, _foreign: number;
let ownerToken: string, _memberToken: string, _otherToken: string;


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
    [north, south, _foreign] = profiles.rows.map(row => row.id);
    await admin.query("INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')", [north, member, `member-${suffix}@example.invalid`]);
    ownerToken = generateToken({ userId: owner, email: `owner-${suffix}@example.invalid` });
    _memberToken = generateToken({ userId: member, email: `member-${suffix}@example.invalid` });
    _otherToken = generateToken({ userId: other, email: `other-${suffix}@example.invalid` });
    const app = express(); app.use(express.json());
    app.use('/api/content', (await import('../routes/content.routes.js')).default);
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
    SmartThrottlingService.getInstance().destroy();
    await closeRedisConnections();
    fetchGuard?.mockRestore();
    if (pool) await pool.end();
    if (admin) await admin.end();
  });

  async function auditBrowser(hook?: (route: any, forward: () => Promise<any>) => Promise<boolean>, width = 1311) {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    const site = browserOrigin;
    const user = { id: owner, name: 'Synthetic audit owner', email: 'audit-owner@example.invalid', isSetupComplete: true, isApproved: true, hasBusinessProfile: true, hasBrandToolkit: true };
    const traffic: Array<{ method: string; path: string; profile?: string; status: number }> = [];
    const errors: string[] = [], blocked: string[] = [], dialogs: string[] = [];
    await page.addInitScript(({ user, ownerToken, north }) => {
      localStorage.setItem('token', ownerToken); localStorage.setItem('user', JSON.stringify(user));
      if (!sessionStorage.getItem(`active-business-profile:${user.id}`)) sessionStorage.setItem(`active-business-profile:${user.id}`, String(north));
    }, { user, ownerToken, north });
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.clock.setFixedTime(new Date('2026-11-03T16:00:00Z'));
    await page.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.host === new URL(site).host && url.pathname === '/_next/webpack-hmr') socket.connectToServer();
    });
    await page.route('**/*', async route => {
      const incoming = route.request(), url = new URL(incoming.url());
      if (url.origin !== site) { blocked.push(url.origin); await route.abort(); return; }
      if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
      const forward = async () => {
        const headers: Record<string, string> = { ...incoming.headers(), authorization: `Bearer ${ownerToken}` };
        const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers });
        traffic.push({ method: incoming.method(), path: url.pathname, profile: headers['x-business-profile-id'], status: response.status() });
        return response;
      };
      if (hook && await hook(route, forward)) return;
      if (/^\/api\/content\/(?:brand-toolkits|calendar)(?:\/|$)/.test(url.pathname)) {
        await route.fulfill({ response: await forward() }); return;
      }
      const profile = (id: number) => ({ id, name: id === north ? 'North audit business' : 'South audit business', companyName: id === north ? 'North audit business' : 'South audit business', role: 'owner', isDefault: id === north });
      let json: unknown = [];
      if (url.pathname === '/api/auth/me') json = { user };
      else if (url.pathname === '/api/platform/access') json = { maintenance: { enabled: false, message: '' }, modules: ['campaigns', 'lead_generation', 'content', 'performance_marketing', 'ai_visibility', 'outreach', 'crm', 'support', 'support_ai', 'proposals', 'knowledge_base', 'integrations', 'billing', 'storage'].map(key => ({ key, name: key, status: 'available', enabled: true, mode: 'enabled', description: '', message: null })) };
      else if (url.pathname === '/api/settings/preferences') json = { theme: 'light', language: 'en', timezone: 'America/New_York' };
      else if (url.pathname === '/api/settings/business-profiles') json = [profile(north), profile(south)];
      else if (url.pathname === `/api/settings/business-profiles/${north}`) json = profile(north);
      else if (url.pathname === `/api/settings/business-profiles/${south}`) json = profile(south);
      else if (url.pathname === '/api/organizations') json = { organizations: [] };
      else if (url.pathname === '/api/wallet') json = { balance: 10000 };
      else if (url.pathname === '/api/notifications/unread/count') json = { count: 0 };
      else if (url.pathname === '/api/chat/threads') json = { threads: [], total: 0 };
      else if (url.pathname === '/api/settings/outreach/assistants/catalog') json = { runtimeEnabled: false, presets: [], accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [], permissions: { canManage: false } };
      else if (url.pathname === '/api/auth/csrf-token') json = { csrfToken: 'local-fixture' };
      else if (url.pathname === '/api/chat/threads/509') json = { id: 509, title: 'Brand audit fixture', businessId: north, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
      else if (url.pathname === '/api/chat/threads/509/messages') json = { messages: [{ id: 5091, role: 'agent', agentType: 'orchestrator', content: 'Synthetic local brand form action', createdAt: '2026-10-01T00:00:00Z', metadata: { actionButtons: [{ id: 'audit-brand-create', label: 'Create Brand Toolkit', action: 'CREATE_BRAND_TOOLKIT' }] } }], hasMore: false, nextCursor: null };
      else if (url.pathname === '/api/chat/threads/509/tabs') json = [{ tabId: 'overview-509', tabType: 'overview', tabLabel: 'Overview', tabOrder: 0, isActive: true }];
      else if (url.pathname === '/api/chat/threads/509/context-window') json = { threadId: 509, messageCount: 1, summary: null, lastCompactedAt: null, canCompact: false, tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCurrentContextTokens: 0, maxContextTokens: 128000, modelName: 'Synthetic fixture', usagePercent: 0 } };
      else if (url.pathname === '/api/widgets') json = { widgets: [] };
      else if (url.pathname === '/api/chat/threads/509/overview') json = { thread: { id: 509, title: 'Brand audit fixture' }, stats: { messageCount: 1, contentAssetsCount: 0, agentExecutionsCount: 0, scrapingCount: 0 }, icp: null, activeAgents: [], workflowExecutions: [], timeline: [] };
      else if (url.pathname === '/api/icp/thread/509') json = null;
      if (incoming.method() !== 'GET' && incoming.method() !== 'HEAD') { await route.fulfill({ status: 409, json: { error: 'Unexercised synthetic boundary; no external effects' } }); return; }
      await route.fulfill({ json });
    });
    const record = async (name: string, facts: unknown) => {
      const viewport = await page.evaluate('({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, scale: visualViewport?.scale })');
      writeFileSync(`/workspace/brand-calendar-fix-evidence/production-${name}.json`, JSON.stringify({ browserOrigin, baseline: '24c66b9cac2936ccbd119e39cf78b5b83b1e6212', facts, traffic, errors, blocked, dialogs, viewport }, null, 2));
      await page.screenshot({ path: `/workspace/brand-calendar-fix-evidence/production-${name}.png` });
    };
    const close = async () => { await page.unrouteAll({ behavior: 'wait' }); await browser.close(); };
    return { browser, page, traffic, errors, blocked, dialogs, record, close };
  }

  it('BC2-01 acceptance: conversation modal saves canonical tags through mounted validation', async () => {
    const replies: any[] = [];
    const view = await auditBrowser(async (route, forward) => {
      const incoming = route.request();
      if (new URL(incoming.url()).pathname !== '/api/content/brand-toolkits' || incoming.method() !== 'POST') return false;
      const response = await forward();
      replies.push({ status:response.status(),body:await response.json(),payloadKeys:Object.keys(incoming.postDataJSON()) });
      await route.fulfill({ response }); return true;
    });
    try {
      await view.page.goto(`${browserOrigin}/dashboard/conversations/509`);
      await view.page.getByRole('button', { name: 'Create Brand Toolkit', exact: true }).click();
      const dialog = view.page.getByRole('dialog', { name: 'Create Brand Toolkit', exact: true });
      const name = `Modal schema audit ${randomUUID()}`;
      await dialog.getByRole('textbox', { name: 'Brand Name *', exact: true }).fill(name);
      await dialog.getByRole('button', { name: 'Content Style', exact: true }).click();
      await dialog.getByRole('textbox',{name:'Hashtags',exact:true}).fill('#synthetic');
      await dialog.getByRole('textbox',{name:'Hashtags',exact:true}).press('Enter');
      await dialog.getByRole('textbox',{name:'Call-to-Actions (CTAs)',exact:true}).fill('Read the fixture');
      await dialog.getByRole('textbox',{name:'Call-to-Actions (CTAs)',exact:true}).press('Enter');
      await dialog.getByRole('button', { name: 'Target Audience', exact: true }).click();
      const response = view.page.waitForResponse(item=>new URL(item.url()).pathname==='/api/content/brand-toolkits' && item.request().method()==='POST');
      await dialog.getByRole('button', { name: 'Save Toolkit', exact: true }).click();
      expect((await response).status()).toBe(201);
      await dialog.waitFor({state:'hidden'});
      const rows = (await admin.query('SELECT id FROM brand_toolkits WHERE user_id=$1 AND business_profile_id=$2 AND name=$3', [owner,north,name])).rows;
      expect(rows).toHaveLength(1);
      expect(replies[0].payloadKeys).not.toContain('hashtags'); expect(replies[0].payloadKeys).not.toContain('ctas');
      const saved=await request(`/brand-toolkits/${rows[0].id}`);
      expect(saved.body.defaultHashtags).toEqual(['#synthetic']); expect(saved.body.defaultCtas).toEqual(['Read the fixture']);
      await view.record('modal-canonical-save-acceptance', { replies,persistedRows:rows.length,tagsPersistedAndReloaded:true });
    } finally { await view.close(); }
  }, 90000);



  it('BC2-02 acceptance: retains a real Redis pending receipt across reload and confirms only the exact terminal replay',async()=>{
    let release!:()=>void,entered!:()=>void,primary:Promise<any>|undefined;
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    const pending=new Promise<void>(resolve=>{release=resolve;});
    changeSchedule.mockClear();changeSchedule.mockImplementationOnce(async()=>{entered();await pending;return {affected:1};});
    await withBusinessScope({userId:owner,businessProfileId:north},()=>drizzle(pool).insert(contentAssetsTable).values({userId:owner,businessProfileId:north,type:'social_post',channel:'instagram',publishPlatform:'instagram',title:'Pending receipt acceptance',content:'Synthetic only',status:'scheduled',scheduledPublishAt:new Date('2026-11-03T18:00:00Z')}));
    const posts:Array<{key:string;body:unknown;status:number}>=[];
    const view=await auditBrowser(async(route,forward)=>{
      const incoming=route.request();if(new URL(incoming.url()).pathname!=='/api/content/calendar/bulk')return false;
      const key=incoming.headers()['idempotency-key'],body=incoming.postDataJSON();
      if(!posts.length){primary=request('/calendar/bulk','POST',body,north,ownerToken,{'Idempotency-Key':key});await waiting;}
      const response=await forward();posts.push({key,body,status:response.status()});await route.fulfill({response});return true;
    });
    try{
      await view.page.goto(`${browserOrigin}/dashboard/content-calendar`);
      await view.page.getByRole('button',{name:'Select scheduled posts',exact:true}).click();
      await view.page.getByRole('checkbox',{name:'Select Pending receipt acceptance',exact:true}).check();
      await view.page.getByRole('button',{name:'Cancel 1 selected',exact:true}).click();
      const response=view.page.waitForResponse(item=>new URL(item.url()).pathname==='/api/content/calendar/bulk');
      await view.page.getByRole('dialog',{name:'Cancel schedules',exact:true}).getByRole('button',{name:'Cancel schedules',exact:true}).click();
      expect((await response).status()).toBe(202);
      await view.page.getByRole('button',{name:'Retry same calendar action',exact:true}).waitFor({state:'visible'});
      expect(await view.page.getByText('Schedules cancelled',{exact:true}).count()).toBe(0);
      await view.page.getByRole('button',{name:'Back',exact:true}).click();await view.page.reload();
      await view.page.getByRole('button',{name:'Retry same calendar action',exact:true}).waitFor({state:'visible'});
      expect(posts).toHaveLength(1);release();expect((await primary!).status).toBe(200);
      const replay=view.page.waitForResponse(item=>new URL(item.url()).pathname==='/api/content/calendar/bulk');
      await view.page.getByRole('button',{name:'Retry same calendar action',exact:true}).click();expect((await replay).status()).toBe(200);
      await view.page.getByText('Schedules cancelled',{exact:true}).waitFor({state:'visible'});
      expect(posts).toHaveLength(2);expect(posts[1].key).toBe(posts[0].key);expect(posts[1].body).toEqual(posts[0].body);expect(changeSchedule).toHaveBeenCalledTimes(1);
      await view.page.reload();expect(await view.page.getByRole('button',{name:'Retry same calendar action',exact:true}).count()).toBe(0);
      await view.record('calendar-pending-receipt-acceptance',{posts,schedulingBoundaryCalls:changeSchedule.mock.calls.length,terminalReceiptConfirmed:true,schedulingBoundary:'deferred mock; actual auth/router/Redis receipt/browser persistence'});
    }finally{release?.();if(primary)await primary;changeSchedule.mockResolvedValue({affected:1});await view.close();}
  },60000);

  it('BC2-02 acceptance: response loss recovers the committed receipt with the same key without another scheduling call',async()=>{
    changeSchedule.mockClear();
    await withBusinessScope({userId:owner,businessProfileId:north},()=>drizzle(pool).insert(contentAssetsTable).values({userId:owner,businessProfileId:north,type:'social_post',channel:'instagram',publishPlatform:'instagram',title:'Lost receipt acceptance',content:'Synthetic only',status:'scheduled',scheduledPublishAt:new Date('2026-11-03T19:00:00Z')}));
    const posts:Array<{key:string;body:unknown;status:number}>=[];
    const view=await auditBrowser(async(route,forward)=>{
      const incoming=route.request();if(new URL(incoming.url()).pathname!=='/api/content/calendar/bulk')return false;
      const response=await forward();posts.push({key:incoming.headers()['idempotency-key'],body:incoming.postDataJSON(),status:response.status()});
      if(posts.length===1)await route.abort('connectionreset');else await route.fulfill({response});return true;
    });
    try{
      await view.page.goto(`${browserOrigin}/dashboard/content-calendar`);
      await view.page.getByRole('button',{name:'Select scheduled posts',exact:true}).click();
      await view.page.getByRole('checkbox',{name:'Select Lost receipt acceptance',exact:true}).check();
      await view.page.getByRole('button',{name:'Cancel 1 selected',exact:true}).click();
      await view.page.getByRole('dialog',{name:'Cancel schedules',exact:true}).getByRole('button',{name:'Cancel schedules',exact:true}).click();
      await view.page.getByText('Calendar action not confirmed',{exact:true}).waitFor({state:'visible'});
      await view.page.reload();
      await view.page.getByRole('button',{name:'Retry same calendar action',exact:true}).click();
      await view.page.getByText('Schedules cancelled',{exact:true}).waitFor({state:'visible'});
      expect(posts).toHaveLength(2);expect(posts.map(post=>post.status)).toEqual([200,200]);expect(posts[1].key).toBe(posts[0].key);expect(posts[1].body).toEqual(posts[0].body);expect(changeSchedule).toHaveBeenCalledTimes(1);
      await view.record('calendar-lost-receipt-acceptance',{posts,schedulingBoundaryCalls:changeSchedule.mock.calls.length,terminalReceiptRecovered:true});
    }finally{await view.close();}
  },60000);

  it('BC2-C03 acceptance: delayed mocked recovery refreshes the newly selected month through the actual calendar read',async()=>{
    const [asset]=await withBusinessScope({userId:owner,businessProfileId:north},()=>drizzle(pool).insert(contentAssetsTable).values({userId:owner,businessProfileId:north,type:'social_post',channel:'facebook',publishPlatform:'facebook',title:'Current month acceptance',content:'Synthetic only',status:'failed',scheduledPublishAt:new Date('2026-11-10T18:00:00Z')}).returning());
    let release!:()=>void,entered!:()=>void;
    const pending=new Promise<void>(resolve=>{release=resolve;});const waiting=new Promise<void>(resolve=>{entered=resolve;});
    const reads:string[]=[];
    const view=await auditBrowser(async(route,forward)=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/api/content/calendar') {
        reads.push(url.searchParams.get('startDate')||'');
        const response=await forward(),body=await response.json();
        for(const item of body.items||[])if(item.contentAssetId===asset.id)item.publishAttempts=[{id:991,platform:'facebook',status:'ambiguous',attemptCount:1,maxAttempts:3,capabilities:{reconcile:true}}];
        await route.fulfill({response,json:body});return true;
      }
      if(url.pathname===`/api/content/assets/${asset.id}/publish-attempts/991/recover`) {entered();await pending;await route.fulfill({json:{success:true}});return true;}
      return false;
    });
    try{
      await view.page.goto(`${browserOrigin}/dashboard/content-calendar`);
      await view.page.getByRole('button',{name:'Open Current month acceptance',exact:true}).click();
      await view.page.getByRole('button',{name:'Check provider status',exact:true}).click();await waiting;
      await view.page.getByRole('button',{name:'Close',exact:true}).click();
      await view.page.getByRole('button',{name:'Next month',exact:true}).click();
      await view.page.getByText('December, 2026',{exact:true}).waitFor();
      release();await view.page.getByText('Provider status checked',{exact:true}).waitFor();
      expect(reads.at(-1)).toBe('2026-12-01');
      expect(await view.page.getByRole('button',{name:'Open Current month acceptance',exact:true}).count()).toBe(0);
      await view.record('current-month-mutation-refresh',{reads,mutation:'mocked recovery response and capabilities',calendarRead:'actual mounted API and PostgreSQL'});
    }finally{release?.();await view.close();}
  },60000);

  it('BC2-T01 acceptance: pending tag text survives sections and saves only after explicit addition',async()=>{
    const created=await request('/brand-toolkits','POST',{name:'Pending tag acceptance '+randomUUID()});
    const view=await auditBrowser(undefined,768);
    try {
      await view.page.goto(`${browserOrigin}/dashboard/brand-toolkit/${created.body.id}`);
      await view.page.getByRole('textbox',{name:'Brand Name',exact:true}).waitFor();
      await view.page.getByRole('button',{name:'Voice & Values',exact:true}).click();
      await view.page.getByLabel('Brand Values',{exact:true}).fill('Explicit synthetic value');
      await view.page.getByRole('button',{name:'Social Media',exact:true}).click();
      await view.page.getByRole('button',{name:'Update Toolkit',exact:true}).click();
      const tag=view.page.getByLabel('Brand Values',{exact:true});await tag.waitFor();
      expect(await tag.inputValue()).toBe('Explicit synthetic value');
      expect(view.traffic.filter(item=>item.method!=='GET')).toEqual([]);
      await view.page.getByRole('button',{name:'Add Brand Values',exact:true}).click();
      await view.page.getByRole('button',{name:'Social Media',exact:true}).click();
      await view.page.getByRole('button',{name:'Update Toolkit',exact:true}).click();
      await view.page.waitForURL('**/dashboard/brand-toolkit');
      const saved=await request(`/brand-toolkits/${created.body.id}`);
      expect(saved.body.brandValues).toEqual(['Explicit synthetic value']);
      await view.record('pending-tag-recovery',{pendingTextSurvived:true,explicitAddition:true,persistedValues:saved.body.brandValues});
    }finally{await view.close();}
  },60000);

  it('BC2-UX03 acceptance: main editor returns keyboard focus to its missing required name',async()=>{
    const view=await auditBrowser(undefined,390);
    try {
      await view.page.goto(`${browserOrigin}/dashboard/brand-toolkit/new`);
      await view.page.getByRole('button',{name:'Social Media',exact:true}).click();
      await view.page.getByRole('heading',{name:'Social Media',exact:true}).waitFor();
      await view.page.getByRole('button',{name:'Create Toolkit',exact:true}).click();
      const input=view.page.getByRole('textbox',{name:'Brand Name',exact:true});
      await input.waitFor();
      await view.page.waitForFunction("document.activeElement?.getAttribute('name') === 'brandName'");
      expect(await input.getAttribute('aria-invalid')).toBe('true');
      expect(view.traffic.filter(item=>item.method!=='GET')).toEqual([]);
      await view.record('required-name-focus',{requiredNameFocused:true,mutationCount:0});
    } finally {await view.close();}
  },60000);

  it('BC2-UX01 acceptance: workspace Cancel retains the draft and explicit Leave switches without cross-business writes',async()=>{
    const view=await auditBrowser();
    try{
      const created=await request('/brand-toolkits','POST',{name:'North guard control '+randomUUID()});
      await view.page.goto(`${browserOrigin}/dashboard/brand-toolkit/${created.body.id}`);
      await view.page.getByRole('textbox',{name:'Brand Name',exact:true}).fill('UNSAVED GUARDED DRAFT');
      await view.page.getByRole('button',{name:'Switch business profile. Current: North audit business',exact:true}).click();
      await view.page.getByRole('button',{name:'Open South audit business business profile',exact:true}).click();
      expect(view.dialogs).toHaveLength(1);expect(view.page.url()).toContain(`/brand-toolkit/${created.body.id}`);
      await view.page.getByRole('button',{name:'Close business chooser',exact:true}).click();
      expect(await view.page.getByRole('textbox',{name:'Brand Name',exact:true}).inputValue()).toBe('UNSAVED GUARDED DRAFT');
      view.page.removeAllListeners('dialog');view.page.on('dialog',async dialog=>{view.dialogs.push(dialog.message());await dialog.accept();});
      await view.page.getByRole('button',{name:'Switch business profile. Current: North audit business',exact:true}).click();
      await view.page.getByRole('button',{name:'Open South audit business business profile',exact:true}).click();
      await view.page.waitForURL('**/dashboard/home');expect(view.dialogs).toHaveLength(2);
      await view.page.goto(`${browserOrigin}/dashboard/brand-toolkit`);
      await view.page.getByText('No brand toolkits yet',{exact:true}).waitFor({state:'visible'});
      expect((await request(`/brand-toolkits/${created.body.id}`)).body.name).toMatch(/^North guard control/);
      expect(view.traffic.filter(item=>item.method!=='GET')).toEqual([]);
      await view.record('workspace-draft-guard-acceptance',{cancelPreservedDraft:true,explicitLeaveSelectedSouth:true,noMutation:true,dialogCount:view.dialogs.length});
    }finally{await view.close();}
  },60000);
  it('BC2-UX01 acceptance: pending inline upload stays with its captured business across actual chooser navigation',async()=>{
    let release!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    const pending=new Promise<void>(resolve=>{release=resolve;});
    let uploadBusiness:string|undefined,replyStatus=0;
    const first=await request('/brand-toolkits','POST',{name:'Captured North upload '+randomUUID()});
    const view=await auditBrowser(async(route,forward)=>{
      if(new URL(route.request().url()).pathname!==`/api/content/brand-toolkits/${first.body.id}/logo`)return false;
      uploadBusiness=route.request().headers()['x-business-profile-id'];
      const response=await forward();replyStatus=response.status();entered();
      await pending;
      try {await route.fulfill({response});} catch(error) {if(!/closed|cancel|interrupted|invalid interception/i.test(String(error)))throw error;}
      return true;
    });
    try {
      await view.page.goto(`${browserOrigin}/dashboard/brand-toolkit/${first.body.id}`);
      await view.page.getByRole('textbox',{name:'Brand Name',exact:true}).waitFor({state:'visible'});
      const buffer=await sharp({create:{width:32,height:24,channels:4,background:'#5588aaff'}}).png().toBuffer();
      await view.page.getByLabel('Brand Logo',{exact:true}).setInputFiles({name:'captured.png',mimeType:'image/png',buffer});
      await waiting;
      view.page.removeAllListeners('dialog'); view.page.on('dialog',async dialog=>{view.dialogs.push(dialog.message());await dialog.accept();});
      await view.page.getByRole('button',{name:'Switch business profile. Current: North audit business',exact:true}).click();
      await view.page.getByRole('button',{name:'Open South audit business business profile',exact:true}).click();
      await view.page.waitForURL('**/dashboard/home');release();
      await view.page.goto(`${browserOrigin}/dashboard/brand-toolkit`);
      await view.page.getByText('No brand toolkits yet',{exact:true}).waitFor({state:'visible'});
      const stored=(await admin.query('SELECT business_profile_id,logo_url,version FROM brand_toolkits WHERE id=$1',[first.body.id])).rows[0];
      expect(replyStatus).toBe(200);expect(uploadBusiness).toBe(String(north));expect(stored.business_profile_id).toBe(north);expect(stored.version).toBe(2);expect(stored.logo_url).toBeTruthy();
      expect(view.traffic.filter(item=>item.method!=='GET').every(item=>item.profile===String(north))).toBe(true);
      expect(await view.page.getByText('Logo uploaded successfully',{exact:true}).count()).toBe(0);
      await view.record('cross-workspace-pending-upload',{requestBusiness:north,selectedBusiness:south,committedBusiness:stored.business_profile_id,committedVersion:stored.version,lateToast:false,noSouthMutation:true,uploadCommit:'completed before chooser navigation; changing workspace does not cancel a committed operation'});
    } finally {release?.();await view.close();}
  },60000);

  it('BC2-S01 receipt acceptance: a lost modal creation response replays one persisted toolkit',async()=>{
    let posts=0;const keys:unknown[]=[];
    const view=await auditBrowser(async(route,forward)=>{
      const incoming=route.request();if(new URL(incoming.url()).pathname!=='/api/content/brand-toolkits'||incoming.method()!=='POST')return false;
      posts++;keys.push(incoming.postDataJSON().idempotencyKey);const response=await forward();expect(response.status()).toBe(201);
      if(posts===1)await route.abort('connectionreset');else await route.fulfill({response});return true;
    });
    try{
      const name='Modal retry acceptance '+randomUUID();
      await view.page.goto(`${browserOrigin}/dashboard/conversations/509`);
      await view.page.getByRole('button',{name:'Create Brand Toolkit',exact:true}).click();
      const dialog=view.page.getByRole('dialog',{name:'Create Brand Toolkit',exact:true});
      await dialog.getByRole('textbox',{name:'Brand Name *',exact:true}).fill(name);
      await dialog.getByRole('button',{name:'Target Audience',exact:true}).click();
      await dialog.getByRole('button',{name:'Save Toolkit',exact:true}).click();
      await view.page.getByText('Failed to fetch',{exact:true}).waitFor({state:'visible'});
      await dialog.getByRole('button',{name:'Save Toolkit',exact:true}).click();await dialog.waitFor({state:'hidden'});
      const rows=(await admin.query('SELECT id,creation_request_key FROM brand_toolkits WHERE user_id=$1 AND business_profile_id=$2 AND name=$3',[owner,north,name])).rows;
      expect(rows).toHaveLength(1);expect(keys[0]).toEqual(expect.any(String));expect(keys[1]).toBe(keys[0]);expect(posts).toBe(2);
      await view.record('modal-creation-receipt-acceptance',{posts,persistedRows:rows.length,sameReceiptKey:keys[0]===keys[1]});
    }finally{await view.close();}
  },60000);

  it('BC2-S01 upload acceptance: waits for selected logos and retains multiple real stored objects on creation',async()=>{
    let release!:()=>void,entered!:()=>void;let uploads=0;
    const pending=new Promise<void>(resolve=>{release=resolve;});const waiting=new Promise<void>(resolve=>{entered=resolve;});
    const view=await auditBrowser(async(route,forward)=>{
      if(new URL(route.request().url()).pathname!=='/api/content/brand-toolkits/upload-logo')return false;
      const response=await forward();expect(response.status()).toBe(200);uploads++;if(uploads===2)entered();await pending;await route.fulfill({response});return true;
    },390);
    try{
      const name='Modal logos acceptance '+randomUUID();const buffer=await sharp({create:{width:32,height:24,channels:4,background:'#336699ff'}}).png().toBuffer();
      await view.page.goto(`${browserOrigin}/dashboard/conversations/509`);
      await view.page.getByRole('button',{name:'Create Brand Toolkit',exact:true}).click();
      const dialog=view.page.getByRole('dialog',{name:'Create Brand Toolkit',exact:true});
      await dialog.getByRole('textbox',{name:'Brand Name *',exact:true}).fill(name);
      await dialog.getByRole('button',{name:'Visual Identity',exact:true}).click();
      await dialog.locator('input[type=file]').setInputFiles({name:'first.png',mimeType:'image/png',buffer});
      await dialog.locator('input[type=file]').setInputFiles({name:'second.png',mimeType:'image/png',buffer});await waiting;
      await dialog.getByRole('button',{name:'Target Audience',exact:true}).click();
      expect(await dialog.getByRole('button',{name:'Save Toolkit',exact:true}).isDisabled()).toBe(true);
      expect((await admin.query('SELECT id FROM brand_toolkits WHERE user_id=$1 AND business_profile_id=$2 AND name=$3',[owner,north,name])).rows).toHaveLength(0);
      release();
      await dialog.getByRole('button',{name:'Target Audience',exact:true}).click();await dialog.getByRole('button',{name:'Save Toolkit',exact:true}).click();await dialog.waitFor({state:'hidden'});
      const row=(await admin.query('SELECT id,logo_urls FROM brand_toolkits WHERE user_id=$1 AND business_profile_id=$2 AND name=$3',[owner,north,name])).rows[0];
      expect(row.logo_urls).toHaveLength(2);expect(uploads).toBe(2);
      for(const url of row.logo_urls){const file=(await admin.query('SELECT storage_key FROM storage_files WHERE user_id=$1 AND business_profile_id=$2 AND url=$3',[owner,north,url])).rows[0];expect(await objectStorage.exists(file.storage_key)).toBe(true);}
      await view.record('modal-upload-save-acceptance',{uploads,savedLogos:row.logo_urls.length,storedObjectsValid:true});
    }finally{release?.();await view.close();}
  },60000);

  it('BC2-UX02 acceptance: actual PostgreSQL read failure retains the calendar and read-only retry recovers',async()=>{
    await withBusinessScope({userId:owner,businessProfileId:north},()=>drizzle(pool).insert(contentAssetsTable).values({userId:owner,businessProfileId:north,type:'social_post',channel:'instagram',publishPlatform:'instagram',title:'Refresh failure acceptance',content:'Synthetic only',status:'scheduled',scheduledPublishAt:new Date('2026-11-03T18:00:00Z')}));
    const view=await auditBrowser();let fault=false;
    try{
      await view.page.goto(`${browserOrigin}/dashboard/content-calendar`);
      await view.page.getByRole('button',{name:'Open Refresh failure acceptance',exact:true}).waitFor({state:'visible'});
      await admin.query('ALTER TABLE content_assets RENAME COLUMN title TO title_fixture_fault');fault=true;
      const failed=view.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/content/calendar'&&response.status()===500);
      await view.page.evaluate("window.dispatchEvent(new Event('focus'))");await failed;
      await view.page.getByText(/Calendar may be out of date/).waitFor({state:'visible'});
      expect(await view.page.getByRole('button',{name:'Open Refresh failure acceptance',exact:true}).isVisible()).toBe(true);
      await admin.query('ALTER TABLE content_assets RENAME COLUMN title_fixture_fault TO title');fault=false;
      const recovered=view.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/content/calendar'&&response.status()===200);
      await view.page.getByRole('button',{name:'Retry calendar refresh',exact:true}).click();await recovered;
      await view.page.getByText(/Calendar may be out of date/).waitFor({state:'hidden'});
      expect(view.traffic.filter(item=>item.method!=='GET')).toEqual([]);
      await view.record('calendar-refresh-recovery-acceptance',{temporarySchemaFaultRestored:true,retainedLoadedContent:true,readOnlyRetry:true});
    }finally{if(fault)await admin.query('ALTER TABLE content_assets RENAME COLUMN title_fixture_fault TO title');await view.close();}
  },60000);
});
