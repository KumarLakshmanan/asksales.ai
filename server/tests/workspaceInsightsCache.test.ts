import { describe, expect, it } from '@jest/globals';
import { insightsCacheKey } from '../services/insights/CacheKey.js';
import type { InsightsQuery } from '../../shared/insights.js';

const query: InsightsQuery = { from:'2026-09-01',to:'2026-09-30',timezone:'Asia/Kolkata',interval:'daily',channel:'all' };

describe('Insights aggregate cache isolation',()=>{
  it('changes with business, billing organization, permissions, and filters',()=>{
    const base={businessProfileId:11,userId:7,actorUserId:7};
    const key=insightsCacheKey(base,23,true,['outreach','billing'],query);
    expect(insightsCacheKey({...base,businessProfileId:12},23,true,['outreach','billing'],query)).not.toBe(key);
    expect(insightsCacheKey(base,24,true,['outreach','billing'],query)).not.toBe(key);
    expect(insightsCacheKey(base,23,false,['outreach','billing'],query)).not.toBe(key);
    expect(insightsCacheKey(base,23,true,['outreach'],query)).not.toBe(key);
    expect(insightsCacheKey(base,23,true,['outreach','billing'],{...query,channel:'whatsapp'})).not.toBe(key);
    expect(insightsCacheKey(base,23,true,['billing','outreach'],query)).toBe(key);
  });
});
