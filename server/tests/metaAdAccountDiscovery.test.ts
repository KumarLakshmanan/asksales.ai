import { jest } from '@jest/globals';
import { discoverMetaAccountsWithToken } from '../services/ads/MetaAdAccountDiscovery.js';
const ok=(body:unknown)=>new Response(JSON.stringify(body),{status:200});
afterEach(()=>jest.restoreAllMocks());
it('discovers every account page with bearer authorization',async()=>{
  const spy=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(ok({data:[{id:'act_1',name:'First'}],paging:{next:'https://graph.facebook.com/v25.0/me/adaccounts?after=next'}})).mockResolvedValueOnce(ok({data:[{id:'act_2',name:'Second'}]})).mockResolvedValueOnce(ok({data:[{permission:'ads_management',status:'granted'}]}));
  await expect(discoverMetaAccountsWithToken('private-token')).resolves.toMatchObject({accounts:[{id:'act_1'},{id:'act_2'}],publishingAvailable:true});
  expect(spy.mock.calls.every(([,init])=>(init?.headers as Record<string,string>).Authorization==='Bearer private-token')).toBe(true);
});
it('rejects a later-page permission failure without returning partial accounts or provider secrets',async()=>{
  jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(ok({data:[{id:'act_1'}],paging:{next:'https://graph.facebook.com/v25.0/me/adaccounts?after=next'}})).mockResolvedValueOnce(new Response(JSON.stringify({error:{message:'private-token'}}),{status:403}));
  await expect(discoverMetaAccountsWithToken('private-token')).rejects.toThrow('Check Ads permissions');
});
it('rejects provider pagination to another origin before sending credentials',async()=>{
  const spy=jest.spyOn(globalThis,'fetch').mockResolvedValue(ok({data:[],paging:{next:'https://attacker.invalid/accounts'}}));
  await expect(discoverMetaAccountsWithToken('private-token')).rejects.toThrow('Invalid account');
  expect(spy).toHaveBeenCalledTimes(1);
});
it('does not infer publishing access from reporting discovery',async()=>{
  jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(ok({data:[{id:'act_1',name:'First'}]})).mockResolvedValueOnce(ok({data:[{permission:'ads_read',status:'granted'}]}));
  await expect(discoverMetaAccountsWithToken('private-token')).resolves.toMatchObject({publishingAvailable:false});
});
