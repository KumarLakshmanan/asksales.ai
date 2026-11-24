import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { CampaignPerformanceCacheModel } from '../../models/campaignPerformanceCache/index.js';
import { ownedPaidAdAccount, resolveGoogleReportingAccount } from './PaidAdAccountsService.js';
import { searchGoogleAds } from './GoogleAdsService.js';
import { aggregateProviderReportingWindow, providerReportingWindow } from './ProviderReportingWindow.js';

type Row = Record<string, any>;
const metricFields = 'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value';
export function googleDailyInsight(row: Row) {
  return {date:row.segments?.date,impressions:Number(row.metrics?.impressions || 0),clicks:Number(row.metrics?.clicks || 0),
    spend:Number(row.metrics?.costMicros || 0)/1_000_000,conversions:Number(row.metrics?.conversions || 0),conversionValue:Number(row.metrics?.conversionsValue || 0)};
}
/** Snapshot every page before updating the cache. Zero-delivery inventory remains visible. */
export async function refreshGoogleAdsInventory(userId:number, accountId:number) {
  const account = await ownedPaidAdAccount(userId,accountId);
  const creds = await resolveGoogleReportingAccount(userId,accountId);
  const window = providerReportingWindow('last_90d');
  const dateFilter = `segments.date BETWEEN '${window.start}' AND '${window.end}'`;
  const [campaigns,groups,ads,campaignDays,groupDays,adDays] = await Promise.all([
    searchGoogleAds<Row>(creds,'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.primary_status, campaign.primary_status_reasons, campaign.bidding_strategy_type, campaign.start_date, campaign.end_date, campaign_budget.amount_micros, campaign_budget.total_amount_micros FROM campaign WHERE campaign.status != \'REMOVED\''),
    searchGoogleAds<Row>(creds,'SELECT campaign.id, ad_group.id, ad_group.resource_name, ad_group.name, ad_group.status FROM ad_group WHERE campaign.status != \'REMOVED\' AND ad_group.status != \'REMOVED\''),
    searchGoogleAds<Row>(creds,'SELECT campaign.id, ad_group.id, ad_group_ad.resource_name, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status FROM ad_group_ad WHERE campaign.status != \'REMOVED\' AND ad_group_ad.status != \'REMOVED\''),
    searchGoogleAds<Row>(creds,`SELECT campaign.id, segments.date, ${metricFields} FROM campaign WHERE ${dateFilter}`),
    searchGoogleAds<Row>(creds,`SELECT ad_group.id, segments.date, ${metricFields} FROM ad_group WHERE ${dateFilter}`),
    searchGoogleAds<Row>(creds,`SELECT ad_group.id, ad_group_ad.ad.id, segments.date, ${metricFields} FROM ad_group_ad WHERE ${dateFilter}`),
  ]);
  for (const [rows, entity] of [[campaigns,(row:Row)=>row.campaign],[groups,(row:Row)=>row.adGroup],[ads,(row:Row)=>row.adGroupAd?.ad]] as const) {
    if(rows.some(row=>!/^\d+$/.test(String(entity(row)?.id || '')))) throw new Error('Google returned an incomplete campaign hierarchy. Previous evidence was retained.');
  }
  for(const rows of [campaignDays,groupDays,adDays]) {
    if(rows.some(row=>!/^\d{4}-\d{2}-\d{2}$/.test(String(row.segments?.date || '')))) throw new Error('Google returned an incomplete daily report. Previous evidence was retained.');
  }
  const accountIdentity = {adAccountId:account.provider_account_id,adAccountName:account.name,currency:account.currency,timezone:account.timezone,registryId:accountId};
  const cache = async (rows:Row[],days:Row[],type:'campaign'|'adset'|'ad',getEntity:(row:Row)=>Row,getParent:(row:Row)=>string|null) => {
    const daily = new Map<string,ReturnType<typeof googleDailyInsight>[]>();
    for(const row of days) { const id=String(getEntity(row).id); daily.set(id,[...(daily.get(id)||[]),googleDailyInsight(row)]); }
    for(const row of rows) {
      const entity=getEntity(row); const id=String(entity.id); const dailyInsights=daily.get(id)||[];
      const totals=aggregateProviderReportingWindow({dailyInsights},window.start,window.end);
      const budget=Number(row.campaignBudget?.totalAmountMicros || row.campaignBudget?.amountMicros || 0)/1_000_000;
      await CampaignPerformanceCacheModel.upsertPerformance({userId,platform:'google',entityType:type,platformEntityId:id,
        parentEntityId:getParent(row),name:entity.name || `${type === 'ad' ? 'Ad' : 'Ad group'} ${id}`,
        status:String((type==='ad'?row.adGroupAd.status:entity.status)||'unknown').toLowerCase().replace('enabled','active'),
        impressions:totals.impressions,clicks:totals.clicks,spend:String(totals.spend),reach:0,ctr:String(totals.ctr),cpc:String(totals.cpc),cpm:String(totals.cpm),
        conversions:totals.conversions,conversionValue:String(totals.conversionValue),
        rawData:{accountIdentity,providerResource:type==='campaign'?`customers/${account.provider_account_id}/campaigns/${id}`:type==='adset'?`customers/${account.provider_account_id}/adGroups/${id}`:`customers/${account.provider_account_id}/adGroupAds/${id}`,...row,campaign:{...row.campaign,objective:'conversions',budgetAmount:budget,budgetType:row.campaignBudget?.totalAmountMicros?'lifetime':'daily'},
          reportingWindow:window,dailyInsights,insights:totals,coverage:{complete:true,reach:'unavailable',leads:'conversion_action_mapping_required'}},
      });
    }
  };
  await cache(campaigns,campaignDays,'campaign',row=>row.campaign,()=>null);
  await cache(groups,groupDays,'adset',row=>row.adGroup,row=>String(row.campaign.id));
  await cache(ads,adDays,'ad',row=>({...row.adGroupAd.ad,id:`${row.adGroup.id}~${row.adGroupAd.ad.id}`}),row=>String(row.adGroup.id));
  await db.execute(sql`UPDATE paid_ad_accounts SET last_succeeded_at=NOW(),data_available_through=${window.end}::date,error_code=NULL WHERE user_id=${userId} AND id=${accountId}`);
  return {cachedCampaigns:campaigns.length,cachedAdsets:groups.length,cachedAds:ads.length,dataAvailableThrough:window.end};
}

