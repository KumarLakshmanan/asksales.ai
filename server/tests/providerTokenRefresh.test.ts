/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach,describe,expect,it,jest } from '@jest/globals';
import { encryptChannelCredentialSecret,decryptChannelCredentialSecret } from '../utils/channelCredentialSecrets.js';
let row:any;
const provider=jest.fn<any>();
const fixtureDb:any={
  execute:async()=>({rows:[]}),
  select:()=>({from:()=>({where:()=>({limit:()=>Object.assign(Promise.resolve(row?.isActive?[row]:[]),{for:async()=>row?.isActive?[row]:[]})})})}),
  update:()=>({set:(values:any)=>({where:async()=>{row={...row,...values};}})}),
};
fixtureDb.transaction=async(work:any)=>work(fixtureDb);
jest.unstable_mockModule('../models/db.js',()=>({db:fixtureDb}));
jest.unstable_mockModule('../services/credentialService.js',()=>({getCredential:async()=>({apiKey:'fixture-client',apiSecret:'fixture-secret'})}));
jest.unstable_mockModule('../utils/logger.js',()=>({logger:{info:jest.fn(),warn:jest.fn(),error:jest.fn()}}));
const {TwitterApiService}=await import('../services/TwitterApiService.js');
const {LinkedInApiService}=await import('../services/LinkedInApiService.js');
beforeEach(()=>{
  row={id:31,userId:9,credentialType:'oauth',isActive:true,accountIdentifier:'fixture-account',accessToken:encryptChannelCredentialSecret('old-access'),refreshToken:encryptChannelCredentialSecret('plain-refresh'),tokenExpiry:new Date(0)};
  provider.mockReset().mockImplementation(async()=>new Response(JSON.stringify({access_token:'new-access',refresh_token:'rotated-refresh',expires_in:3600}),{status:200}));
  globalThis.fetch=provider;
});
describe.each([['X',TwitterApiService],['LinkedIn',LinkedInApiService]] as const)('%s credential refresh acceptance',(_name,Service)=>{
  it('decrypts encrypted refresh input and persists an encrypted rotation',async()=>{
    const service=new Service();expect(await service.initializeForUser(9)).toBe(true);
    const options=provider.mock.calls[0][1] as RequestInit & {body:URLSearchParams};expect(options.body.get('refresh_token')).toBe('plain-refresh');expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(row.refreshToken).not.toBe('rotated-refresh');expect(decryptChannelCredentialSecret(row.refreshToken)).toBe('rotated-refresh');expect(decryptChannelCredentialSecret(row.accessToken)).toBe('new-access');
  });
  it('fails before any request when expiry passed and no refresh token exists',async()=>{
    row.refreshToken=null;const service=new Service();expect(await service.initializeForUser(9)).toBe(false);expect(service.isInitialized()).toBe(false);expect(provider).not.toHaveBeenCalled();
  });
  it('clears prior credentials when a later initialization fails',async()=>{
    row.tokenExpiry=new Date(Date.now()+3600_000);const service=new Service();expect(await service.initializeForUser(9)).toBe(true);
    row=null;expect(await service.initializeForUser(10)).toBe(false);expect(service.isInitialized()).toBe(false);expect(provider).not.toHaveBeenCalled();
  });
  it('preserves a stored refresh token when rotation is omitted',async()=>{
    provider.mockResolvedValueOnce(new Response(JSON.stringify({access_token:'new-access',expires_in:3600}),{status:200}));
    expect(await new Service().initializeForUser(9)).toBe(true);expect(decryptChannelCredentialSecret(row.refreshToken)).toBe('plain-refresh');
  });
  it.each([{}, {access_token:'',expires_in:3600},{access_token:'new-access',expires_in:0}])('rejects malformed token receipt %j',async data=>{
    provider.mockResolvedValueOnce(new Response(JSON.stringify(data),{status:200}));expect(await new Service().initializeForUser(9)).toBe(false);expect(decryptChannelCredentialSecret(row.accessToken)).toBe('old-access');expect(row.isActive).toBe(true);
  });
  it('marks terminal revocation for reconnect without treating a transient failure as revocation',async()=>{
    provider.mockResolvedValueOnce(new Response(JSON.stringify({error:'temporarily_unavailable'}),{status:503}));expect(await new Service().initializeForUser(9)).toBe(false);expect(row.isActive).toBe(true);
    provider.mockResolvedValueOnce(new Response(JSON.stringify({error:'invalid_grant'}),{status:400}));expect(await new Service().initializeForUser(9)).toBe(false);expect(row.isActive).toBe(false);expect(row.readinessErrorCode).toBe('TOKEN_REFRESH_REJECTED');
  });
});
