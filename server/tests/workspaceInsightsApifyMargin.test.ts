import { describe, expect, it, jest } from '@jest/globals';

let records: Array<Record<string, unknown>> = [];
jest.unstable_mockModule('../models/db.js',()=>({db:{select:()=>({from:()=>({orderBy:async()=>records})})}}));
jest.unstable_mockModule('../services/GenAIPricingService.js',()=>({getModelPrice:()=>null,clearPricingCaches:()=>undefined}));
jest.unstable_mockModule('../models/adminNotifications/functions.js',()=>({notifyAllAdmins:async()=>undefined}));
const { getApifyMarginPercentage,getImageCostWithMarginUSD,getVideoCostWithMarginUSD,invalidatePricingCache }=
  await import('../models/apiPricing/functions.js');

describe('Apify margin configuration',()=>{
  it('preserves an explicit zero instead of replacing it with the default',async()=>{
    records=[{pricingKey:'apify_margin',isActive:true,marginPercentage:'0'}];
    invalidatePricingCache();
    expect(await getApifyMarginPercentage()).toBe(0);
    records=[];
    invalidatePricingCache();
    expect(await getApifyMarginPercentage()).toBe(20);
  });

  it('applies the exact image and per-second video tiers before the configured margin',async()=>{
    records=[
      {id:1,isActive:true,category:'image',provider:'gemini',updatedAt:new Date('2026-09-01'),
        metadata:{verified:true,model:'image-test',unitUsd:0.01,resolutionTiers:{'2K':0.04}}},
      {id:2,isActive:true,category:'video',provider:'gemini',updatedAt:new Date('2026-09-01'),
        metadata:{verified:true,model:'video-test',unitUsd:0.02,resolutionTiers:{'1080p':0.05}}},
      {pricingKey:'image_margin',isActive:true,marginPercentage:'0'},
      {pricingKey:'video_margin',isActive:true,marginPercentage:'10'},
    ];
    invalidatePricingCache();
    const image=await getImageCostWithMarginUSD('image-test',{resolution:'2K'});
    const video=await getVideoCostWithMarginUSD('video-test',8,'1080p');
    expect(image).toMatchObject({baseCostUSD:0.04,totalCostUSD:0.04,source:'admin_override'});
    expect(video.baseCostUSD).toBeCloseTo(0.4,9);
    expect(video.totalCostUSD).toBeCloseTo(0.44,9);
  });
});