export const GOOGLE_CAMPAIGN_TYPE_SUPPORT = [
  { type: 'SEARCH', reporting: true, diagnostics: true, publishing: true, workflow: 'Search terms, keywords, responsive search ads, landing pages, bidding, and budgets' },
  { type: 'PERFORMANCE_MAX', reporting: true, diagnostics: 'limited', publishing: false, workflow: 'Campaign reporting and status; asset-group editing stays in Google Ads' },
  { type: 'SHOPPING', reporting: true, diagnostics: 'limited', publishing: false, workflow: 'Campaign reporting and status; Merchant Center product diagnostics stay in Google' },
  { type: 'DISPLAY', reporting: true, diagnostics: 'limited', publishing: false, workflow: 'Campaign, ad-group, and ad reporting; creative editing stays in Google Ads' },
  { type: 'VIDEO', reporting: true, diagnostics: 'limited', publishing: false, workflow: 'Campaign, ad-group, and ad reporting; video creative editing stays in Google Ads' },
] as const;

export function negativeKeywordOpportunities(searchTerms:Row[], keywords:Row[]) {
  const existing = new Set(keywords.filter(row=>!row.adGroupCriterion?.negative).map(row=>String(row.adGroupCriterion?.keyword?.text || '').trim().toLowerCase()).filter(Boolean));
  return searchTerms.map(row=>({
    searchTerm:String(row.searchTermView?.searchTerm || ''),
    status:String(row.searchTermView?.status || 'UNKNOWN'),
    matchType:String(row.segments?.keyword?.info?.matchType || 'UNKNOWN'),
    impressions:Number(row.metrics?.impressions || 0),clicks:Number(row.metrics?.clicks || 0),
    spend:Number(row.metrics?.costMicros || 0)/1_000_000,conversions:Number(row.metrics?.conversions || 0),
  })).filter(row=>row.searchTerm && row.spend>0 && row.conversions===0 && !existing.has(row.searchTerm.toLowerCase()))
    .sort((a,b)=>b.spend-a.spend).slice(0,100).map(row=>({...row,suggestion:'Review as a negative keyword; suggestions are never applied automatically.'}));
}

