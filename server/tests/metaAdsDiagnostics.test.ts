import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../utils/metaApiVersion.js',()=>({
  getGraphApiVersion:async()=> 'v25.0',
  getGraphApiBase:(version:string)=>`https://graph.example/${version}`,
}));

const {MetaAdsService}=await import('../services/ads/MetaAdsService.js');

afterEach(()=>{jest.restoreAllMocks();});

describe('Meta campaign diagnostics',()=>{
  it('explains inaccessible campaign errors without reporting zero metrics as success', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: { code: 100, error_subcode: 33, message: 'Unsupported get request' } }),
    } as Response);
    const result = await new MetaAdsService({ accessToken: 'token', adAccountId: '1' })
      .getCampaignMetrics('123', '2026-09-01', '2026-09-14');
    expect(result.success).toBe(false);
    expect(result.metrics).toBeUndefined();
    expect(result.error).toContain('reconnect the Meta account');
    expect(result.error).toContain('subcode 33');
  });
  it('returns successful breakdowns and discloses a provider-rejected section',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockImplementation(async(input)=>{
      const url=String(input);
      if(url.includes('/123?')) return {ok:true,json:async()=>({id:'123',name:'Campaign',objective:'OUTCOME_LEADS',status:'ACTIVE'})} as Response;
      if(url.includes('/adsets?')) return {ok:true,json:async()=>({data:[{id:'set-1',optimization_goal:'LEAD_GENERATION',promoted_object:{pixel_id:'pixel-1',custom_event_type:'LEAD'},attribution_spec:[{event_type:'CLICK_THROUGH',window_days:7}]}]})} as Response;
      if(url.includes('country')) return {ok:false,json:async()=>({error:{message:'Breakdown unavailable for this account'}})} as Response;
      return {ok:true,json:async()=>({data:[{publisher_platform:'instagram',platform_position:'feed',impression_device:'mobile_app',age:'25-34',gender:'female',spend:'25',reach:'900',clicks:'30',ctr:'3.33',actions:[{action_type:'lead',value:'4'}]}]})} as Response;
    });
    const result=await new MetaAdsService({accessToken:'token',adAccountId:'1'}).getCampaignDiagnostics('123','2026-09-01','2026-09-14');
    expect(result.success).toBe(true);
    expect(result.diagnostics?.tracking).toMatchObject({state:'configured',pixelIds:['pixel-1'],configuredEvents:['LEAD']});
    expect(result.diagnostics?.placement).toHaveLength(1);
    expect(result.diagnostics?.geography).toEqual([]);
    expect(result.diagnostics?.limitations.join(' ')).toContain('Breakdown unavailable for this account');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('rejects non-numeric provider campaign identifiers before calling Meta',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch');
    await expect(new MetaAdsService({accessToken:'token',adAccountId:'1'}).getCampaignDiagnostics('bad/id','2026-09-01','2026-09-14')).resolves.toMatchObject({success:false,error:'Meta campaign not found'});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
