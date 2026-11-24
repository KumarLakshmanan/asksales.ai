import { describe,expect,it,jest,beforeEach } from '@jest/globals';

const list=jest.fn<()=>Promise<Record<string,unknown>[]>>();
const insert=jest.fn<(...args:unknown[])=>Promise<unknown>>();
const update=jest.fn<(...args:unknown[])=>Promise<unknown>>();
jest.unstable_mockModule('../models/apiPricing/functions.js',()=>({
  getAllApiPricing:list,insertApiPricing:insert,updateApiPricing:update,
}));
const {saveVerifiedPricingOverride}=await import('../services/insights/AdminPricingOverrides.js');

describe('audited Insights pricing override input',()=>{
  beforeEach(()=>{list.mockReset();insert.mockReset();update.mockReset();list.mockResolvedValue([]);insert.mockResolvedValue({id:7});});

  it('creates a verified zero-price media override with a documented source',async()=>{
    await saveVerifiedPricingOverride({kind:'image',provider:'gemini',model:'image-test',unitUsd:0,
      resolutionTiers:{'2K':0.04},sourceReference:'admin approved rate card'},1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({category:'image',provider:'gemini',
      metadata:expect.objectContaining({verified:true,model:'image-test',unitUsd:0,resolutionTiers:{'2K':0.04}})}),1);
  });

  it('rejects missing base prices and unsupported model identities',async()=>{
    await expect(saveVerifiedPricingOverride({kind:'image',provider:'gemini',model:'image-test',
      resolutionTiers:{'2K':0.04},sourceReference:'rate card'},1)).rejects.toThrow('Unit rate');
    await expect(saveVerifiedPricingOverride({kind:'image',provider:'gemini',model:'image-test',unitUsd:0,
      resolutionTiers:{'2k':0.04},sourceReference:'rate card'},1)).rejects.toThrow('Resolution tiers');
    await expect(saveVerifiedPricingOverride({kind:'llm',provider:'unknown',model:'model',
      inputUsdPerMillion:1,outputUsdPerMillion:1,sourceReference:'rate card'},1)).rejects.toThrow('supported');
  });

  it('updates the audited pricing row for the exact provider and model',async()=>{
    list.mockResolvedValue([{id:4,category:'llm',provider:'openrouter',metadata:{model:'model-x'}}]);
    await saveVerifiedPricingOverride({kind:'llm',provider:'openrouter',model:'model-x',inputUsdPerMillion:0.1,
      outputUsdPerMillion:0.3,sourceReference:'provider invoice'},1);
    expect(update).toHaveBeenCalledWith(4,expect.objectContaining({isActive:true,
      metadata:expect.objectContaining({verified:true,inputUsdPerMillion:0.1,outputUsdPerMillion:0.3})}),1);
  });
});
