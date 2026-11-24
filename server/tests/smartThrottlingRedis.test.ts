import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Redis from 'ioredis';
import crypto from 'node:crypto';

// Explicit socket under the disposable task workspace; no network or real Redis.
const socket=process.env.THROTTLE_QA_SOCKET;
const suite=socket ? describe : describe.skip;
const redis=new Redis({path:socket || '/tmp/unused-throttle-qa.sock',lazyConnect:true,maxRetriesPerRequest:0,retryStrategy:()=>null});
jest.unstable_mockModule('../infrastructure/redis.js',()=>({getRedisConnection:()=>redis}));
const {SmartThrottlingService,THROTTLE_OPERATION_LUA}=await import('../services/SmartThrottlingService.js');
const service=SmartThrottlingService.getInstance();
const prefix=`throttle:qa-${crypto.randomBytes(6).toString('hex')}`;
const keys=new Set<string>();
const key=(suffix:string)=>{const value=`${prefix}:${suffix}`;keys.add(value);return value;};
async function operation(now:number,mode='claim',limits:Record<string,number>={dailyLimit:5,hourlyLimit:3,minuteLimit:2},suffix='one') {
  return JSON.parse(String(await redis.eval(THROTTLE_OPERATION_LUA,1,key(suffix),now,JSON.stringify(limits),mode,
    JSON.stringify({platform:'email',userId:991,accountId:'qa',todayCount:0,hourCount:0,minuteCount:0,lastRequestMs:0,lastRequestAt:0}),
    JSON.stringify({dayBucket:0,hourBucket:0,minuteBucket:0,lastRequestMs:0}))));
}
suite('SmartThrottling real Redis atomic limits',()=>{
  beforeAll(async()=>{if(!socket?.startsWith('/workspace/tenant-billing-fixes-'))throw new Error('Disposable task Redis socket required');await redis.connect();});
  beforeEach(async()=>{if(keys.size)await redis.del(...keys);keys.clear();});
  afterAll(async()=>{if(keys.size)await redis.del(...keys);service.destroy();await redis.quit();});
  it('admits exactly the budget under 40 simultaneous claims without lost increments',async()=>{
    const now=Date.parse('2026-11-01T12:30:05Z');
    const results=await Promise.all(Array.from({length:40},()=>operation(now,'claim',{dailyLimit:7})));
    expect(results.filter(r=>r.allowed)).toHaveLength(7);
    expect(results.filter(r=>!r.allowed)).toHaveLength(33);
    expect((await operation(now,'peek',{dailyLimit:7})).stats.todayCount).toBe(7);
  });
  it('resets minute and hour independently and gives precise retry intervals',async()=>{
    const now=Date.parse('2026-11-01T12:59:58Z');
    expect((await operation(now)).allowed).toBe(true);expect((await operation(now)).allowed).toBe(true);
    expect(await operation(now)).toMatchObject({allowed:false,bucket:'Per-minute',retryAfter:2});
    const next=await operation(now+2000);
    expect(next).toMatchObject({allowed:true,stats:{todayCount:3,hourCount:1,minuteCount:1}});
    expect((await operation(now+2000)).allowed).toBe(true);
    expect(await operation(now+2000)).toMatchObject({allowed:false,bucket:'Per-minute'});
    expect(await operation(now+62000)).toMatchObject({allowed:true,stats:{todayCount:5,hourCount:3,minuteCount:1}});
    expect(await operation(now+62000)).toMatchObject({allowed:false,bucket:'Daily'});
    expect(await operation(Date.parse('2026-11-02T00:00:00Z'))).toMatchObject({allowed:true,stats:{todayCount:1,hourCount:1,minuteCount:1}});
  });
  it('enforces hourly boundary separately from the daily budget',async()=>{
    const now=Date.parse('2026-11-01T12:59:58Z'), limits={dailyLimit:10,hourlyLimit:2};
    await operation(now,'claim',limits);await operation(now,'claim',limits);
    expect(await operation(now,'peek',limits)).toMatchObject({allowed:false,bucket:'Hourly',retryAfter:2});
    expect(await operation(now+2000,'claim',limits)).toMatchObject({allowed:true,stats:{todayCount:3,hourCount:1}});
  });
  it('keeps minimum-delay claims atomic and does not consume a denied request',async()=>{
    const now=Date.parse('2026-11-01T12:00:00Z'), limits={dailyLimit:100,minDelayMs:1500};
    const results=await Promise.all([operation(now,'claim',limits),operation(now,'claim',limits)]);
    expect(results.filter(r=>r.allowed)).toHaveLength(1);
    expect(await operation(now+501,'claim',limits)).toMatchObject({allowed:false,retryAfter:1,stats:{todayCount:1}});
    expect(await operation(now+1500,'claim',limits)).toMatchObject({allowed:true,stats:{todayCount:2}});
  });
  it('service claims use Redis time and stats never include a user with a matching numeric prefix',async()=>{
    const user=910000+crypto.randomInt(10000),other=Number(`${user}2`);
    service.updatePlatformLimits('email',{dailyLimit:2,hourlyLimit:100,minuteLimit:100,minDelayMs:0});
    for(const id of [user,other])keys.add(`throttle:email:${id}:qa`);
    const results=await Promise.all(Array.from({length:12},()=>service.claimRequest('email',user,'qa')));
    expect(results.filter(r=>r.allowed)).toHaveLength(2);
    await service.claimRequest('email',other,'qa');
    const stats=await service.getAllUsageStats(user);
    expect(stats).toHaveLength(1);expect(stats[0]).toMatchObject({userId:user,todayCount:2});
    expect(stats[0].resetAt.getUTCHours()).toBe(0);
  });
  it('normalizes a legacy JSON timestamp without clearing a current counter',async()=>{
    const user=920000+crypto.randomInt(10000),k=`throttle:email:${user}:qa`;keys.add(k);
    const now=Date.now();await redis.set(k,JSON.stringify({platform:'email',userId:user,accountId:'qa',todayCount:2,hourCount:2,minuteCount:2,lastRequestAt:new Date(now).toISOString(),resetAt:new Date(now+86400000).toISOString()}));
    expect(await service.claimRequest('email',user,'qa')).toMatchObject({allowed:false});
    expect((await service.getUsageStats('email',user,'qa')).todayCount).toBe(2);
  });
});
