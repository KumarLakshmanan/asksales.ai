import { jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../models/db.js';
import { AdPerformanceService } from '../services/ads/AdPerformanceService.js';
const dialect=new PgDialect();
afterEach(()=>{jest.restoreAllMocks();jest.useRealTimers();});
it('uses the selected account currency and date window without rounding attributed conversions',async()=>{
  jest.useFakeTimers();jest.setSystemTime(new Date('2026-09-12T12:00:00Z'));
  const raw={accountIdentity:{adAccountId:'1234567890',currency:'INR'},campaign:{objective:'conversions',budgetAmount:50,budgetType:'daily'},reportingWindow:{start:'2026-06-15',end:'2026-09-12'},dailyInsights:[{date:'2026-08-01',spend:30,conversions:6},{date:'2026-09-10',spend:2.5,conversions:1.75,impressions:100,clicks:10}]};
  const queries:Array<{sql:string;params:unknown[]}>=[];
  jest.spyOn(db,'execute').mockImplementation(async(query:any)=>{
    const compiled=dialect.sqlToQuery(query);queries.push(compiled);
    if(compiled.sql.includes('FROM paid_ad_accounts'))return {rows:[{id:3,user_id:12,platform:'google',provider_account_id:'1234567890',currency:'INR',is_active:true}]};
    if(compiled.sql.includes('FROM campaign_performance_cache')&&compiled.sql.includes('LIMIT 2'))return {rows:[{name:'Scoped campaign',platform_entity_id:'7',status:'active',last_refreshed_at:new Date(),raw_data:raw}]};
    return {rows:[]};
  });
  const result=await new AdPerformanceService().providerPerformanceDetail(12,'google','7',7,3);
  expect(result.campaign).toMatchObject({currency:'INR',budget_amount:50,objective:'conversions',reporting_window:{start:'2026-09-06',end:'2026-09-12'}});
  expect(result.providerAggregate).toMatchObject({spend:2.5,conversions:1.75,clicks:10});
  expect(result.performanceTrace).toHaveLength(1);
  const cached=queries.filter(query=>query.sql.includes('FROM campaign_performance_cache'));
  expect(cached.every(query=>query.params.includes('1234567890'))).toBe(true);
  expect(result.evaluations).toEqual([]);
});
it('requires account selection when provider IDs are ambiguous',async()=>{
  jest.spyOn(db,'execute').mockImplementation(async(query:any)=>{
    const compiled=dialect.sqlToQuery(query);
    return {rows:compiled.sql.includes('FROM campaign_performance_cache')&&compiled.sql.includes('LIMIT 2')?[{id:1},{id:2}]:[]};
  });
  await expect(new AdPerformanceService().providerPerformanceDetail(12,'google','7',7)).rejects.toThrow('Select an ad account');
});
