import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import {beforeEach,describe,expect,it,jest} from '@jest/globals';
import {PgDialect} from 'drizzle-orm/pg-core';
import {withBusinessScope} from '../tenancy/businessContext.js';
import {AUTOMATION_TRIGGERS,legacyAutomationDefinition,matchAutomation,renderAutomationJson,renderAutomationText,resolveAutomationRecipient,sampleAutomationEvent,validateAutomationDefinition,type AutomationAction,type AutomationDefinition} from '../../shared/crmAutomations.js';
import {DEFAULT_CRM_CONFIGURATION} from '../../shared/crmConfiguration.js';

let disconnected=false,optedOut=false;
const execute=jest.fn<(...args:unknown[])=>Promise<{rows:unknown[]}>>();
const dialect=new PgDialect();
const send=jest.fn(),webhook=jest.fn(),bill=jest.fn(),write=jest.fn();
jest.unstable_mockModule('../models/db.js',()=>({db:{execute,insert:write,update:write,transaction:write}}));
jest.unstable_mockModule('../services/SecretsManager.js',()=>({encryptValue:(value:string)=>Buffer.from(value).toString('base64'),decryptValue:(value:string)=>Buffer.from(value,'base64').toString()}));
jest.unstable_mockModule('../services/CRMConfigurationService.js',()=>({getCrmConfiguration:async()=>({...DEFAULT_CRM_CONFIGURATION,stages:[...DEFAULT_CRM_CONFIGURATION.stages,{key:'qualified_custom',label:'Qualified',color:'#987123',type:'active',inFlow:true}]})}));
jest.unstable_mockModule('../services/outreach/CreationService.js',()=>({
  getCreationOptions:async(_user:number,channel:string)=>({accounts:[{senderId:channel==='email' ? 7 : undefined,providerAccountId:`${channel}-account`,label:channel,ready:!disconnected,reason:disconnected ? 'Disconnected sender' : null}]}),
  resolveCreationAccount:async(_user:number,channel:string,selection:{senderId?:number;providerAccountId?:string})=>({account:{senderId:selection.senderId,providerAccountId:`${channel}-account`,ready:!disconnected,reason:'Disconnected sender'},binding:disconnected ? null : {accountId:'bound'}}),
  validateCreationTemplate:()=> 'Hello Alex',
}));
jest.unstable_mockModule('../models/channelCredentials/functions.js',()=>({ChannelCredentialModel:{findActiveAccountByIdentifier:async()=>({accountIdentifier:'SMSAPP',sessionData:{flowId:'flow-1'},isActive:!disconnected})}}));
jest.unstable_mockModule('../utils/msg91Credentials.js',()=>({inspectMSG91Credential:()=>({settings:{senderId:'SMSAPP',flowId:'flow-1'},ready:!disconnected,issue:disconnected ? 'Disconnected sender' : null})}));
jest.unstable_mockModule('../utils/channelCredentialSecrets.js',()=>({decryptChannelCredentialSession:(value:unknown)=>value}));
jest.unstable_mockModule('../services/whatsappApiService.js',()=>({whatsappApiService:{sendTemplate:send,listApprovedTemplates:send}}));
jest.unstable_mockModule('../services/emailService.js',()=>({emailService:{sendEmailWithUserCredentials:send}}));
jest.unstable_mockModule('../services/smsService.js',()=>({sendSMS:send}));
jest.unstable_mockModule('../services/CreditService.js',()=>({creditService:{deductOnceForResource:bill}}));
jest.unstable_mockModule('../utils/safeRemoteFetch.js',()=>({fetchPublicHttpUrl:webhook,assertPublicHttpUrl:async(value:string)=>new URL(value)}));
const {previewAutomation,publicAutomationDefinition,protectAutomationDefinition,automationWebhookHeaders,automationTemplateHash,legacyAutomationEvaluationAllowed}=await import('../services/automations/AutomationConfiguration.js');
const inProfile=<T>(work:()=>T)=>withBusinessScope({userId:9,businessProfileId:101},work);
const definition=(action:AutomationAction):AutomationDefinition=>({version:2,trigger:{type:'pipeline_status_change',config:{toStatus:'qualified_custom'}},conditions:{match:'all',rules:[]},actions:[action]});
const notification=(channel:string,mode:string):AutomationAction=>({id:'notify',type:'send_notification',config:{channel,recipient:{mode,...(mode==='fixed' ? {value:channel==='email' ? 'manager@example.test' : '+919876543210'} : {})},
  ...(channel==='email' ? {senderId:7,subject:'{{contact.name}} qualified',message:'Stage: {{contact.pipelineStatus}}'} : channel==='sms' ? {providerAccountId:'SMSAPP',flowId:'flow-1',message:'Hello {{contact.name}}'}
    : {providerAccountId:'whatsapp-account',templateId:12,language:'en',variables:{'body:1':'{{contact.name}}'}})}});

