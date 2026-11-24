import {afterEach,describe,expect,it,jest} from '@jest/globals';
import type {Request,Response} from 'express';
import {PgDialect} from 'drizzle-orm/pg-core';
import {db} from '../models/db.js';
import {buildReportExport,createSavedSocialReport,getSavedSocialReportExport,listListeningEvents,metricsWithCompleteCoverage,rankPublishingSlots,reportFilterFromDefinition,updateListeningEvent,updateSavedSocialReport,validSocialProfileUrl,captureSocialFollowerSnapshot,refreshDueInstagramCompetitors,refreshPublicCompetitorSnapshot} from '../controllers/socialAnalyticsController.js';
const request=(body:Record<string,unknown>={},query:Record<string,unknown>={},params:Record<string,string>={})=>({user:{id:17},body,query,params}) as unknown as Request;
const response=()=>{const json=jest.fn();const status=jest.fn((_code:number)=>({json}));return {json,status,value:{json,status} as unknown as Response};};
const compile=(query:unknown)=>new PgDialect().sqlToQuery(query as never);
afterEach(()=>{jest.restoreAllMocks();});
describe('Social Insights management',()=>{
 it('advances rolling dates on execution using the configured calendar timezone',()=>{
  const filters={relativeDays:30,timezone:'Asia/Kolkata'};
  const first=reportFilterFromDefinition(filters,new Date('2026-09-19T04:00:00Z'));
  expect(first.start?.toISOString()).toBe('2026-08-20T00:00:00.000Z');expect(first.end?.toISOString()).toBe('2026-09-18T23:59:59.999Z');
  expect(reportFilterFromDefinition(filters,new Date('2026-09-26T04:00:00Z')).start?.toISOString()).toBe('2026-08-27T00:00:00.000Z');
 });
 it('excludes an unfinished UTC provider day even after local midnight',()=>{
  const window=reportFilterFromDefinition({relativeDays:30,timezone:'Asia/Kolkata'},new Date('2026-09-18T20:00:00Z'));
  expect(window.end?.toISOString()).toBe('2026-09-17T23:59:59.999Z');
 });
 it('rejects fixed dates for scheduled reports',async()=>{
  const res=response();await createSavedSocialReport(request({name:'Old',filters:{start:'2026-09-01',end:'2026-09-03'},schedule:{frequency:'daily',localTime:'09:00',timezone:'UTC'},deliveryChannel:'in_app'}),res.value);expect(res.status).toHaveBeenCalledWith(400);
 });
 it('accepts null schedule but returns conflict rather than overwriting same-name reports',async()=>{
  const execute=jest.spyOn(db,'execute').mockResolvedValue({rows:[]} as never);const res=response();await createSavedSocialReport(request({name:'Saved',filters:{},schedule:null}),res.value);
  expect(res.status).toHaveBeenCalledWith(409);expect(compile(execute.mock.calls[0][0]).sql).toContain('DO NOTHING');
 });
 it('pauses without losing the schedule or filters',async()=>{
  const existing={id:'11111111-1111-4111-8111-111111111111',name:'Weekly',filters:{relativeDays:30,timezone:'UTC'},schedule_definition:{frequency:'weekly',dayOfWeek:1,localTime:'09:00',timezone:'UTC'},delivery_channel:'in_app',paused:false};
  const execute=jest.spyOn(db,'execute').mockResolvedValueOnce({rows:[existing]} as never).mockResolvedValueOnce({rows:[]} as never).mockResolvedValueOnce({rows:[{...existing,paused:true}]} as never);
  const res=response();await updateSavedSocialReport(request({paused:true},{},{id:'11111111-1111-4111-8111-111111111111'}),res.value);expect(res.json).toHaveBeenCalledWith(expect.objectContaining({paused:true}));
  const schedule=compile(execute.mock.calls[2][0]).params.find(value=>typeof value==='string'&&value.includes('frequency'));expect(JSON.parse(String(schedule))).toEqual(existing.schedule_definition);
 });
 it('scopes export retrieval to its report and owner',async()=>{
  const execute=jest.spyOn(db,'execute').mockResolvedValue({rows:[]} as never);const res=response();await getSavedSocialReportExport(request({},{},{id:'11111111-1111-4111-8111-111111111111',exportId:'22222222-2222-4222-8222-222222222222'}),res.value);
  expect(res.status).toHaveBeenCalledWith(404);expect(compile(execute.mock.calls[0][0]).params).toEqual(expect.arrayContaining([17,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222']));
 });
 it('exports only the latest metric correction',async()=>{
  const common={platform:'instagram',account_identifier:'account',metric_window_start:'2026-09-01T00:00:00Z',metric_window_end:'2026-09-01T23:59:59.999Z',source:'official_api'};
  const execute=jest.spyOn(db,'execute').mockResolvedValueOnce({rows:[{...common,id:'new',metrics:{reach:25},captured_at:'2026-09-03'},{...common,id:'old',metrics:{reach:10},captured_at:'2026-09-02'}]} as never).mockResolvedValueOnce({rows:[{id:'export'}]} as never);
  await buildReportExport(17,{id:'report',filters:{}},'json');const params=compile(execute.mock.calls[1][0]).params;const payload=JSON.parse(String(params.at(-1)));
  expect(payload.snapshots).toHaveLength(1);expect(payload.snapshots[0].metrics.reach).toBe(25);
 });
 it('ranks measured post timestamps only after sufficient evidence',()=>{
  const posts=Array.from({length:9},(_,i)=>({provider_id:String(i),published_at:`2026-09-0${i+1}T12:00:00Z`,metrics:{likes:i,comments:1,reach:100}}));
  const ranked=rankPublishingSlots(posts,'UTC');expect(ranked.sampleSize).toBe(9);expect(ranked.fallbackUsed).toBe(false);expect(ranked.recommendedSlots).toHaveLength(3);expect(ranked.methodology).toContain('post age');
  expect(rankPublishingSlots(posts.slice(0,7),'UTC').recommendedSlots).toEqual([]);expect(rankPublishingSlots(posts.map(p=>({...p,metrics:{views:100}})),'UTC').sampleSize).toBe(0);
 });
 it('requires complete metric coverage across a benchmark period',()=>{
  const start=new Date('2026-09-01T00:00:00Z'),end=new Date('2026-09-02T23:59:59.999Z');
  const day1={metric_window_start:start.toISOString(),metric_window_end:'2026-09-01T23:59:59.999Z',metrics:{reach:10}},day2={metric_window_start:'2026-09-02T00:00:00Z',metric_window_end:end.toISOString(),metrics:{reach:20}};
  expect(metricsWithCompleteCoverage([day1],start,end,{reach:10})).toEqual({});expect(metricsWithCompleteCoverage([day1,day2],start,end,{reach:30})).toEqual({reach:30});
 });
 it('rejects unrelated and lookalike profile hosts and credential-bearing URLs',()=>{
  expect(validSocialProfileUrl('facebook','https://www.facebook.com/example')).toBe(true);
  for(const url of ['https://example.com/page','https://facebook.com.attacker.com/page','https://user@facebook.com/page','http://facebook.com/page'])expect(validSocialProfileUrl('facebook',url)).toBe(false);
 });
 it('returns filtered listening totals and the next offset',async()=>{
  const execute=jest.spyOn(db,'execute').mockResolvedValueOnce({rows:[{id:'event'}]} as never).mockResolvedValueOnce({rows:[{sentiment:'positive',count:75},{sentiment:'unknown',count:2}]} as never).mockResolvedValueOnce({rows:[{kind:'comments',count:77},{kind:'tags',count:14}]} as never);
  const res=response();await listListeningEvents(request({},{paginated:'1',offset:'0',limit:'50',search:'great'}),res.value);
  expect(res.json).toHaveBeenCalledWith({items:[{id:'event'}],total:77,nextOffset:50,summary:{positive:75,unknown:2},sourceSummary:{comments:77,tags:14,manual:0}});expect(compile(execute.mock.calls[0][0]).params).toContain('%great%');
 });
 it('records manual sentiment correction without inventing a numeric score',async()=>{
  const execute=jest.spyOn(db,'execute').mockResolvedValueOnce({rows:[{id:'event',body:'Thanks',sentiment:'unknown',metadata:{credentialId:22}}]} as never).mockResolvedValueOnce({rows:[{id:'event',sentiment:'positive'}]} as never);
  const res=response();await updateListeningEvent(request({sentiment:'positive',status:'reviewed'},{},{id:'event'}),res.value);
  const params=compile(execute.mock.calls[1][0]).params;const metadata=JSON.parse(String(params.find(v=>typeof v==='string'&&v.includes('sentimentSource'))));
  expect(metadata).toEqual(expect.objectContaining({credentialId:22,sentimentSource:'manual',reviewStatus:'reviewed'}));expect(params).toContain(null);
 });
 it('captures follower totals only on the actual observation date',async()=>{
  const execute=jest.spyOn(db,'execute').mockResolvedValueOnce({rows:[]} as never).mockResolvedValueOnce({rows:[{id:'captured'}]} as never);
  await captureSocialFollowerSnapshot({userId:17,platform:'instagram',accountIdentifier:'account',followers:120,capturedAt:new Date('2026-09-19T08:00:00Z')});
  const params=compile(execute.mock.calls[1][0]).params;expect(params.map(String)).toContain(String(new Date('2026-09-19T00:00:00.000Z')));
 });
 it('refreshes public follower counts without manufacturing private metrics or reporting windows',async()=>{
  const execute=jest.spyOn(db,'execute').mockResolvedValueOnce({rows:[{id:'peer'}]} as never).mockResolvedValueOnce({rows:[{id:'snapshot'}]} as never).mockResolvedValueOnce({rows:[]} as never);
  const client={platform:'instagram' as const,credential:{accountIdentifier:'123'},request:jest.fn(async()=>({business_discovery:{id:'456',followers_count:210,media_count:18}}))};
  const result=await refreshPublicCompetitorSnapshot(17,{id:'peer',public_handle:'peer',public_url:'https://instagram.com/peer'},client);
  expect(result.snapshot.id).toBe('snapshot');expect(compile(execute.mock.calls[0][0]).sql).toContain('FOR UPDATE');const insert=compile(execute.mock.calls[1][0]);expect(insert.params).toContain(JSON.stringify({followers:210}));expect(insert.sql).not.toContain('metric_window');
  expect(compile(execute.mock.calls[2][0]).sql).toContain("last_refresh_status='success'");
 });
 it('claims at most five stale active Instagram profiles before provider calls and persists failures',async()=>{
  const execute=jest.spyOn(db,'execute').mockResolvedValueOnce({rows:[{id:'peer',public_handle:'peer',public_url:'https://instagram.com/peer'}]} as never).mockResolvedValueOnce({rows:[]} as never).mockResolvedValueOnce({rows:[]} as never);
  const client={platform:'instagram' as const,credential:{accountIdentifier:'123'},request:jest.fn(async()=>{throw new Error('sensitive provider URL');})};
  expect(await refreshDueInstagramCompetitors(17,client)).toEqual({attempted:1,succeeded:0,failed:1});
  const claim=compile(execute.mock.calls[0][0]);expect(claim.sql).toContain("INTERVAL '24 hours'");expect(claim.sql).toContain('LIMIT 5 FOR UPDATE SKIP LOCKED');expect(claim.sql).toContain("is_active=TRUE");
  const failure=compile(execute.mock.calls[1][0]);expect(failure.sql).toContain("last_refresh_status='error'");expect(failure.params.join(' ')).not.toContain('sensitive provider URL');
  expect(await refreshDueInstagramCompetitors(17,client)).toEqual({attempted:0,succeeded:0,failed:0});expect(client.request).toHaveBeenCalledTimes(1);
 });

});
