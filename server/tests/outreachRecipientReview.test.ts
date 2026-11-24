import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const lookup=jest.fn<any>();
jest.unstable_mockModule('../services/outreach/CreationService.js',()=>({
  getCreationOptions:jest.fn(),getCreationRecipients:lookup,getCreationTemplates:jest.fn(),prepareCreationContact:jest.fn(),
}));
jest.unstable_mockModule('../services/outreach/CreationImportSources.js',()=>({getCreationImportSources:jest.fn()}));
jest.unstable_mockModule('../utils/logger.js',()=>({logger:{error:jest.fn(),warn:jest.fn()}}));
const {getOutreachCreationRecipients,reviewOutreachCreationRecipients}=await import('../controllers/outreachCreationController.js');
const {mockAuthRequest,mockResponse}=await import('./helpers/mockHelpers.js');
beforeEach(()=>{jest.clearAllMocks();lookup.mockResolvedValue({recipients:[],nextCursor:null});});
describe('full-audience final recipient review',()=>{
  it('checks every one of 30,202 selected contacts in one HTTP request with bounded database batches',async()=>{
    const ids=Array.from({length:30202},(_,i)=>i+1);
    lookup.mockImplementation(async(_userId:number,_channel:string,_account:unknown,query:{ids:number[]})=>({recipients:query.ids.map(id=>({id,eligible:true})),nextCursor:null}));
    const req=mockAuthRequest(9,{body:{channel:'whatsapp',providerAccountId:'account',ids}});const res=mockResponse();
    await reviewOutreachCreationRecipients(req,res);
    expect(res._status).toBe(200);expect(res._json.recipients.map((item:{id:number})=>item.id)).toEqual(ids);
    expect(lookup).toHaveBeenCalledTimes(31);
    expect(lookup.mock.calls.every(call=>(call[3] as {ids:number[]}).ids.length<=1000)).toBe(true);
    expect(lookup.mock.calls.every(call=>call[0]===9 && call[1]==='whatsapp' && (call[2] as {providerAccountId:string}).providerAccountId==='account')).toBe(true);
  });
  it('fails closed when any selected-recipient batch cannot be verified',async()=>{
    lookup.mockResolvedValueOnce({recipients:[{id:1,eligible:true}],nextCursor:null}).mockRejectedValueOnce(new Error('Database unavailable'));
    const req=mockAuthRequest(9,{body:{channel:'whatsapp',ids:Array.from({length:1001},(_,i)=>i+1)}});const res=mockResponse();
    await reviewOutreachCreationRecipients(req,res);
    expect(res._status).toBe(503);expect(res._json.recipients).toBeUndefined();
  });
  it.each([{ids:[]},{ids:[0]},{ids:[1,'2']},{ids:[9007199254740992]}])('rejects an invalid JSON selection $ids',async({ids})=>{
    const req=mockAuthRequest(9,{body:{channel:'whatsapp',ids}});const res=mockResponse();
    await reviewOutreachCreationRecipients(req,res);expect(res._status).toBe(400);expect(lookup).not.toHaveBeenCalled();
  });
  it.each([575,1500])('keeps all %s selected IDs instead of rejecting the final review at 500',async count=>{
    const ids=Array.from({length:count},(_,i)=>i+1);
    lookup.mockResolvedValueOnce({recipients:ids.map(id=>({id,eligible:true})),nextCursor:null});
    const req=mockAuthRequest(9,{query:{channel:'whatsapp',providerAccountId:'account',ids:ids.join(',')}});const res=mockResponse();
    await getOutreachCreationRecipients(req,res);
    expect(res._status).toBe(200);expect(res._json.recipients).toHaveLength(count);
    expect(lookup).toHaveBeenCalledWith(9,'whatsapp',expect.objectContaining({providerAccountId:'account'}),expect.objectContaining({ids}));
  });
  it.each(['0','1,bad','9007199254740992'])('still rejects an invalid recipient selection: %s',async ids=>{
    const req=mockAuthRequest(9,{query:{channel:'whatsapp',ids}});const res=mockResponse();
    await getOutreachCreationRecipients(req,res);expect(res._status).toBe(400);expect(lookup).not.toHaveBeenCalled();
  });
});