describe('CRM visual automation contracts and side-effect-free preview',()=>{
  beforeEach(()=>{
    disconnected=false;optedOut=false;jest.clearAllMocks();
    execute.mockImplementation(async(statement)=>{
      const query=dialect.sqlToQuery(statement as Parameters<typeof dialect.sqlToQuery>[0]).sql;
      if (query.includes('FROM crm_automation_runtime')) return {rows:[{enabled:true}]};
      if (query.includes('FROM outreach_campaigns')) return {rows:[{id:4,name:'Launch'}]};
      if (query.includes('business_profile_memberships')) return {rows:[{id:9,name:'Owner'}]};
      if (query.includes('FROM whatsapp_templates')) return {rows:[{id:12,name:'hello',language:'en',body:'Hello {{1}}',header_type:'TEXT',waba_template_id:'meta-12',meta_status:'APPROVED',status:'APPROVED',has_local_changes:false}]};
      if (query.includes('SELECT id,account_identifier')) return {rows:[{account_identifier:'SMSAPP',account_name:'Alerts'}]};
      if (query.includes('SELECT session_data')) return {rows:[{session_data:{flowId:'flow-1'}}]};
      return {rows:optedOut ? [{blocked:true}] : []};
    });
  });
  it('retains legacy step configuration and ignores the old Any stage sentinel',()=>{
    const old={triggerType:'pipeline_status_change',triggerConfig:{fromStatus:'any',toStatus:'qualified_custom'},action:'create_ticket',actionConfig:{subject:'Preserved',priority:'urgent'}};
    const converted=legacyAutomationDefinition(old);
    expect(converted.trigger.config).toEqual({toStatus:'qualified_custom'});expect(converted.actions[0].config).toEqual(old.actionConfig);
    expect(validateAutomationDefinition(converted)).toEqual([]);
  });
  it('supports All/Any groups, empty groups, account/campaign filters, and missing-field exclusion',()=>{
    const event=sampleAutomationEvent('pipeline_status_change');event.context.event!.newValue='qualified_custom';
    const rule=definition({id:'tags',type:'update_tags',config:{tags:['qualified']}});
    expect(matchAutomation(rule,event).matches).toBe(true);
    rule.conditions.rules=[{id:'a',field:'contact.tags',operator:'contains',value:'interested'},{id:'b',field:'message.text',operator:'contains',value:'missing'}];
    expect(matchAutomation(rule,event).matches).toBe(false);rule.conditions.match='any';expect(matchAutomation(rule,event).matches).toBe(true);
    event.origin='automation';expect(matchAutomation(rule,event).matches).toBe(false);event.origin='system';
    rule.trigger.config.accountId='another';expect(matchAutomation(rule,event).matches).toBe(false);
    rule.trigger.config.accountId='sample-account';rule.trigger.config.campaignId=55;expect(matchAutomation(rule,event).matches).toBe(false);
    rule.trigger.config.campaignId=1;expect(matchAutomation(rule,event).matches).toBe(true);
    delete event.context.contact;expect(matchAutomation(rule,event).matches).toBe(false);
  });
  it('rejects duplicate step IDs and actions/recipients that require absent contact context',()=>{
    const rule=definition({id:'same',type:'update_tags',config:{tags:['x']}});rule.actions.push({...rule.actions[0]});expect(validateAutomationDefinition(rule).join()).toContain('unique identifier');
    rule.trigger.type='campaign_started';expect(validateAutomationDefinition(rule).join()).toContain('requires a contact');
    rule.actions=[notification('email','contact')];expect(validateAutomationDefinition(rule).join()).toContain('contact recipient');
    rule.actions=[{...notification('email','fixed'),config:{...notification('email','fixed').config,subject:'Campaign notice',message:'Campaign {{campaign.name}}'}}];expect(validateAutomationDefinition(rule)).toEqual([]);
  });
  it('renders JSON values and rejects unknown or absent placeholders',()=>{
    const context=sampleAutomationEvent('contact_created').context;
    expect(renderAutomationJson({name:'{{contact.name}}',nested:['{{ticket.number}}']},context)).toEqual({name:'Sample contact',nested:['TKT-SAMPLE']});
    expect(()=>renderAutomationText('{{contact.password}}',context)).toThrow('Unsupported');expect(()=>renderAutomationText('{{ticket.number}}',{})).toThrow('does not contain');
    expect(()=>renderAutomationText('{{contact.name',context)).toThrow('syntax');
    const malformed=definition({id:'mail',type:'send_notification',config:{...notification('email','fixed').config,message:'Hello {{contact.name'}});
    expect(validateAutomationDefinition(malformed).join()).toContain('syntax');
  });
  it('never restores the inline evaluator after a cutover is disabled',async()=>{
    execute.mockResolvedValue({rows:[{enabled:false,cutover_at:new Date()}]});
    expect(await inProfile(()=>legacyAutomationEvaluationAllowed())).toBe(false);
  });
  it.each(['email','whatsapp','sms'].flatMap(channel=>['fixed','contact'].map(mode=>[channel,mode])))('previews %s notifications for a %s recipient without operational effects',async(channel,mode)=>{
    const rule=definition(notification(channel,mode));
    if (channel==='whatsapp') rule.actions[0].config.templateHash=automationTemplateHash({id:'meta-12',name:'hello',language:'en',body:'Hello {{1}}',headerType:'TEXT',buttons:[]});
    const event=sampleAutomationEvent(rule.trigger.type);event.context.event!.newValue='qualified_custom';event.context.contact!.pipelineStatus='qualified_custom';
    const result=await inProfile(()=>previewAutomation(9,rule,event));
    expect(result.matches).toBe(true);expect(result.actions[0].ready).toBe(true);expect(result.actions[0].recipient).toBe(mode==='contact' && channel==='email' ? 'contact@example.test' : channel==='email' ? 'manager@example.test' : '+919876543210');
    expect(send).not.toHaveBeenCalled();expect(webhook).not.toHaveBeenCalled();expect(bill).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
  });
  it('shows missing destinations, disconnected senders, and opt-outs as unavailable steps',async()=>{
    const rule=definition(notification('email','contact')),event=sampleAutomationEvent(rule.trigger.type);delete event.context.contact!.email;
    expect((await inProfile(()=>previewAutomation(9,rule,event))).actions[0].error).toContain('no email');
    event.context.contact!.email='contact@example.test';disconnected=true;expect((await inProfile(()=>previewAutomation(9,rule,event))).actions[0].ready).toBe(false);
    disconnected=false;optedOut=true;expect((await inProfile(()=>previewAutomation(9,rule,event))).actions[0].error).toContain('opted out');
  });
  it('enforces international phone numbers and selected-profile custom stages',async()=>{
    const action=notification('sms','fixed');(action.config.recipient as {value:string}).value='9876543210';expect(()=>resolveAutomationRecipient(action.config,{})).toThrow('international');
    const rule=definition({id:'move',type:'update_pipeline_status',config:{pipelineStatus:'other-profile-stage'}});
    await expect(inProfile(()=>previewAutomation(9,rule,sampleAutomationEvent(rule.trigger.type)))).rejects.toThrow('destination pipeline stage');
  });
  it('encrypts and masks webhook headers and retains masked values on edits',async()=>{
    const rule=definition({id:'hook',type:'webhook',config:{url:'https://example.test/hook',headers:{Authorization:'Bearer private'},body:{name:'{{contact.name}}'}}});
    const stored=protectAutomationDefinition(rule),publicRule=publicAutomationDefinition(stored);
    expect(JSON.stringify(stored)).not.toContain('Bearer private');expect(publicRule.actions[0].config.headers).toEqual({Authorization:'__REDACTED__'});
    expect(automationWebhookHeaders(protectAutomationDefinition(publicRule,stored).actions[0])).toEqual({Authorization:'Bearer private'});
    const preview=await inProfile(()=>previewAutomation(9,publicRule,sampleAutomationEvent(rule.trigger.type)));
    expect(JSON.stringify(preview)).not.toContain('private');expect(webhook).not.toHaveBeenCalled();
    const unsafe={...rule,actions:[{...rule.actions[0],config:{...rule.actions[0].config,headers:{'Idempotency-Key':'override'}}}]};
    expect(validateAutomationDefinition(unsafe).join()).toContain('webhook headers');
  });
  it('excludes deferred commerce and follow-gate triggers',()=>{
    expect(AUTOMATION_TRIGGERS.some(item=>/shopify|catalog|follow_gate/.test(item.type))).toBe(false);
  });
});
