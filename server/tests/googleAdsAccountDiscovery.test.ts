import { jest } from '@jest/globals';
import { discoverGoogleAdsAccounts } from '../services/ads/GoogleAdsService.js';
const credentials={clientId:'discovery',clientSecret:'test',refreshToken:'discovery',developerToken:'test',customerId:'',managerAccountId:''};
const ok=(body:unknown)=>new Response(JSON.stringify(body),{status:200});
afterEach(()=>jest.restoreAllMocks());
it('discovers nested managers, follows all pages, and retains the root login account',async()=>{
  const headers:Array<[string,string|undefined]>=[];
  jest.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    const path=String(url);
    if(path.includes('oauth2'))return ok({access_token:'token',expires_in:3600});
    if(path.includes('listAccessibleCustomers'))return ok({resourceNames:['customers/1111111111','customers/3333333333']});
    const id=path.match(/customers\/(\d+)/)![1];
    const body=JSON.parse(String(init?.body));
    headers.push([id,(init?.headers as Record<string,string>)['login-customer-id']]);
    if(body.query.includes('FROM customer\n') || body.query.includes('FROM customer\r') || /FROM customer\s+LIMIT/.test(body.query)) return ok({results:[{customer:{id,descriptiveName:id,currencyCode:'INR',timeZone:'Asia/Kolkata',manager:id!=='3333333333'}}]});
    if(id==='1111111111')return body.pageToken?ok({results:[{customerClient:{id:'3333333333',level:1,manager:false}}]}):ok({results:[{customerClient:{id:'2222222222',level:1,manager:true}}],nextPageToken:'more'});
    return ok({results:[{customerClient:{id:'3333333333',level:1,manager:false}}]});
  });
  const result=await discoverGoogleAdsAccounts(credentials);
  expect(result.failures).toEqual([]);
  expect(result.accounts).toHaveLength(3);
  expect(result.accounts.find(a=>a.customerId==='3333333333')).toMatchObject({currency:'INR',manager:false,managerAccountId:'1111111111'});
  expect(headers.some(([id,login])=>id==='2222222222'&&login==='1111111111')).toBe(true);
});
it('reports inaccessible customers without inventing reporting readiness',async()=>{
  jest.spyOn(globalThis,'fetch').mockImplementation(async(url)=>{
    if(String(url).includes('oauth2'))return ok({access_token:'token',expires_in:3600});
    if(String(url).includes('listAccessibleCustomers'))return ok({resourceNames:['customers/4444444444']});
    return new Response(JSON.stringify({error:{message:'permission denied'}}),{status:403});
  });
  const result=await discoverGoogleAdsAccounts(credentials);
  expect(result.accounts).toEqual([]);
  expect(result.failures).toHaveLength(1);
});
