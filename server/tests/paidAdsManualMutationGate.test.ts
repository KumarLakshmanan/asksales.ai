import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import express from 'express';
import request from 'supertest';
import { withBusinessScope } from '../tenancy/businessContext.js';

let tenantGate = true;
let failSettings = false;
let ownerAccount = '12';
let duringRead: (() => void) | undefined;
const operations: Array<{url:string;method:string;body?:string}> = [];
const execute = jest.fn<any>(async (query:any) => {
  if(new PgDialect().sqlToQuery(query).sql.includes("FROM performance_ad_campaigns campaign"))return {rows:[]};
  if (failSettings) throw new Error('Synthetic settings outage');
  return {rows:[{live_provider_mutations_enabled:tenantGate}]};
});
const updateStatus = jest.fn<any>(async()=>{});
const deleteByEntityId = jest.fn<any>(async()=>{});
jest.unstable_mockModule('../models/db.js',()=>({db:{execute,transaction:async(fn:any)=>fn({execute})}}));
jest.unstable_mockModule('../middleware/auth.js',()=>({authenticateToken:(req:any,_res:any,next:any)=>{
  req.user={id:2}; return withBusinessScope({userId:1,actorUserId:2,businessProfileId:11,role:'member'},next);
}}));
jest.unstable_mockModule('../models/platformAccess/functions.js',()=>({getEffectiveModuleAccess:async()=>[{key:'performance_marketing',enabled:true,status:'available'}],getMaintenanceSettings:async()=>({enabled:false})}));
jest.unstable_mockModule('../models/metaPageConnections/functions.js',()=>({getMetaAdsCreds:async()=>({accessToken:'synthetic-not-a-token',adAccountId:'act_12',pageId:'34',apiVersion:'v25.0'})}));
jest.unstable_mockModule('../models/campaignPerformanceCache/index.js',()=>({CampaignPerformanceCacheModel:{updateStatus,deleteByEntityId}}));
const originalFetch=global.fetch;
const previousGate=process.env.AD_PROVIDER_MUTATIONS_ENABLED;
global.fetch=jest.fn<any>(async(url:any,init:any={})=>{
  const method=init.method||'GET';operations.push({url:String(url),method,body:init.body});
  if(method==='GET')duringRead?.();
  return {ok:true,status:200,json:async()=>method==='GET'?{account_id:ownerAccount}:{success:true}};
});
const {default:router}=await import('../routes/campaigns.routes.js');
const app=express();app.use(express.json());app.use('/api/campaigns',router);
const targets=['campaigns','adsets','ads'];
const routes=targets.flatMap(target=>[
  {method:'post' as const,path:`/api/campaigns/meta/${target}/123/pause`,status:'PAUSED'},
  {method:'post' as const,path:`/api/campaigns/meta/${target}/123/resume`,status:'ACTIVE'},
  {method:'delete' as const,path:`/api/campaigns/meta/${target}/123`,status:null},
]);
describe('mounted Meta manual mutation authority (all provider IO intercepted)',()=>{
  beforeEach(()=>{tenantGate=true;failSettings=false;ownerAccount='12';duringRead=undefined;operations.length=0;execute.mockClear();updateStatus.mockClear();deleteByEntityId.mockClear();process.env.AD_PROVIDER_MUTATIONS_ENABLED='true';});
  afterAll(()=>{global.fetch=originalFetch;if(previousGate===undefined)delete process.env.AD_PROVIDER_MUTATIONS_ENABLED;else process.env.AD_PROVIDER_MUTATIONS_ENABLED=previousGate;});
  it.each(routes)('blocks $method $path when the environment gate is disabled',async route=>{
    process.env.AD_PROVIDER_MUTATIONS_ENABLED='false';const res=await request(app)[route.method](route.path).send({});
    expect(res.status).toBe(403);expect(operations).toEqual([]);expect(updateStatus).not.toHaveBeenCalled();expect(deleteByEntityId).not.toHaveBeenCalled();
  });
  it.each(routes)('blocks $method $path when the tenant gate is disabled',async route=>{
    tenantGate=false;const res=await request(app)[route.method](route.path).send({});
    expect(res.status).toBe(403);expect(operations).toEqual([]);
  });
  it.each(routes)('fails closed on settings outage for $method $path',async route=>{
    failSettings=true;const res=await request(app)[route.method](route.path).send({});expect(res.status).toBe(503);expect(operations).toEqual([]);
  });
  it.each(routes)('retains the authenticated owner and exact account/target for $method $path',async route=>{
    const res=await request(app)[route.method](route.path).send({});expect(res.status).toBe(200);
    expect(operations).toHaveLength(2);expect(operations[1]).toMatchObject({url:'https://graph.facebook.com/v25.0/123',method:route.method==='delete'?'DELETE':'POST',...(route.status?{body:JSON.stringify({status:route.status})}:{})});
    if(route.path.includes('/ads/'))return;
    if(route.status)expect(updateStatus).toHaveBeenCalledWith(1,'123',route.status==='ACTIVE'?'active':'paused');else expect(deleteByEntityId).toHaveBeenCalledWith(1,'123');
  });
  it.each(['tenant','environment'])('rechecks %s authority after asynchronous provider ownership reads',async gate=>{
    duringRead=()=>{if(gate==='tenant')tenantGate=false;else process.env.AD_PROVIDER_MUTATIONS_ENABLED='false';};
    const res=await request(app).post('/api/campaigns/meta/campaigns/123/resume').send({});expect(res.status).toBe(403);expect(operations.every(op=>op.method==='GET')).toBe(true);expect(updateStatus).not.toHaveBeenCalled();
  });
  it('does not mutate a target outside the connected account',async()=>{
    ownerAccount='99';const res=await request(app).post('/api/campaigns/meta/campaigns/123/resume').send({});expect(res.status).toBe(404);expect(operations.every(op=>op.method==='GET')).toBe(true);
  });
});
