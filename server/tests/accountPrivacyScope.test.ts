import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import {currentBusinessScope,withBusinessScope} from '../tenancy/businessContext.js';
const execute=jest.fn<any>().mockResolvedValue({rows:[]});
const resolveBilling=jest.fn<any>();
const access=jest.fn<any>();
const listConsents=jest.fn<any>().mockResolvedValue([]),latestConsent=jest.fn<any>().mockResolvedValue(null);
const prepareExport=jest.fn<any>().mockRejectedValue(new Error("Synthetic artifact boundary; real export is covered by Data integration"));
const consent=jest.fn<any>().mockResolvedValue({}),getUser=jest.fn<any>().mockImplementation(async(id:number)=>({id,email:'actor@example.test'}));
jest.unstable_mockModule('../services/privacy/PrivacyDataExport.js',()=>({preparePrivacyExport:prepareExport}));
jest.unstable_mockModule('../models/db.js',()=>({db:{execute}}));
jest.unstable_mockModule('../services/billing/organizations.js',()=>({resolveBillingOrganization:resolveBilling,BillingOrganizationError:class extends Error{}}));
jest.unstable_mockModule('../services/subscriptions/service.js',()=>({subscriptions:{access}}));
jest.unstable_mockModule('../models/userConsents/functions.js',()=>({createUserConsent:consent,getLatestConsent:latestConsent,listConsentsForUser:listConsents}));
jest.unstable_mockModule('../models/users/functions.js',()=>({getUserById:getUser}));
const {businessProfileScope}=await import('../middleware/businessProfileScope.js');
const {billingOrganizationScope}=await import('../middleware/billingOrganizationScope.js');
const {checkSubscriptionRequest,isSubscriptionExempt}=await import('../middleware/subscriptionAccess.js');
const {privacyController}=await import('../controllers/privacyController.js');
function response(){const r:any={status:jest.fn(),json:jest.fn(),setHeader:jest.fn(),write:jest.fn(),end:jest.fn(),flushHeaders:jest.fn(),once:jest.fn(),off:jest.fn()};r.status.mockReturnValue(r);r.json.mockReturnValue(r);return r as Response;}
const paths=['consents','status','opt-out','opt-in','data-export'];
beforeEach(()=>{jest.clearAllMocks();execute.mockResolvedValue({rows:[]});});
describe('account privacy remains authenticated and independent of commercial workspace',()=>{
  it.each(paths)('permits %s without a business, subscription or payer lookup, ignoring stale selectors',async suffix=>{
    const req={user:{id:202},originalUrl:`/api/privacy/${suffix}`,method:'POST',headers:{'x-business-profile-id':'999','x-billing-organization-id':'999'},body:{userId:101},query:{}} as unknown as Request;
    const res=response(),handler=jest.fn(async()=>{expect(currentBusinessScope()).toBeUndefined();expect(req.user!.id).toBe(202);});
    await withBusinessScope({userId:101,actorUserId:202,businessProfileId:501},()=>businessProfileScope(req,res,()=>{
      return billingOrganizationScope(req,res,async()=>{if(await checkSubscriptionRequest(req,res))await handler();});
    }));
    expect(handler).toHaveBeenCalledTimes(1);expect(execute).not.toHaveBeenCalled();expect(resolveBilling).not.toHaveBeenCalled();expect(access).not.toHaveBeenCalled();
  });
  it('keeps account identity in consent reads, audit and export despite a supplied foreign account ID',async()=>{
    const req={user:{id:202},body:{userId:101,reason:'synthetic'},headers:{},ip:'127.0.0.1',once:jest.fn(),off:jest.fn()} as unknown as Request;
    await privacyController.listConsents(req,response());await privacyController.status(req,response());await privacyController.dataExport(req,response());
    expect(listConsents).toHaveBeenCalledWith(202);expect(latestConsent).toHaveBeenCalledWith(202,'all_channels');
    expect(consent).toHaveBeenCalledWith(expect.objectContaining({userId:202,consentType:'data_export_request'}));expect(prepareExport).toHaveBeenCalledWith(202,expect.any(AbortSignal));
  });
  it('requires authentication even for an exact account privacy path',async()=>{
    const res=response(),next=jest.fn();await businessProfileScope({originalUrl:'/api/privacy/status',headers:{}} as Request,res,next);
    expect(res.status).toHaveBeenCalledWith(401);expect(next).not.toHaveBeenCalled();
  });
  it('does not grant an unknown or business-owned export route account-only treatment',async()=>{
    const path='/api/privacy/business-export';expect(isSubscriptionExempt(path)).toBe(false);
    const req={user:{id:202},originalUrl:path,headers:{},query:{},body:{}} as unknown as Request;
    const res=response(),next=jest.fn();await businessProfileScope(req,res,next);
    expect(res.status).toHaveBeenCalledWith(409);expect(next).not.toHaveBeenCalled();
  });
});
