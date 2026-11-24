import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../models/db.js';
import { adPerformanceService } from '../services/ads/AdPerformanceService.js';
import { getAdsDashboard } from '../controllers/campaignAnalyticsController.js';
const dialect=new PgDialect();
const provider=(id:string,status:string,objective='OUTCOME_TRAFFIC',platform='meta')=>({id,platform,status,platform_entity_id:id,ad_account_id:'account-1',account_registry_id:7,name:id,last_refreshed_at:new Date(),raw_data:{campaign:{objective},accountIdentity:{currency:'INR',adAccountId:'account-1'},dailyInsights:[{date:new Date().toISOString().slice(0,10),impressions:100,clicks:10,spend:20,conversions:2}]}});
let queries:Array<{sql:string;params:unknown[]}>;
beforeEach(()=>{
  queries=[];
  jest.spyOn(db,'execute').mockImplementation(async(query:any)=>{const compiled=dialect.sqlToQuery(query);queries.push(compiled);
    if(compiled.sql.includes('SELECT DISTINCT UPPER'))return {rows:[{currency:'INR'}]};
    if(compiled.sql.includes('SELECT cache.*'))return {rows:[provider('active','ACTIVE'),provider('paused','PAUSED'),provider('failed','PROVIDER_FAILED'),provider('messages','ACTIVE','MESSAGES'),provider('google','ENABLED','SEARCH','google')]};
    return {rows:[]};
  });
  jest.spyOn(adPerformanceService,'dashboardSummary').mockResolvedValue({dataFreshnessAt:null} as any);
});
afterEach(()=>{jest.restoreAllMocks();});
async function dashboard(query:Record<string,string>){const res={status:jest.fn<any>(),json:jest.fn<any>()};res.status.mockReturnValue(res);await getAdsDashboard({user:{id:9},query} as any,res as any);return {res,body:res.json.mock.calls[0][0] as {success:boolean;campaigns:Array<{platformCampaignId:string;status:string}>;availableCurrencies:string[]}};}
describe('Paid Ads reporting filters',()=>{
  it.each([['active',['active','messages','google']],['paused',['paused']],['provider_failed',['failed']]])('keeps report-only provider campaigns under %s delivery',async(status,ids)=>{
    const {body}=await dashboard({status});expect(body.success).toBe(true);expect(body.campaigns.map((c:any)=>c.platformCampaignId)).toEqual(ids);
    expect(body.campaigns.every((c:any)=>c.status==='report_only')).toBe(true);
  });
  it.each([['conversations',['messages']],['conversions',['google']]])('filters by the displayed %s objective',async(objective,ids)=>{
    const {body}=await dashboard({objective});expect(body.success).toBe(true);expect(body.campaigns.map((c:any)=>c.platformCampaignId)).toEqual(ids);
  });
  it('keeps draft filtering on local draft records and currency selection visible',async()=>{
    const {body}=await dashboard({status:'draft'});expect(body.campaigns).toEqual([]);expect(body.availableCurrencies).toEqual(['INR']);
    expect(queries.some(q=>q.sql.includes("LOWER(COALESCE(pac.local_status, pac.status, ''))")&&q.sql.includes("= 'draft'"))).toBe(true);
  });
});
