import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
export type RecommendationStatus = 'open'|'accepted'|'dismissed'|'snoozed'|'implemented'|'outcome_measured';
export interface RecommendationUpdate {dismissReason?:string;snoozedUntil?:string;implementationNote?:string}
interface ObservedMetrics {
  start: string; end: string; measuredDays: number; refreshedAt: string | null; spend: number; leads: number | null;
  conversions: number; impressions: number; clicks: number; cpl: number | null; cpa: number | null; ctr: number | null; roas: number | null;
}
interface StoredRecommendation {
  status: string; campaign_id: unknown; platform: unknown; target_type: unknown; target_key: unknown;
  implemented_at?: unknown; implementation_baseline?: ObservedMetrics | null; outcome?: Record<string, unknown> | null;
}
const transitions:Record<string,RecommendationStatus[]>={
  open:['accepted','dismissed','snoozed'],accepted:['open','dismissed','snoozed','implemented'],
  dismissed:['open','accepted','snoozed'],snoozed:['open','accepted','dismissed'],implemented:['outcome_measured'],outcome_measured:[],
};
export function validateRecommendationTransition(from:string,to:RecommendationStatus,input:RecommendationUpdate,now=new Date()) {
  if(from===to)return;
  if(!transitions[from]?.includes(to))throw new Error('This recommendation cannot move to that status. Refresh its current state.');
  if(to==='dismissed' && !input.dismissReason?.trim())throw new Error('Choose a dismissal reason.');
  if(to==='snoozed') {
    const until=new Date(input.snoozedUntil || '');
    if(!Number.isFinite(until.getTime()) || until<=now || until.getTime()>now.getTime()+90*86400000)throw new Error('Choose a snooze date within the next 90 days.');
  }
  if(to==='implemented' && !input.implementationNote?.trim())throw new Error('Describe the change you implemented.');
}
const day=(date:Date)=>date.toISOString().slice(0,10);
export function recommendationOutcomeWindows(implementedAt:Date) {
  const date=new Date(implementedAt);date.setUTCHours(0,0,0,0);
  const beforeStart=new Date(date.getTime()-7*86400000),beforeEnd=new Date(date.getTime()-86400000);
  const afterStart=new Date(date.getTime()+86400000),afterEnd=new Date(date.getTime()+7*86400000);
  return {before:{start:day(beforeStart),end:day(beforeEnd)},after:{start:day(afterStart),end:day(afterEnd)},availableAfter:new Date(afterEnd.getTime()+86400000).toISOString()};
}
async function observedMetrics(tx:typeof db,userId:number,rec:StoredRecommendation,window:{start:string;end:string}):Promise<ObservedMetrics> {
  const campaign=rec.target_type==='campaign';
  const result=await tx.execute(campaign?sql`
    SELECT COUNT(DISTINCT date)::int AS measured_days,MAX(updated_at) AS refreshed_at,
      SUM(impressions) AS impressions,SUM(clicks) AS clicks,SUM(spend) AS spend,
      SUM(conversions) AS conversions,SUM(conversion_value) AS conversion_value,
      CASE WHEN COUNT(platform_data->>'leads')=COUNT(*) THEN SUM(leads) END AS leads
    FROM performance_metrics WHERE user_id=${userId} AND campaign_id=${Number(rec.campaign_id)} AND platform=${String(rec.platform)}
      AND hour IS NULL AND date BETWEEN ${window.start}::date AND ${window.end}::date
  `:sql`
    SELECT COUNT(DISTINCT date)::int AS measured_days,MAX(updated_at) AS refreshed_at,
      SUM(impressions) AS impressions,SUM(clicks) AS clicks,SUM(spend) AS spend,
      SUM(conversions) AS conversions,SUM(conversion_value) AS conversion_value,
      CASE WHEN COUNT(provider_payload->>'leads')=COUNT(*) THEN SUM((provider_payload->>'leads')::numeric) END AS leads
    FROM ad_unit_metrics WHERE user_id=${userId} AND campaign_id=${Number(rec.campaign_id)} AND platform=${String(rec.platform)}
      AND target_type=${String(rec.target_type)} AND target_key=${String(rec.target_key)}
      AND COALESCE(provider_payload->>'importedFromProviderCache','false')<>'true'
      AND date BETWEEN ${window.start}::date AND ${window.end}::date
  `);
  const row=result.rows[0] || {};
  const spend=Number(row.spend || 0),leads=row.leads==null?null:Number(row.leads),conversions=Number(row.conversions || 0),impressions=Number(row.impressions||0),clicks=Number(row.clicks||0);
  return {...window,measuredDays:Number(row.measured_days || 0),refreshedAt:row.refreshed_at ? new Date(String(row.refreshed_at)).toISOString() : null,spend,leads,conversions,impressions,clicks,
    cpl:leads && leads>0?spend/leads:null,cpa:conversions>0?spend/conversions:null,ctr:impressions>0?100*clicks/impressions:null,
    roas:spend>0?Number(row.conversion_value||0)/spend:null};
}
export async function updateRecommendationLifecycle(userId:number,campaignId:number,id:number,status:RecommendationStatus,input:RecommendationUpdate={}) {
  return db.transaction(async(tx:typeof db)=>{
    const found=await tx.execute(sql`SELECT * FROM ad_recommendations WHERE id=${id} AND user_id=${userId} AND campaign_id=${campaignId} FOR UPDATE`);
    const rec=found.rows[0] as StoredRecommendation | undefined;
    if(!rec || rec.status==='superseded')throw new Error('Recommendation not found.');
    validateRecommendationTransition(rec.status,status,input);
    if(rec.status===status)return rec;
    let baseline=rec.implementation_baseline, outcome=rec.outcome;
    if(status==='implemented') baseline=await observedMetrics(tx,userId,rec,recommendationOutcomeWindows(new Date()).before);
    if(status==='outcome_measured') {
      const windows=recommendationOutcomeWindows(new Date(String(rec.implemented_at)));
      if(new Date()<new Date(windows.availableAfter))throw new Error(`Outcome measurement is available after ${windows.availableAfter.slice(0,10)}.`);
      const after=await observedMetrics(tx,userId,rec,windows.after);
      if(!baseline || baseline.measuredDays<3 || after.measuredDays<3 || !after.refreshedAt || new Date(after.refreshedAt)<new Date(windows.availableAfter))throw new Error('At least three measured days in both seven-day windows and a completed follow-up sync are required.');
      const comparisonMetrics:Array<'cpl'|'cpa'|'ctr'|'roas'>=['cpl','cpa','ctr','roas'];
      outcome={before:baseline,after,comparison:'matched_7_day_windows',causalClaim:false,
        note:'Observed before/after performance. Other campaign, audience, budget, and seasonal changes may explain differences.',
        changes:Object.fromEntries(comparisonMetrics.map(key=>[key,baseline[key]!=null && Number(baseline[key])>0 && after[key]!=null ? (Number(after[key])/Number(baseline[key])-1)*100:null]))};
    }
    const updated=await tx.execute(sql`UPDATE ad_recommendations SET status=${status},updated_at=NOW(),
      dismiss_reason=CASE WHEN ${status}='dismissed' THEN ${input.dismissReason?.trim() || null} ELSE dismiss_reason END,
      snoozed_until=${status==='snoozed'?input.snoozedUntil!:null}::timestamptz,
      accepted_evidence=CASE WHEN ${status}='accepted' THEN COALESCE(accepted_evidence,evidence) ELSE accepted_evidence END,
      implemented_at=CASE WHEN ${status}='implemented' THEN NOW() ELSE implemented_at END,
      implementation_note=CASE WHEN ${status}='implemented' THEN ${input.implementationNote?.trim() || null} ELSE implementation_note END,
      implementation_baseline=${baseline?JSON.stringify(baseline):null}::jsonb,
      outcome=${outcome?JSON.stringify(outcome):null}::jsonb,
      outcome_measured_at=CASE WHEN ${status}='outcome_measured' THEN NOW() ELSE outcome_measured_at END
      WHERE id=${id} AND user_id=${userId} AND campaign_id=${campaignId} RETURNING *`);
    await tx.execute(sql`INSERT INTO ad_recommendation_events(recommendation_id,campaign_id,user_id,actor_type,from_status,to_status,note,evidence)
      VALUES(${id},${campaignId},${userId},'user',${String(rec.status)},${status},${input.dismissReason || input.implementationNote || null},${JSON.stringify(status==='outcome_measured'?outcome || {}:status==='implemented'?baseline || {}:{snoozedUntil:input.snoozedUntil || null})}::jsonb)`);
    return updated.rows[0];
  });
}
export async function wakeSnoozedRecommendations(userId:number,campaignId:number) {
  await db.execute(sql`WITH due AS (
    UPDATE ad_recommendations SET status='open',snoozed_until=NULL,updated_at=NOW()
      WHERE user_id=${userId} AND campaign_id=${campaignId} AND status='snoozed' AND snoozed_until<=NOW() RETURNING id
  ) INSERT INTO ad_recommendation_events(recommendation_id,campaign_id,user_id,actor_type,from_status,to_status,note)
    SELECT id,${campaignId},${userId},'system','snoozed','open','Snooze period ended' FROM due`);
}
