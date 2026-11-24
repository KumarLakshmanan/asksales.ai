import { createHash } from 'node:crypto';
import { getAllApiPricing,insertApiPricing,updateApiPricing } from '../../models/apiPricing/functions.js';

type Kind='llm'|'embedding'|'image'|'video';
const allowed:Record<Kind,string[]>={
  llm:['openai','openrouter','gemini','vertex_ai','custom_ai'],
  embedding:['openai','openrouter','gemini'],
  image:['gemini','openrouter'],video:['gemini','openrouter'],
};
const allowedMediaTiers={image:new Set(['512px','1K','2K','4K']),
  video:new Set(['720p_1080p','1080p','4K'])};
function price(value:unknown,label:string):number{
  const number=Number(value);
  if(value===null||value===undefined||!Number.isFinite(number)||number<0||number>1_000_000)
    throw new Error(`${label} must be a nonnegative USD amount.`);
  return number;
}
/** Superadmin-only API uses the existing pricing rows and audit transactions. */
export async function saveVerifiedPricingOverride(input:unknown,adminId:number){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('A pricing override is required.');
  const body=input as Record<string,unknown>;
  const kind=body.kind as Kind,provider=String(body.provider||''),model=String(body.model||'').trim();
  const sourceReference=String(body.sourceReference||'').trim();
  if(!allowed[kind]?.includes(provider)||!model||model.length>120||!/^[\w./:@-]+$/.test(model))
    throw new Error('Choose a supported provider, kind, and exact model ID.');
  if(!sourceReference||sourceReference.length>500)throw new Error('A pricing source reference is required.');
  const metadata:Record<string,unknown>={verified:true,model,sourceReference};
  if(kind==='llm'||kind==='embedding'){
    metadata.inputUsdPerMillion=price(body.inputUsdPerMillion,'Input rate');
    metadata.outputUsdPerMillion=kind==='embedding'?0:price(body.outputUsdPerMillion,'Output rate');
    if(body.cachedInputUsdPerMillion!==undefined)metadata.cachedInputUsdPerMillion=price(body.cachedInputUsdPerMillion,'Cached input rate');
    if(body.audioInputUsdPerMillion!==undefined)metadata.audioInputUsdPerMillion=price(body.audioInputUsdPerMillion,'Audio input rate');
  }else{
    metadata.unitUsd=price(body.unitUsd,'Unit rate');
    if(body.resolutionTiers!==undefined){
      if(!body.resolutionTiers||typeof body.resolutionTiers!=='object'||Array.isArray(body.resolutionTiers))
        throw new Error('Resolution tiers must be an object.');
      const entries=Object.entries(body.resolutionTiers as Record<string,unknown>);
      if(entries.length>20||entries.some(([tier])=>!allowedMediaTiers[kind].has(tier)))
        throw new Error('Resolution tiers are invalid for the selected media kind.');
      metadata.resolutionTiers=Object.fromEntries(entries.map(([tier,value])=>[tier,price(value,`${tier} rate`)]));
    }
  }
  const existing=(await getAllApiPricing()).find(entry=>entry.category===kind&&entry.provider===provider&&entry.metadata?.model===model);
  if(existing)return updateApiPricing(existing.id,{metadata,isActive:true},adminId);
  const digest=createHash('sha256').update(`${kind}:${provider}:${model}`).digest('hex').slice(0,32);
  return insertApiPricing({category:kind,provider,pricingKey:`insights_override:${kind}:${digest}`,
    name:`Verified ${provider}/${model}`.slice(0,255),metadata,isActive:true},adminId);
}
