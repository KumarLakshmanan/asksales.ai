import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const execute=jest.fn<(...args:unknown[])=>Promise<{rows:Record<string,unknown>[]}>>();
jest.unstable_mockModule('../models/db.js',()=>({db:{execute}}));
const {getInsightsRuntime,clearInsightsRuntimeCache}=await import('../services/insights/RuntimeService.js');

describe('Insights runtime PostgreSQL error classification',()=>{
  beforeEach(()=>{execute.mockReset();clearInsightsRuntimeCache();});
  it.each(['direct','wrapped'])('disables only a missing relation with a %s driver error',async shape=>{
    const driver=Object.assign(new Error('Synthetic missing relation'),{code:'42P01'});
    execute.mockRejectedValue(shape==='direct'?driver:new Error('Synthetic Drizzle wrapper',{cause:driver}));
    await expect(getInsightsRuntime()).resolves.toEqual({enabled:false,pricingGuardEnabled:false,instrumentationStartedAt:null});
  });
  it.each(['42703','42501','08006'])('propagates wrapped PostgreSQL %s errors',async code=>{
    const wrapped=new Error('Synthetic Drizzle wrapper',{cause:Object.assign(new Error('Synthetic database error'),{code})});
    execute.mockRejectedValue(wrapped);
    await expect(getInsightsRuntime()).rejects.toBe(wrapped);
  });
});
