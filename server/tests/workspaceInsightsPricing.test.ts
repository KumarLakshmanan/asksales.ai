import { describe, expect, it, jest, beforeEach } from '@jest/globals';

let configured: Record<string, unknown>[]=[];
let context: { provider: string; pricing?: unknown; cachedTokens?: number; inputAudioTokens?: number } | undefined;
jest.unstable_mockModule('../models/apiPricing/functions.js',()=>({
  getAllApiPricing:async()=>configured,
  getApiPricingByKey:async()=>({isActive:true,marginPercentage:0}),
}));
jest.unstable_mockModule('../services/GenAIPricingService.js',()=>({getModelPrice:()=>null}));
jest.unstable_mockModule('../models/creditPricing/functions.js',()=>({getRechargeRate:async()=>2,getUsageRate:async()=>2}));
jest.unstable_mockModule('../utils/currency.js',()=>({getUsdToInrRate:()=>90}));
jest.unstable_mockModule('../services/insights/UsageContext.js',()=>({currentUsageContext:()=>context}));
jest.unstable_mockModule('../services/insights/RuntimeService.js',()=>({getInsightsRuntime:async()=>({pricingGuardEnabled:true})}));
const { llmPricingSnapshot,calculateMeteredLLMCost,PricingUnavailableError,embeddingPricingSnapshot,assertMediaPrice }=
  await import('../services/insights/PricingService.js');

describe('verified usage pricing',()=>{
  beforeEach(()=>{configured=[];context=undefined;});

  it('fails before an unpriced provider request can be metered',async()=>{
    await expect(llmPricingSnapshot('unlisted-model','openrouter')).rejects.toBeInstanceOf(PricingUnavailableError);
    await expect(embeddingPricingSnapshot('unknown-embedding','gemini')).rejects.toBeInstanceOf(PricingUnavailableError);
    await expect(assertMediaPrice('unknown-image','gemini','image')).rejects.toBeInstanceOf(PricingUnavailableError);
  });

  it('retains sub-cent precision and an explicit zero margin with a verified override',async()=>{
    configured=[{id:42,isActive:true,category:'llm',provider:'openai',pricingKey:'llm_model:test-model',updatedAt:new Date('2026-09-01'),
      metadata:{verified:true,model:'test-model',inputUsdPerMillion:0.001,outputUsdPerMillion:0.002}}];
    const snapshot=await llmPricingSnapshot('test-model','openai');
    expect(snapshot).toMatchObject({source:'admin_override',marginPercentage:0,creditsPerInr:2,minimumCredits:1,rounding:'ceil_whole'});
    context={provider:'openai',pricing:snapshot};
    const cents=await calculateMeteredLLMCost('test-model',{promptTokens:1000,completionTokens:0});
    expect(cents).toBeCloseTo(0.0001,9);
  });

  it('does not reuse an embedding rate for a text request or a changed audio rate after the snapshot',async()=>{
    configured=[{id:51,isActive:true,category:'embedding',provider:'openai',pricingKey:'embedding:test-model',updatedAt:new Date('2026-09-01'),
      metadata:{verified:true,model:'test-model',inputUsdPerMillion:1,outputUsdPerMillion:0}}];
    await expect(llmPricingSnapshot('test-model','openai')).rejects.toBeInstanceOf(PricingUnavailableError);
    const embedding=await embeddingPricingSnapshot('test-model','openai');
    expect(embedding?.inputUsdPerMillion).toBe(1);

    configured=[{id:52,isActive:true,category:'llm',provider:'openai',pricingKey:'llm:test-model',updatedAt:new Date('2026-09-01'),
      metadata:{verified:true,model:'test-model',inputUsdPerMillion:1,outputUsdPerMillion:2,audioInputUsdPerMillion:3}}];
    const snapshot=await llmPricingSnapshot('test-model','openai');
    configured=[];
    context={provider:'openai',pricing:snapshot,inputAudioTokens:1000};
    expect(await calculateMeteredLLMCost('test-model',{promptTokens:1000,completionTokens:0})).toBeCloseTo(0.3,8);
  });
});
