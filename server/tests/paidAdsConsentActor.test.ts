import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withBusinessScope } from '../tenancy/businessContext.js';

const writes: Array<{sql:string;params:any[]}> = [];
const execute = jest.fn<any>(async(query:any)=>{
 const compiled=new PgDialect().sqlToQuery(query);const text=compiled.sql;
 if(text.includes('INSERT INTO'))writes.push(compiled);
 if(text.includes('SELECT * FROM performance_ad_campaigns'))return {rows:[]};
 if(text.includes('INSERT INTO performance_ad_campaigns'))return {rows:[{id:19}]};
 if(text.includes('SELECT id FROM performance_ad_campaigns'))return {rows:[{id:19}]};
 return {rows:[]};
});
jest.unstable_mockModule('../models/db.js',()=>({db:{execute,transaction:async(fn:any)=>fn({execute})}}));
const {AdPerformanceService}=await import('../services/ads/AdPerformanceService.js');
const {AutonomousAdsService}=await import('../services/ads/AutonomousAdsService.js');
const performance=new AdPerformanceService();const autonomous=new AutonomousAdsService();
const readiness={meta:false,google:false,reasons:{},currencies:{},accounts:{capturedAt:new Date().toISOString()}};
jest.spyOn(autonomous,'getSettings').mockResolvedValue({defaultLifetimeBudget:100,currency:'USD',locations:[],liveProviderMutationsEnabled:false} as any);
jest.spyOn(autonomous,'getAccountReadiness').mockResolvedValue(readiness as any);
function consentValue(table:string) {
 const write=writes.find(item=>item.sql.includes(`INSERT INTO ${table} (`));expect(write).toBeDefined();
 const columns=write!.sql.split('(')[1].split(')')[0].split(',').map(v=>v.trim());
 const values=write!.sql.split('VALUES (')[1].split(')')[0].split(',').map(v=>v.trim());
 const placeholder=values[columns.indexOf('consented_by_user_id')];
 return write!.params[Number(placeholder.slice(1))-1];
}
describe('Paid Ads consent actor remains distinct from resource owner',()=>{
 beforeEach(()=>{writes.length=0;execute.mockClear();});
 it.each([1,2])('attributes campaign policy consent to actor %i',async actor=>{
  await withBusinessScope({userId:1,actorUserId:actor,businessProfileId:11},()=>performance.updateCampaignPolicy(1,19,{enabled:true}));
  expect(consentValue('ad_campaign_autonomy_policies')).toBe(actor);
 });
 it.each([1,2])('attributes account autonomy consent to actor %i',async actor=>{
  await withBusinessScope({userId:1,actorUserId:actor,businessProfileId:11},()=>performance.updateAutonomySettings(1,{mode:'advisory'}));
  expect(consentValue('ad_settings')).toBe(actor);
 });
 it.each([1,2])('attributes draft-review consent to actor %i without provider effects',async actor=>{
  await withBusinessScope({userId:1,actorUserId:actor,businessProfileId:11},()=>autonomous.createCampaign(1,{
   name:'Synthetic draft',objective:'traffic',platforms:['meta'],idempotencyKey:crypto.randomUUID(),publish:false,allowAiPause:true,
   creatives:{meta:[]},startDate:new Date('2090-01-01'),landingPageUrl:'https://example.test/offer',
  } as any));
  expect(consentValue('ad_campaign_autonomy_policies')).toBe(actor);
 });
 it('clears consent on revocation rather than attributing it to another actor',async()=>{
  await withBusinessScope({userId:1,actorUserId:2,businessProfileId:11},()=>performance.updateCampaignPolicy(1,19,{enabled:false}));
  expect(consentValue('ad_campaign_autonomy_policies')).toBeNull();
 });
});
