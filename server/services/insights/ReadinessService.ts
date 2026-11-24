import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { withSystemScope } from '../../tenancy/businessContext.js';
import { getAllApiPricing } from '../../models/apiPricing/functions.js';
import { resolveVerifiedModelRate } from './PricingService.js';
import { getInsightsRuntime } from './RuntimeService.js';
import { DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_OPENROUTER_MODEL, DEFAULT_VERTEX_MODEL } from '../../utils/llmConstants.js';

interface ActiveModel { provider:string; model:string; kind:'text'|'embedding'|'image'|'video'; origin:string }
const defaults:Record<string,string>={openai:DEFAULT_OPENAI_MODEL,openrouter:DEFAULT_OPENROUTER_MODEL,
  gemini:DEFAULT_GEMINI_MODEL,vertex_ai:DEFAULT_VERTEX_MODEL};
const verifiedUnit=(value:unknown)=>value!==null&&value!==undefined&&Number.isFinite(Number(value))&&Number(value)>=0;
const normalizeProvider=(value:unknown)=>String(value||'').toLowerCase()==='google'?'gemini':String(value||'').toLowerCase();

export async function getInsightsReadiness(){
  const runtime=await getInsightsRuntime();
  const credentials=(await db.execute(sql`SELECT platform,config->>'model' AS model FROM admin_api_credentials
    WHERE is_active=true AND platform IN ('openai','openrouter','gemini','vertex_ai','custom_ai','openai_embedding','gemini_embedding','openrouter_embedding','gemini_image','gemini_video','openrouter_image','openrouter_video')
    UNION ALL SELECT platform,CASE platform
      WHEN 'openrouter' THEN COALESCE(NULLIF(config->>'aiVisibilityExtractionModel',''),'openai/gpt-4.1-mini')
      WHEN 'openai' THEN COALESCE(NULLIF(config->>'extractionModel',''),NULLIF(config->>'model',''),'gpt-4.1-mini')
      WHEN 'gemini' THEN COALESCE(NULLIF(config->>'extractionModel',''),NULLIF(config->>'model',''),'gemini-2.5-flash') END
      FROM admin_api_credentials WHERE is_active=true AND platform IN ('openai','openrouter','gemini')
    UNION ALL SELECT platform,config->>'model' FROM intent_classifier_credentials WHERE is_active=true
      AND platform IN ('openai','openrouter','gemini','vertex_ai','custom_ai')`)).rows;
  const embedding=(await db.execute(sql`SELECT default_provider,default_model FROM embedding_settings ORDER BY updated_at DESC LIMIT 1`)).rows[0];
  const businessSettings=(await withSystemScope('Inventory configured business AI models before pricing rollout',()=>db.execute(sql`
    SELECT ai_provider,ai_model,image_provider,image_model,video_provider,video_model FROM ai_settings`))).rows;
  const candidates:ActiveModel[]=[];
  for(const row of credentials){const platform=String(row.platform),model=String(row.model||defaults[platform]||'');
    const kind=platform.endsWith('_embedding')?'embedding':platform.endsWith('_image')?'image':platform.endsWith('_video')?'video':'text';
    const provider=normalizeProvider(platform.replace(/_(embedding|image|video)$/,''));
    if(model)candidates.push({provider,model,kind,origin:'active_credential'});
    else candidates.push({provider,model:'(unconfigured)',kind,origin:'active_credential'});
  }
  if(embedding?.default_model)candidates.push({provider:normalizeProvider(embedding.default_provider),model:String(embedding.default_model),kind:'embedding',origin:'default_embedding'});
  for(const row of businessSettings){
    if(row.ai_model)candidates.push({provider:normalizeProvider(row.ai_provider),model:String(row.ai_model),kind:'text',origin:'business_settings'});
    if(row.image_model)candidates.push({provider:normalizeProvider(row.image_provider),model:String(row.image_model),kind:'image',origin:'business_settings'});
    if(row.video_model)candidates.push({provider:normalizeProvider(row.video_provider),model:String(row.video_model),kind:'video',origin:'business_settings'});
  }
  const recent=(await withSystemScope('Inventory recent AI model identifiers before pricing rollout',()=>db.execute(sql`
    SELECT DISTINCT provider,model,kind FROM ai_usage_events WHERE occurred_at>=now()-interval '30 days' AND model IS NOT NULL
      AND kind IN ('text','embedding','image','video')`))).rows;
  for(const row of recent)candidates.push({provider:normalizeProvider(row.provider),model:String(row.model),kind:row.kind as ActiveModel['kind'],origin:'recent_usage'});
  const unique=new Map<string,ActiveModel>();
  for(const item of candidates)unique.set(`${item.provider}:${item.model}:${item.kind}`,item);
  const pricing=await getAllApiPricing();
  const models=await Promise.all([...unique.values()].map(async item=>{
    const media=['image','video'].includes(item.kind);
    const override=media&&pricing.some(entry=>entry.isActive&&entry.category===item.kind&&entry.provider===item.provider
      && entry.metadata?.model===item.model&&entry.metadata?.verified===true
      && verifiedUnit(entry.metadata?.unitUsd));
    const rate=!media&&item.model!=='(unconfigured)'?await resolveVerifiedModelRate(item.model,item.provider,item.kind==='embedding'?'embedding':'text'):null;
    return {...item,priced:Boolean(override||rate),source:override?'admin_override':rate?.source||null};
  }));
  const ledger=(await withSystemScope('Reconcile business-scoped wallet usage for Insights rollout',()=>db.execute(sql`
    SELECT COUNT(*)::integer AS rows,COALESCE(SUM(CASE WHEN type='deduction' THEN -amount WHEN type='refund' AND metadata ? 'originalTransactionId' THEN -amount ELSE 0 END),0) AS credits,
      COUNT(*) FILTER(WHERE type='deduction' AND (metadata->'_insights'->'pricing'->>'creditsPerInr') IS NULL)::integer AS missing_rate
    FROM wallet_transactions WHERE billing_business_profile_id IS NOT NULL AND type IN ('deduction','refund')`))).rows[0];
  const byProcess=(await withSystemScope('Reconcile all charge breakdown buckets for Insights rollout',()=>db.execute(sql`
    SELECT COALESCE(metadata->'_insights'->>'process',category,'unattributed') AS process,
      COALESCE(SUM(CASE WHEN type='deduction' THEN -amount WHEN type='refund' AND metadata ? 'originalTransactionId' THEN -amount ELSE 0 END),0) AS credits
    FROM wallet_transactions WHERE billing_business_profile_id IS NOT NULL AND type IN ('deduction','refund')
    GROUP BY 1`))).rows as Array<{ process: string; credits: string }>;
  const ledgerCents=Math.round(Number(ledger?.credits||0)*100);
  const breakdownCents=Math.round(byProcess.reduce((sum,row)=>sum+Number(row.credits||0),0)*100);
  return {runtime,models,unpriced:models.filter(model=>!model.priced),reconciliation:{ledgerCredits:String(ledger?.credits||'0'),
    breakdownCredits:(breakdownCents/100).toFixed(2),differenceCredits:((ledgerCents-breakdownCents)/100).toFixed(2),
    missingHistoricalRates:Number(ledger?.missing_rate||0),ledgerRows:Number(ledger?.rows||0)},
    ready:models.every(model=>model.priced)&&ledgerCents===breakdownCents};
}
