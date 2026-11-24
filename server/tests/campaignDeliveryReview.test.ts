import { installReadyCustomerDeliveryMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
const execute=jest.fn<any>(),resolveAccount=jest.fn<any>(),recipients=jest.fn<any>(),timing=jest.fn<any>();
jest.unstable_mockModule('../models/db.js',()=>({db:{execute}}));
jest.unstable_mockModule('../services/outreach/CreationService.js',()=>({resolveCreationAccount:resolveAccount,getCreationRecipients:recipients,validateOutreachTiming:timing}));
const {prepareCampaignDelivery,assertCampaignJobReview,CampaignDeliveryReviewError}=await import('../services/outreach/CampaignDeliveryService.js');
const dialect=new PgDialect();
const scope=<T>(work:()=>T)=>withBusinessScope({userId:12,businessProfileId:101},work);
const campaign={id:9,status:'draft',campaign_type:'both',settings:{sequenceIds:[5,6]},lead_list_ids:[73,74]};
const sequences=[{id:5,sequence_type:'email',steps:[{day:0,subject:'Hi {{first_name}}',body:'Hello {{company_name}}'},{day:3,subject:'Follow-up',body:'Hello again'}]},
  {id:6,sequence_type:'sms',steps:[{day:0,message:'Hi {{first_name}}'}]}];
const accounts={email:{senderId:7},sms:{providerAccountId:'sms-account'}};
const lead=(id:number,channel:string)=>({id,name:'Ada',firstName:'Ada',lastName:'Lovelace',company:'Engines',email:'ada@example.test',phone:'919876543210',recipient:channel==='email'?`${id}@example.test`:`9198765432${id}`,eligible:true,reason:null});
beforeEach(()=>{
  jest.clearAllMocks();
  execute.mockImplementation(async(query:SQL)=>({rows:dialect.sqlToQuery(query).sql.includes('FROM outreach_campaigns')?[campaign]:sequences}));
  resolveAccount.mockImplementation(async(_user:number,channel:string)=>({account:{ready:true,providerAccountId:channel==='email'?'mailbox':'sms-account',senderId:channel==='email'?7:undefined,label:channel==='email'?'sales@example.test':channel},binding:{credentialId:77}}));
  recipients.mockImplementation(async(_user:number,channel:string,_selection:unknown,query:{ids:number[]})=>({recipients:query.ids.map(id=>lead(id,channel))}));
  timing.mockImplementation((date?:string)=>date?new Date(date):undefined);
});
describe('campaign delivery review shares composer boundaries',()=>{
  it('invalidates the review when the automatic reply policy changes',async()=>{
    const plan=await scope(()=>prepareCampaignDelivery(12,9,accounts));
    execute.mockImplementation(async(query:SQL)=>({rows:dialect.sqlToQuery(query).sql.includes('FROM outreach_campaigns')
      ? [{...campaign,settings:{...campaign.settings,replyPolicy:{autoSend:true}}}] : sequences}));
    expect((await scope(()=>prepareCampaignDelivery(12,9,accounts))).reviewHash).not.toBe(plan.reviewHash);
  });
  it('pins exact accounts and personalized recipients while email/SMS step one have distinct queue keys',async()=>{
    const plan=await scope(()=>prepareCampaignDelivery(12,9,accounts));
    expect(plan.jobs).toHaveLength(6);
    const email=plan.jobs.find(job=>job.leadId===73&&job.messageType==='email'&&job.stepNumber===1)!;
    const sms=plan.jobs.find(job=>job.leadId===73&&job.messageType==='sms')!;
    expect(email.sequenceStepKey).not.toBe(sms.sequenceStepKey);
    expect(email).toMatchObject({content:'Hello Engines',subject:'Hi Ada',deliveryReview:{senderId:7,providerAccountId:'mailbox',recipient:'73@example.test'}});
    expect(sms.deliveryReview).toMatchObject({providerAccountId:'sms-account',recipient:'919876543273'});
    expect(timing).toHaveBeenCalledWith(undefined,[{delayMinutes:4320,message:'Hello again',subject:'Follow-up'}]);
  });
  it('requires an explicit account and refuses historical paused deliveries',async()=>{
    await expect(scope(()=>prepareCampaignDelivery(12,9,{email:{},sms:accounts.sms}))).rejects.toThrow(/exact sending account/);
    execute.mockResolvedValueOnce({rows:[{...campaign,settings:{...campaign.settings,accountReviewRequired:true}}]});
    await expect(scope(()=>prepareCampaignDelivery(12,9,accounts))).rejects.toThrow(/Historical/);
  });
  it('skips current opt-outs without changing the saved selection and rejects foreign/deleted recipients',async()=>{
    recipients.mockImplementation(async(_user:number,channel:string)=>({recipients:[lead(73,channel),{...lead(74,channel),eligible:false,reason:'Opted out'}]}));
    const plan=await scope(()=>prepareCampaignDelivery(12,9,accounts));
    expect(plan.jobs.every(job=>job.leadId===73)).toBe(true); expect(plan.skipped).toHaveLength(2);
    recipients.mockResolvedValue({recipients:[lead(73,'email')]});
    await expect(scope(()=>prepareCampaignDelivery(12,9,accounts))).rejects.toThrow(/outside this business/);
  });
  it('invalidates review when recipients, content or account change and is stable for immediate previews',async()=>{
    const plan=await scope(()=>prepareCampaignDelivery(12,9,accounts));
    expect((await scope(()=>prepareCampaignDelivery(12,9,accounts))).reviewHash).toBe(plan.reviewHash);
    recipients.mockImplementation(async(_user:number,channel:string,_selection:unknown,query:{ids:number[]})=>({recipients:query.ids.map(id=>({...lead(id,channel),company:'Changed'}))}));
    expect((await scope(()=>prepareCampaignDelivery(12,9,accounts))).reviewHash).not.toBe(plan.reviewHash);
    const job={...plan.jobs[0],id:1,status:'pending' as const,retryCount:0,createdAt:new Date(),updatedAt:new Date()};
    await expect(scope(()=>assertCampaignJobReview({...job,content:'Altered'}))).rejects.toBeInstanceOf(CampaignDeliveryReviewError);
    resolveAccount.mockResolvedValue({account:{ready:true,providerAccountId:'changed',senderId:7}});
    await expect(scope(()=>assertCampaignJobReview(job))).rejects.toThrow(/sending account changed/);
  });
  it('rechecks exact recipient address and consent at worker time',async()=>{
    const plan=await scope(()=>prepareCampaignDelivery(12,9,accounts));
    const job={...plan.jobs[0],id:1,status:'pending' as const,retryCount:0,createdAt:new Date(),updatedAt:new Date()};
    recipients.mockResolvedValue({recipients:[{...lead(73,'email'),recipient:'changed@example.test'}]});
    await expect(scope(()=>assertCampaignJobReview(job))).rejects.toThrow(/recipient changed/);
    recipients.mockResolvedValue({recipients:[{...lead(73,'email'),eligible:false,reason:'Opted out'}]});
    await expect(scope(()=>assertCampaignJobReview(job))).rejects.toThrow(/no longer eligible/);
  });
  it('rejects ambiguous/nonincreasing sequence schedules and unsupported channels',async()=>{
    execute.mockImplementation(async(query:SQL)=>({rows:dialect.sqlToQuery(query).sql.includes('FROM outreach_campaigns')?[campaign]:[{...sequences[0],steps:[{day:3,body:'First'},{day:3,body:'Second'}]},sequences[1]]}));
    await expect(scope(()=>prepareCampaignDelivery(12,9,accounts))).rejects.toThrow(/times must increase/);
    execute.mockResolvedValueOnce({rows:[{...campaign,campaign_type:'instagram'}]});
    await expect(scope(()=>prepareCampaignDelivery(12,9,accounts))).rejects.toThrow(/email and SMS only/);
  });
  it('invalidates the review hash when a sender From address changes within the same provider domain',async()=>{
    const plan=await scope(()=>prepareCampaignDelivery(12,9,accounts));
    resolveAccount.mockImplementation(async(_user:number,channel:string)=>({account:{ready:true,providerAccountId:channel==='email'?'mailbox':'sms-account',senderId:channel==='email'?7:undefined,label:channel==='email'?'changed@example.test':channel},binding:{credentialId:77}}));
    expect((await scope(()=>prepareCampaignDelivery(12,9,accounts))).reviewHash).not.toBe(plan.reviewHash);
    const job={...plan.jobs[0],id:1,status:'pending' as const,retryCount:0,createdAt:new Date(),updatedAt:new Date()};
    await expect(scope(()=>assertCampaignJobReview(job))).rejects.toThrow(/sending account changed/);
  });

});
