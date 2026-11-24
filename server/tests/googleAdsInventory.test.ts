import { jest } from '@jest/globals';
const search=jest.fn<(...args:any[])=>Promise<any[]>>();
const upsert=jest.fn<(...args:any[])=>Promise<number>>().mockResolvedValue(1);
jest.unstable_mockModule('../services/ads/GoogleAdsService.js',()=>({searchGoogleAds:search}));
jest.unstable_mockModule('../services/ads/PaidAdAccountsService.js',()=>({
  ownedPaidAdAccount:async()=>({id:3,provider_account_id:'1234567890',name:'Campaign account',currency:'INR',timezone:'Asia/Kolkata'}),
  resolveGoogleReportingAccount:async()=>({customerId:'1234567890',managerAccountId:'1111111111'}),
}));
jest.unstable_mockModule('../models/campaignPerformanceCache/index.js',()=>({CampaignPerformanceCacheModel:{upsertPerformance:upsert}}));
const {refreshGoogleAdsInventory,googleDailyInsight,negativeKeywordOpportunities,GOOGLE_CAMPAIGN_TYPE_SUPPORT}=await import('../services/ads/GoogleAdsInventoryService.js');
beforeEach(()=>{search.mockReset();upsert.mockClear();});
it('keeps fractional conversions and converts Google micros once',()=>{
  expect(googleDailyInsight({segments:{date:'2026-09-01'},metrics:{costMicros:'2500000',conversions:1.75,conversionsValue:14}})).toMatchObject({spend:2.5,conversions:1.75,conversionValue:14});
});
it('retains zero-delivery campaigns and the verified account currency',async()=>{
  search.mockImplementation(async(_creds,query)=>query.includes('campaign.primary_status')?[{campaign:{id:'7',name:'No delivery',status:'PAUSED',advertisingChannelType:'SEARCH'},campaignBudget:{amountMicros:'50000000'}}]:[]);
  await refreshGoogleAdsInventory(12,3);
  expect(upsert).toHaveBeenCalledTimes(1);
  expect(upsert.mock.calls[0][0]).toMatchObject({name:'No delivery',spend:'0',rawData:{accountIdentity:{adAccountId:'1234567890',currency:'INR'},campaign:{budgetAmount:50,budgetType:'daily'}}});
});
it('does not update cached evidence when any report fails',async()=>{
  search.mockImplementation(async(_creds,query)=>{if(query.includes('FROM ad_group_ad')&&query.includes('segments.date'))throw new Error('later page failed');return [{campaign:{id:'7',name:'Current'}}];});
  await expect(refreshGoogleAdsInventory(12,3)).rejects.toThrow('later page failed');
  expect(upsert).not.toHaveBeenCalled();
});
it('ranks only unconverted search terms that are not already positive keywords',()=>{
  const terms=[
    {searchTermView:{searchTerm:'free crm'},segments:{keyword:{info:{matchType:'BROAD'}}},metrics:{costMicros:'9000000',clicks:8,conversions:0}},
    {searchTermView:{searchTerm:'sales crm'},metrics:{costMicros:'12000000',clicks:4,conversions:0}},
    {searchTermView:{searchTerm:'demo crm'},metrics:{costMicros:'15000000',clicks:3,conversions:1}},
  ];
  const keywords=[{adGroupCriterion:{negative:false,keyword:{text:'sales crm'}}}];
  expect(negativeKeywordOpportunities(terms,keywords)).toEqual([expect.objectContaining({searchTerm:'free crm',spend:9,suggestion:expect.stringContaining('never applied automatically')})]);
});
it('makes campaign-type workflow support explicit',()=>{
  expect(GOOGLE_CAMPAIGN_TYPE_SUPPORT.find(item=>item.type==='SEARCH')).toMatchObject({diagnostics:true,publishing:true});
  expect(GOOGLE_CAMPAIGN_TYPE_SUPPORT.find(item=>item.type==='PERFORMANCE_MAX')).toMatchObject({diagnostics:'limited',publishing:false});
});
