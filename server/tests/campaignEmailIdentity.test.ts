import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import { beforeEach,describe,expect,it,jest } from '@jest/globals';
const sender=jest.fn<any>(),getDefault=jest.fn<any>(),binding=jest.fn<any>();
const generate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
// Recipient policy has dedicated PostgreSQL acceptance coverage; this suite isolates the adapter/context contract.
jest.unstable_mockModule('../services/outreach/RecipientSuppressionService.js',()=>({assertRecipientNotSuppressed:async()=>{}}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {
  createProviderForUser: async () => ({ createChatCompletion: generate, defaultModel: 'fixture' }),
} }));
jest.unstable_mockModule('../models/db.js',()=>({db:{execute:jest.fn()}}));
jest.unstable_mockModule('../models/emailSenders/functions.js',()=>({getById:sender,getDefault}));
jest.unstable_mockModule('../services/outreach/ProviderBindingService.js',()=>({resolveOfficialProviderBinding:binding}));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js',()=>({knowledgeGateway:{}}));
// Branded designs need a business scope and are covered by their own suite;
// this suite checks the exact reviewed body that reaches the provider.
jest.unstable_mockModule('../services/EmailDesignService.js',()=>({prepareDesignedEmail:async(_userId:number,html:string)=>html}));
jest.unstable_mockModule('../events/EventBus.js',()=>({eventBus:{}}));
jest.unstable_mockModule('../utils/logger.js',()=>({logger:{info:jest.fn(),warn:jest.fn(),error:jest.fn()}}));
const {emailService}=await import('../services/emailService.js');
const service=emailService as unknown as {sendEmailViaResend:(...args:unknown[])=>Promise<unknown>;sendEmailViaGmailOAuth:(...args:unknown[])=>Promise<unknown>};
const resend=jest.spyOn(service,'sendEmailViaResend'),gmail=jest.spyOn(service,'sendEmailViaGmailOAuth');
const options={to:'reviewed@example.test',subject:'Reviewed subject',html:'<p>Reviewed message</p>',text:'Reviewed message',expectedFromEmail:'sales@example.test',expectedProviderAccountId:'example.test',expectedCredentialId:77};
beforeEach(()=>{jest.clearAllMocks();sender.mockResolvedValue({id:7,type:'resend',email:'sales@example.test',isVerified:true});binding.mockResolvedValue({providerAccountId:'example.test',credentialId:77});resend.mockResolvedValue({success:true,messageId:'fake-receipt'});gmail.mockResolvedValue({success:true,messageId:'fake-gmail-receipt'});});
describe('final campaign email dispatch identity',()=>{
  it('preserves paragraph breaks in generated campaign emails', async () => {
    const body = 'Hi Uma,\n\nHR teams face delays.\n\nBest regards,\nShiv Das';
    generate.mockResolvedValue({ content: JSON.stringify({ subject: 'Formatting test', body }) });
    expect(await emailService.generatePersonalizedEmail({ email: 'recipient@example.test', firstName: 'Uma' }))
      .toEqual({ subject: 'Formatting test', body });
  });

  it.each(['gmail', 'resend'])('preserves plain-text layout when routing through %s', async provider => {
    sender.mockResolvedValue({ id: 7, type: provider, email: 'sales@example.test', credentialId: 77, isVerified: true });
    const text = 'Hi Uma,\n\nHR teams face delays.\n\nBest regards,\nShiv Das';
    expect(await emailService.sendEmailWithUserCredentials(12, {
      to: 'reviewed@example.test', subject: 'Formatting test', html: text, text,
    }, 7)).toMatchObject({ success: true });
    const send = provider === 'gmail' ? gmail : resend;
    expect(send.mock.calls[0][1]).toMatchObject({
      html: '<div>Hi Uma,<br><br>HR teams face delays.<br><br>Best regards,<br>Shiv Das</div>', text,
    });
  });

  it('passes only the immutable reviewed recipient, content and verified sender to the provider',async()=>{
    expect(await emailService.sendEmailWithUserCredentials(12,options,7)).toMatchObject({success:true});
    expect(resend).toHaveBeenCalledWith(12,expect.objectContaining({to:'reviewed@example.test',subject:'Reviewed subject',html:'<p>Reviewed message</p>',text:'Reviewed message',fromEmail:'sales@example.test'}));
    expect(getDefault).not.toHaveBeenCalled();
  });
  it.each(['From changed','credential changed','provider changed','sender missing','not verified','binding lookup failed'])('rejects %s before provider dispatch with definitive no-send evidence',async(kind)=>{
    if(kind==='From changed')sender.mockResolvedValue({id:7,type:'resend',email:'info@example.test',isVerified:true});
    if(kind==='credential changed')binding.mockResolvedValue({providerAccountId:'example.test',credentialId:78});
    if(kind==='provider changed')binding.mockResolvedValue({providerAccountId:'other.example.test',credentialId:77});
    if(kind==='sender missing')sender.mockResolvedValue(undefined);
    if(kind==='not verified')sender.mockResolvedValue({id:7,type:'resend',email:'sales@example.test',isVerified:false});
    if(kind==='binding lookup failed')binding.mockRejectedValue(new Error('Fixture binding unavailable'));
    expect(await emailService.sendEmailWithUserCredentials(12,options,7)).toMatchObject({success:false,deliveryAttempted:false,outcomeUncertain:false});
    expect(resend).not.toHaveBeenCalled();expect(gmail).not.toHaveBeenCalled();expect(getDefault).not.toHaveBeenCalled();
  });
  it('requires the complete reviewed binding and forbids default fallback',async()=>{
    expect(await emailService.sendEmailWithUserCredentials(12,options)).toMatchObject({success:false,deliveryAttempted:false});
    expect(await emailService.sendEmailWithUserCredentials(12,{...options,expectedCredentialId:undefined},7)).toMatchObject({success:false,deliveryAttempted:false});
    expect(sender).not.toHaveBeenCalled();expect(getDefault).not.toHaveBeenCalled();expect(resend).not.toHaveBeenCalled();
  });
  it('preserves the exact reviewed Gmail credential as well as the From mailbox',async()=>{
    sender.mockResolvedValue({id:7,type:'gmail',email:'sales@example.test',credentialId:77,isVerified:true});binding.mockResolvedValue({providerAccountId:'sales@example.test',credentialId:77});
    expect(await emailService.sendEmailWithUserCredentials(12,{...options,expectedProviderAccountId:'sales@example.test'},7)).toMatchObject({success:true});
    expect(gmail).toHaveBeenCalledWith(12,expect.objectContaining({to:'reviewed@example.test',fromEmail:'sales@example.test'}),77);expect(resend).not.toHaveBeenCalled();
  });
});
