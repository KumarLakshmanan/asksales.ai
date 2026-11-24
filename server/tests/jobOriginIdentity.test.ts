import {beforeEach,describe,expect,it,jest} from '@jest/globals';
import {currentBusinessScope,currentDatabaseScope,withBusinessScope} from '../tenancy/businessContext.js';
import {currentBillingScope,withBillingScope} from '../tenancy/billingContext.js';

jest.unstable_mockModule('../models/db.js',()=>({db:{execute:jest.fn()}}));
const resolve=jest.fn<()=>Promise<number>>();
const eachBusiness=jest.fn<any>();
class Rejected extends Error {constructor(message:string,readonly status=403,readonly code='ORGANIZATION_FORBIDDEN'){super(message);}}
jest.unstable_mockModule('../services/billing/organizations.js',()=>({BillingOrganizationError:Rejected,resolveBillingOrganization:resolve}));
jest.unstable_mockModule('../tenancy/businessLifecycle.js',()=>({requireApprovedBusiness:async()=>undefined}));
jest.unstable_mockModule('../tenancy/businessScopeResolver.js',()=>({
  resolveBusinessScope:async(actor:number,profile:number)=>({userId:9,businessProfileId:profile,actorUserId:actor}),
  forEachBusiness:eachBusiness,scopeForRecord:jest.fn(),
}));
const {captureJobBusiness,runBusinessJob}=await import('../tenancy/jobBusinessScope.js');
const owner={userId:9,businessProfileId:91,actorUserId:9};
const original={userId:9,businessProfileId:91,businessActorUserId:17,billingActorUserId:17,billingOrganizationId:901,type:'process_instagram_automation'};
const asOwner=<T>(work:()=>T)=>withBusinessScope(owner,()=>withBillingScope({organizationId:901,actorUserId:9},work));
beforeEach(()=>{resolve.mockReset();resolve.mockResolvedValue(901);});

describe('immutable originating queued authority',()=>{
  it('expires staged PII across awaiting-approval businesses using scoped maintenance inventory',async()=>{
    const work=jest.fn<any>().mockResolvedValue({recovered:0});
    eachBusiness.mockImplementationOnce(async(callback:any,approvedOnly:boolean)=>{
      expect(currentDatabaseScope()).toMatchObject({kind:'system',reason:'Dashboard operation maintenance inventory'});
      expect(approvedOnly).toBe(false);
      return withBusinessScope(owner,()=>callback({...owner,kind:'business'}));
    });
    await runBusinessJob({systemJob:true,type:'cron-dashboard-operations-recovery'},work);
    expect(work).toHaveBeenCalledWith({systemJob:true,type:'cron-dashboard-operations-recovery',userId:9,businessProfileId:91});
    expect(resolve).not.toHaveBeenCalled();
  });
  it('preserves both explicit actors instead of ambient recovery owner9',async()=>{
    resolve.mockImplementation(async()=>{
      expect(currentBusinessScope()?.actorUserId).toBe(17);
      expect(currentBillingScope()?.actorUserId).toBe(17);
      return 901;
    });
    const captured=await asOwner(()=>captureJobBusiness(original,{requireOriginatingIdentity:true}));
    expect(captured).toEqual({...original,systemJob:false});
    expect(original).not.toHaveProperty('systemJob');
    await asOwner(()=>runBusinessJob(captured,async data=>{
      expect(data.businessActorUserId).toBe(17);expect(data.billingActorUserId).toBe(17);
      expect(currentBusinessScope()?.actorUserId).toBe(17);expect(currentBillingScope()?.actorUserId).toBe(17);
    }));
  });
  it('does not promote the original actor even when it is no longer authorized',async()=>{
    const effects=jest.fn();
    resolve.mockImplementation(async()=>{
      expect(currentBusinessScope()?.actorUserId).toBe(17);expect(currentBillingScope()?.actorUserId).toBe(17);
      throw new Rejected('Original staff was revoked');
    });
    await expect(asOwner(async()=>{await captureJobBusiness(original,{requireOriginatingIdentity:true});effects();})).rejects.toMatchObject({code:'ORGANIZATION_FORBIDDEN'});
    await expect(asOwner(()=>runBusinessJob(original,async()=>effects()))).rejects.toMatchObject({code:'ORGANIZATION_FORBIDDEN'});
    expect(effects).not.toHaveBeenCalled();
  });
  it.each(['businessActorUserId','billingActorUserId'] as const)('rejects conflicting %s independently',async field=>{
    const effects=jest.fn();
    const conflicting={...original,[field]:9};
    await expect(asOwner(()=>captureJobBusiness(conflicting,{requireOriginatingIdentity:true}))).rejects.toMatchObject({code:'JOB_ACTOR_MISMATCH'});
    await expect(asOwner(()=>runBusinessJob(conflicting,async()=>effects()))).rejects.toMatchObject({code:'JOB_ACTOR_MISMATCH'});
    expect(effects).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();
  });
  it.each(['userId','businessProfileId','businessActorUserId','billingActorUserId','billingOrganizationId'] as const)('leaves legacy recovery without %s unsent',async field=>{
    const incomplete={...original,[field]:undefined};const effects=jest.fn();
    await expect(asOwner(()=>captureJobBusiness(incomplete,{requireOriginatingIdentity:true}))).rejects.toMatchObject({code:'JOB_ORIGIN_REQUIRED'});
    await expect(asOwner(()=>runBusinessJob(incomplete,async()=>effects()))).rejects.toMatchObject({code:'JOB_ORIGIN_REQUIRED'});
    expect(effects).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();
  });
  it('captures legitimate new owner work and executes it with explicit owner authority',async()=>{
    const captured=await asOwner(()=>captureJobBusiness({userId:9,type:'new_owner_work'}));
    expect(captured).toMatchObject({businessActorUserId:9,billingActorUserId:9,billingOrganizationId:901});
    await expect(runBusinessJob(captured,async()=>currentBusinessScope()?.actorUserId)).resolves.toBe(9);
  });
  it('retains an explicit payer instead of replacing it with the ambient organization',async()=>{
    resolve.mockImplementation(async()=>{expect(currentBillingScope()?.organizationId).toBe(902);return 902;});
    expect(await asOwner(()=>captureJobBusiness({...original,billingOrganizationId:902},{requireOriginatingIdentity:true}))).toMatchObject({billingOrganizationId:902,billingActorUserId:17});
  });
  it.each([0,-1,1.5,Number.NaN,Number.POSITIVE_INFINITY,'17'])('rejects malformed originating identity %s before authorization',async value=>{
    const malformed={...original,businessActorUserId:value} as unknown as typeof original;
    await expect(asOwner(()=>captureJobBusiness(malformed,{requireOriginatingIdentity:true}))).rejects.toMatchObject({code:'JOB_ORIGIN_REQUIRED'});
    expect(resolve).not.toHaveBeenCalled();
  });
});
