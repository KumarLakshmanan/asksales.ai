/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { getTableName } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';
process.env.JWT_SECRET = 'synthetic-browser-flow-signing';
process.env.OAUTH_STATE_SECRET = 'synthetic-browser-flow-signing';
process.env.APP_URL = 'https://api.example.test';
process.env.CLIENT_URL = 'https://app.example.test';
process.env.FRONTEND_URL = 'https://app.example.test';
delete process.env.NGROK_URL;
const scope = { userId: 9, actorUserId: 12, businessProfileId: 11, role: 'billing_admin' as const };
const store = new Map<string,string>();
const resolveScope = jest.fn<any>();
const verify = jest.fn<any>();
const revoked = jest.fn<any>();
const user = jest.fn<any>();
const admin = jest.fn<any>();
const save = jest.fn<any>();
const exchange = jest.fn<any>();
const sdkExchange = jest.fn<any>();
const upsert = jest.fn<any>();
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => ({
  set: async (key: string,value: string) => { store.set(key,value); return 'OK'; },
  get: async (key: string) => store.get(key) || null,
  getdel: async (key:string) => {const value=store.get(key);store.delete(key);return value || null;},
  eval: async (_script: string,_count: number,key: string, expected?: string) => {
    const value = store.get(key); if (expected && value !== expected) return null; store.delete(key); return value || null;
  },
}) }));
jest.unstable_mockModule('../tenancy/businessScopeResolver.js', () => ({ resolveBusinessScope: resolveScope }));
jest.unstable_mockModule('../utils/jwt.js', () => ({ verifyToken: verify, isTokenRevoked: revoked }));
jest.unstable_mockModule('../models/users/functions.js', () => ({ getUserById: user }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: admin }));
jest.unstable_mockModule('../services/credentialService.js', () => ({ getCredential: async () => null, saveCredential: save }));
jest.unstable_mockModule('../models/channelCredentials/functions.js', () => ({ ChannelCredentialModel: { upsert } }));
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  select: () => ({ from: (table:any) => ({ where: () => ({ limit: async () => getTableName(table)==='ai_visibility_projects' ? [{id:7,userId:9,domain:'example.test',status:'active'}] : [] }) }) }),
  update: () => ({ set: () => ({ where: async () => [] }) }),
  insert: () => ({values:()=>({onConflictDoUpdate:async()=>[]})}),
} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(),warn: jest.fn(),info: jest.fn() } }));
jest.unstable_mockModule('googleapis', () => ({ google: {
  auth: { OAuth2: class {
    transporter = { interceptors: { request: { add: jest.fn() } } };
    generateAuthUrl(options: any) { return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ ...options, scope:options.scope.join(' ') })}`; }
    getToken = sdkExchange; setCredentials = jest.fn();
  } },
  youtube: () => ({ channels: { list: async () => ({ data: { items: [{ id:'fixture-channel',snippet:{title:'Fixture'} }] } }) } }),
} }));
const { default: ads } = await import('../controllers/googleAdsOAuthController.js');
jest.unstable_mockModule('../services/integrations/ProviderVerificationService.js',()=>({verifyProviderIntegration:jest.fn(),providerVerificationRequiresReconnect:()=>false}));
const { default: facebook } = await import('../controllers/facebookOAuthController.js');
const { default: instagram } = await import('../controllers/instagramOAuthController.js');
const { default: metaAds } = await import('../controllers/adPlatformOAuthController.js');
const { GoogleSearchConsoleService } = await import('../services/aiVisibility/GoogleSearchConsoleService.js');
const {oauthBrowserCallback,oauthBrowserFlow} = await import('../services/OAuthBrowserFlowService.js');
const { default: youtube } = await import('../controllers/youtubeOAuthController.js');
const app = express();
app.use((req,_res,next) => { if (req.path.endsWith('/callback')) return next(); req.user={id:12} as any; return withBusinessScope(scope,next); });
app.use('/api/google-ads/oauth',ads); app.use('/api/youtube/oauth',youtube);
app.use('/api/facebook/oauth',facebook);app.use('/api/instagram/oauth',instagram);app.use('/api/meta/oauth',metaAds);
app.get('/api/ai-visibility/gsc/auth',async(req,res)=>{res.json(await new GoogleSearchConsoleService(exchange as typeof fetch).authorizationUrl(9,7,req,res));});
app.get('/api/ai-visibility/gsc/oauth/callback',oauthBrowserCallback('google_search_console',(res,code)=>res.redirect(`https://app.example.test/gsc?error=${code}`)),async(req,res)=>{
  try {await new GoogleSearchConsoleService(exchange as typeof fetch).completeOAuth(String(req.query.code),String(req.query.state),oauthBrowserFlow(req));return res.redirect('https://app.example.test/gsc?gsc=connected');}
  catch {return res.redirect('https://app.example.test/gsc?error=connection_failed');}
});
const paths:Record<string,string>={youtube:'/api/youtube/oauth/auth',google_ads:'/api/google-ads/oauth?format=json',facebook:'/api/facebook/oauth/authorize?format=json',instagram:'/api/instagram/oauth/authorize?format=json',meta_ads:'/api/meta/oauth?format=json',google_search_console:'/api/ai-visibility/gsc/auth'};
const pathFor=(provider:string)=>paths[provider];
const callbackPaths:Record<string,string>={youtube:'/api/youtube/oauth/callback',google_ads:'/api/google-ads/oauth/callback',facebook:'/api/facebook/oauth/callback',instagram:'/api/instagram/oauth/callback',meta_ads:'/api/meta/oauth/callback',google_search_console:'/api/ai-visibility/gsc/oauth/callback'};
async function start(provider = 'google_ads') {
  const response = await request(app).get(pathFor(provider)).set('Cookie','asksales_session=fixture-session');
  expect(response.status).toBe(200);
  const url = new URL(response.body.url || response.body.authUrl);
  const cookie = (response.headers['set-cookie'] as unknown as string[]).find(value => value.startsWith('oauth_flow_'))!.split(';')[0];
  return { url,state:url.searchParams.get('state')!,cookies:['asksales_session=fixture-session',cookie], callback:callbackPaths[provider] };
}
const callback = (flow: Awaited<ReturnType<typeof start>>, extra: Record<string,string> = {}) => request(app).get(flow.callback)
  .set('Host','app.example.test').set('Cookie',flow.cookies).query({ state:flow.state,code:'fixture-code',...extra });
beforeEach(() => {
  jest.clearAllMocks();store.clear();
  admin.mockReset().mockResolvedValue({ apiKey:'fixture-client',apiSecret:'fixture-secret',config:{instagramAppId:'fixture-ig-app',instagramAppSecret:'fixture-ig-secret'} });
  resolveScope.mockReset().mockResolvedValue(scope); verify.mockReset().mockReturnValue({userId:12,jti:'fixture-jti',iat:Math.floor(Date.now()/1000)});
  revoked.mockReset().mockResolvedValue(false);user.mockReset().mockResolvedValue({id:12});
  exchange.mockReset().mockImplementation(async (url:string) => new Response(JSON.stringify(url.includes('/sites') ? {siteEntry:[{siteUrl:'sc-domain:example.test',permissionLevel:'siteOwner'}]} : {access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600}),{status:200}));
  globalThis.fetch=exchange; save.mockReset().mockResolvedValue({id:1});
  sdkExchange.mockReset().mockResolvedValue({tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh',scope:'https://www.googleapis.com/auth/youtube.upload',expiry_date:Date.now()+3600_000}});
  upsert.mockReset().mockResolvedValue({id:31});
});
describe('provider OAuth browser and PKCE acceptance', () => {
  it.each(['google_ads','youtube'])('%s binds S256 consent to its browser, actor, business and one-time state', async provider => {
    const flow=await start(provider);
    expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(JSON.stringify([...store.values()])).not.toContain('fixture-session');
    expect((await callback(flow)).headers.location).toMatch(/(google_connected|youtube_connected)=true/);
    const verifier=provider==='youtube' ? (sdkExchange.mock.calls[0][0] as any).codeVerifier : new URLSearchParams((exchange.mock.calls[0][1] as any).body).get('code_verifier');
    expect(crypto.createHash('sha256').update(verifier).digest('base64url')).toBe(flow.url.searchParams.get('code_challenge'));
    const exchanges=exchange.mock.calls.length+sdkExchange.mock.calls.length;
    expect((await callback(flow,{code:'different-fresh-code'})).headers.location).toContain('invalid_or_expired_state');
    expect(exchange.mock.calls.length+sdkExchange.mock.calls.length).toBe(exchanges);
  });
  it.each(['google_ads','youtube','facebook','instagram','meta_ads','google_search_console'])('%s rejects another browser before any exchange', async provider => {
    const flow=await start(provider);flow.cookies=[];
    const response=await callback(flow);expect(response.headers.location).toContain('session_changed');
    if(provider==='youtube') expect(new URL(response.headers.location).searchParams.get('youtube_error')).toBe('session_changed');
    expect(exchange).not.toHaveBeenCalled();expect(sdkExchange).not.toHaveBeenCalled();
  });
  it.each(['changed','expired','revoked','deleted','password-changed','role-changed'])('rejects %s authority', async mode => {
    const flow=await start();
    if(mode==='changed') flow.cookies[0]='asksales_session=other';
    if(mode==='expired') verify.mockReturnValue(null);
    if(mode==='revoked') revoked.mockResolvedValue(true);
    if(mode==='deleted') user.mockResolvedValue({id:12,deletedAt:new Date()});
    if(mode==='password-changed') user.mockResolvedValue({id:12,passwordChangedAt:new Date(Date.now()+1000)});
    if(mode==='role-changed') resolveScope.mockResolvedValue({...scope,role:'member'});
    expect((await callback(flow)).headers.location).not.toContain('google_connected=true');expect(exchange).not.toHaveBeenCalled();
  });
  it('allows only one concurrent callback', async () => {
    const flow=await start();const responses=await Promise.all([callback(flow),callback(flow)]);
    expect(responses.filter(r=>r.headers.location.includes('google_connected=true'))).toHaveLength(1);expect(exchange).toHaveBeenCalledTimes(1);
  });
  it('rejects changed client configuration before token exchange', async () => {
    const flow=await start();admin.mockResolvedValue({apiKey:'changed',apiSecret:'changed',config:{}});
    expect((await callback(flow)).headers.location).toContain('connection_failed');expect(exchange).not.toHaveBeenCalled();
  });
  it('hands API-host callbacks to the trusted cookie origin once', async () => {
    const flow=await start();
    const handoff=await request(app).get(flow.callback).set('Host','api.example.test').query({state:flow.state,code:'fixture-code'});
    const destination=new URL(handoff.headers.location);expect(destination.origin).toBe('https://app.example.test');expect(exchange).not.toHaveBeenCalled();
    const done=await request(app).get(destination.pathname+destination.search).set('Host','app.example.test').set('Cookie',flow.cookies);
    expect(done.headers.location).toContain('google_connected=true');expect(exchange).toHaveBeenCalledTimes(1);
  });
  it('does not leak provider details and handles denied consent without exchange', async () => {
    const response=await callback(await start(),{error:'access_denied',error_description:'access_token=private'});
    expect(response.headers.location).not.toContain('private');expect(exchange).not.toHaveBeenCalled();
  });
  it.each(['facebook','instagram','meta_ads'])('%s cancellation still consumes the bound browser flow',async provider=>{
    const flow=await start(provider);const response=await callback(flow,{error:'access_denied'});
    expect(response.headers.location).toContain('access_denied');expect(exchange).not.toHaveBeenCalled();
    expect((await callback(flow,{code:'new-code'})).headers.location).toContain('invalid_or_expired_state');
  });
  it('Search Console binds its token exchange to PKCE and consumes state once',async()=>{
    const flow=await start('google_search_console');expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
    const response=await callback(flow);expect(response.headers.location).toContain('gsc=connected');
    const options=exchange.mock.calls[0][1] as {body:URLSearchParams};
    expect(crypto.createHash('sha256').update(options.body.get('code_verifier')!).digest('base64url')).toBe(flow.url.searchParams.get('code_challenge'));
    const count=exchange.mock.calls.length;expect((await callback(flow)).headers.location).toContain('invalid_or_expired_state');expect(exchange).toHaveBeenCalledTimes(count);
  });

});
