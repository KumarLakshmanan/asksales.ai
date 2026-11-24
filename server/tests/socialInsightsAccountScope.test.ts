import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../models/db.js';
import { createSavedSocialReport, getCompetitorBenchmark, listListeningEvents } from '../controllers/socialAnalyticsController.js';

const response=()=>{const json=jest.fn();const status=jest.fn((_code:number)=>({json}));return {json,status,value:{json,status} as unknown as Response};};
const request=(query:Record<string,unknown>={},body:Record<string,unknown>={},params:Record<string,string>={})=>({user:{id:17},query,body,params} as unknown as Request);

afterEach(()=>{jest.restoreAllMocks();});

describe('Social Insights account and period scope',()=>{
  it('filters listening evidence to the selected tenant-owned account',async()=>{
    jest.spyOn(db,'select').mockReturnValue({from:()=>({where:()=>({limit:async()=>[{id:22,platform:'instagram_api',accountIdentifier:'ig-owned'}]})})} as never);
    const execute=jest.spyOn(db,'execute').mockResolvedValue({rows:[]} as never);
    const res=response();
    await listListeningEvents(request({platform:'instagram',credentialId:'22',start:'2026-09-01',end:'2026-09-15'}),res.value);
    expect(res.json).toHaveBeenCalledWith([]);
    const compiled=new PgDialect().sqlToQuery(execute.mock.calls[0][0] as never);
    expect(compiled.sql).toContain("metadata->>'credentialId'");
    expect(compiled.params).toEqual(expect.arrayContaining([17,'instagram','22']));
  });

  it('rejects partial first-party days against a complete competitor reporting period',async()=>{
    const execute=jest.spyOn(db,'execute')
      .mockResolvedValueOnce({rows:[{id:'competitor-1',platform:'instagram',public_handle:'peer'}]} as never)
      .mockResolvedValueOnce({rows:[{id:'evidence-1',metrics:{impressions:25},source:'public_export',source_url:'https://example.com/evidence',source_snapshot_id:'peer-window',metric_window_start:'2026-09-01T00:00:00.000Z',metric_window_end:'2026-09-15T23:59:59.999Z',captured_at:'2026-09-16T00:00:00Z'}]} as never)
      .mockResolvedValueOnce({rows:[
        {id:'day-2',platform:'instagram',account_identifier:'ig-owned',metric_window_start:'2026-09-02T00:00:00Z',metric_window_end:'2026-09-02T23:59:59Z',captured_at:'2026-09-03T00:00:00Z',source:'official_api',source_snapshot_id:'day-2',timezone:'UTC',metrics:{impressions:20}},
        {id:'day-1',platform:'instagram',account_identifier:'ig-owned',metric_window_start:'2026-09-01T00:00:00Z',metric_window_end:'2026-09-01T23:59:59Z',captured_at:'2026-09-02T00:00:00Z',source:'official_api',source_snapshot_id:'day-1',timezone:'UTC',metrics:{impressions:10}},
      ]} as never);
    const res=response();
    await getCompetitorBenchmark(request({accountIdentifier:'ig-owned',start:'2026-09-01T00:00:00.000Z',end:'2026-09-15T23:59:59.999Z'},{},{id:'competitor-1'}),res.value);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({benchmark:null,reason:expect.stringContaining('comparable')}));
    const competitorQuery=new PgDialect().sqlToQuery(execute.mock.calls[1][0] as never);
    expect(competitorQuery.sql).toContain('metric_window_start');
    expect(competitorQuery.sql).toContain('metric_window_end');
  });

  it('requires an owned account and never overwrites a same-name report during creation',async()=>{
    jest.spyOn(db,'select').mockReturnValue({from:()=>({where:()=>({limit:async()=>[{id:22,platform:'instagram_api'}]})})} as never);
    const execute=jest.spyOn(db,'execute').mockResolvedValue({rows:[{id:'report-1',name:'Weekly Instagram'}]} as never);
    const res=response();
    await createSavedSocialReport(request({}, {name:'Weekly Instagram',filters:{platform:'instagram',accountIdentifier:'ig-owned',start:'2026-09-01T00:00:00.000Z',end:'2026-09-15T23:59:59.999Z'},deliveryChannel:'in_app'}),res.value);
    expect(res.status).toHaveBeenCalledWith(201);
    const compiled=new PgDialect().sqlToQuery(execute.mock.calls[0][0] as never);
    expect(compiled.sql).toContain('ON CONFLICT(business_profile_id, user_id,name) DO NOTHING');
  });
});