/** Read-only, fully paginated Google diagnostics for one owned customer and campaign. */
export async function googleAdsCampaignDiagnostics(userId:number,accountId:number,campaignId:string) {
  if(!/^\d+$/.test(campaignId)) throw new Error('Google campaign not found.');
  const account=await ownedPaidAdAccount(userId,accountId);
  if(account.platform!=='google' || account.is_manager) throw new Error('Select a Google Ads customer account.');
  const creds=await resolveGoogleReportingAccount(userId,accountId);
  const id=campaignId;
  const [campaigns,searchTerms,keywords,ads,assets,conversionActions,landingPages]=await Promise.all([
    searchGoogleAds<Row>(creds,`SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.primary_status_reasons, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.bidding_strategy_type, campaign.optimization_score, campaign.start_date, campaign.end_date, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.status, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE campaign.id = ${id}`),
    searchGoogleAds<Row>(creds,`SELECT ad_group.id, ad_group.name, search_term_view.search_term, search_term_view.status, segments.keyword.info.text, segments.keyword.info.match_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE campaign.id = ${id} AND segments.date DURING LAST_30_DAYS`),
    searchGoogleAds<Row>(creds,`SELECT ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM keyword_view WHERE campaign.id = ${id} AND segments.date DURING LAST_30_DAYS`),
    searchGoogleAds<Row>(creds,`SELECT ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM ad_group_ad WHERE campaign.id = ${id} AND ad_group_ad.status != 'REMOVED'`),
    searchGoogleAds<Row>(creds,`SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.performance_label, ad_group_ad_asset_view.enabled, asset.id, asset.name, asset.type, asset.text_asset.text, asset.policy_summary.approval_status, asset.policy_summary.policy_topic_entries FROM ad_group_ad_asset_view WHERE campaign.id = ${id}`),
    searchGoogleAds<Row>(creds,'SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric, conversion_action.owner_customer FROM conversion_action WHERE conversion_action.status != \'REMOVED\''),
    searchGoogleAds<Row>(creds,`SELECT expanded_landing_page_view.expanded_final_url, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM expanded_landing_page_view WHERE campaign.id = ${id} AND segments.date DURING LAST_30_DAYS`),
  ]);
  if(!campaigns[0]) throw new Error('Google campaign not found.');
  const campaign=campaigns[0];
  const type=String(campaign.campaign?.advertisingChannelType || 'UNKNOWN');
  const support=GOOGLE_CAMPAIGN_TYPE_SUPPORT.find(item=>item.type===type) || {type,reporting:true,diagnostics:'limited',publishing:false,workflow:'Campaign reporting only; make type-specific edits in Google Ads'};
  return {account:{id:account.id,name:account.name,customerId:account.provider_account_id,currency:account.currency,timezone:account.timezone},campaign,support,
    searchTerms,keywords,negativeKeywordOpportunities:negativeKeywordOpportunities(searchTerms,keywords),ads,assets,conversionActions,landingPages,
    completeness:{paginated:true,searchTerms:searchTerms.length,keywords:keywords.length,ads:ads.length,assets:assets.length,conversionActions:conversionActions.length,landingPages:landingPages.length},
    limitations:['Search-term and keyword metrics use the last 30 days. Suggested negatives require human review and are never applied automatically.','Conversion actions describe account configuration; confirm which primary actions represent qualified leads or purchases before changing bids.']};
}

export async function managedGoogleAdsCampaignDiagnostics(userId:number,campaignId:number) {
  const result=await db.execute(sql`SELECT ad_platform,ad_account_id,platform_campaign_id FROM performance_ad_campaigns WHERE user_id=${userId} AND id=${campaignId}`);
  const campaign=result.rows[0];
  if(!campaign || campaign.ad_platform!=='google' || !campaign.platform_campaign_id) throw new Error('Google campaign not found.');
  const providerAccountId=String(campaign.ad_account_id || '').replaceAll('-','');
  const account=await db.execute(sql`SELECT id FROM paid_ad_accounts WHERE user_id=${userId} AND platform='google' AND provider_account_id=${providerAccountId} AND is_active=TRUE LIMIT 1`);
  if(!account.rows[0]) throw new Error('Refresh connected Google Ads accounts before loading diagnostics.');
  return googleAdsCampaignDiagnostics(userId,Number(account.rows[0].id),String(campaign.platform_campaign_id));
}
