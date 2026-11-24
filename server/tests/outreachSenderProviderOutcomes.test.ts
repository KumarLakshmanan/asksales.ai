import { installReadyCustomerDeliveryMock, readyDeliveryReceipt } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { OutreachJob } from '../tools/outreachSender.js';

const execute = jest.fn<any>();
const sendEmail = jest.fn<any>();
const sendSMS = jest.fn<any>();
const reserve = jest.fn<any>();
const refund = jest.fn<any>();
const reconcile = jest.fn<any>();
const createSentMessage = jest.fn<any>();
jest.unstable_mockModule('../services/outreach/QuotaService.js',()=>({withCreationDailyQuota:async(_user:unknown,_channel:unknown,work:any)=>work({execute})}));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/emailService.js', () => ({ emailService: { sendEmailWithUserCredentials: sendEmail } }));
jest.unstable_mockModule('../services/smsService.js', () => ({ sendSMS }));
jest.unstable_mockModule('../services/CreditService.js', () => ({ creditService: { reserveOutreachCredit: reserve, refundDeduction: refund } }));
jest.unstable_mockModule('../models/sentMessages/functions.js', () => ({ SentMessageModel: { create: createSentMessage } }));
jest.unstable_mockModule('../services/outreach/OutreachJobCampaignService.js', () => ({ reconcileOutreachJobCampaign: reconcile, reconcilePendingOutreachJobCampaigns: jest.fn() }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const account=jest.fn<any>(), recipients=jest.fn<any>();
jest.unstable_mockModule('../services/outreach/CreationService.js',()=>({resolveCreationAccount:account,getCreationRecipients:recipients,validateOutreachTiming:jest.fn()}));
const {campaignMessageHash}=await import('../services/outreach/CampaignDeliveryService.js');
const { OutreachSenderWorker } = await import('../tools/outreachSender.js');
const dialect = new PgDialect();
const queries: ReturnType<typeof dialect.sqlToQuery>[] = [];
const now = new Date('2026-09-05T00:00:00Z');
const job: OutreachJob = {
  id: 14, campaignId: 9, sequenceId: 5, leadId: 73, userId: 12, stepNumber: 1,
  messageType: 'email', content: 'Reviewed test message', subject: 'Reviewed subject',
  deliveryReview:{version:1,assistant:readyDeliveryReceipt,channel:'email',senderId:7,fromEmail:'sales@example.test',providerCredentialId:77,providerAccountId:'mailbox',recipient:'fake@example.test',stepNumber:1,contentHash:campaignMessageHash('email','fake@example.test','Reviewed subject','Reviewed test message')},
  status: 'pending', scheduledFor: now, retryCount: 0, maxRetries: 1, createdAt: now, updatedAt: now,
};
const process = (value = job) => {
  const worker = new OutreachSenderWorker() as unknown as { processJob(job: OutreachJob): Promise<void> };
  return worker.processJob(value);
};

describe('outreach sender with fake providers', () => {
  it('preserves Gmail cooldown when scheduling a rejected campaign message and refunds its credit', async () => {
    const retryAt = new Date(Date.now() + 7200_000).toISOString();
    sendEmail.mockResolvedValue({ success: false, error: 'User-rate limit exceeded', retryable: true, retryAt, deliveryAttempted: true, outcomeUncertain: false });
    await process();
    const pending = queries.find(query => query.sql.includes('scheduled_for = CASE WHEN'));
    expect(pending?.params).toContain(retryAt);
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 88 }));
    expect(createSentMessage).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    queries.length = 0;
    account.mockImplementation(async(_user:number,channel:string)=>({account:{ready:true,providerAccountId:channel==='email'?'mailbox':'sms-account',senderId:channel==='email'?7:undefined,label:'sales@example.test'},binding:{credentialId:77}}));
    recipients.mockImplementation(async(_user:number,channel:string)=>({recipients:[{id:73,eligible:true,recipient:channel==='email'?'fake@example.test':'+15550000000'}]}));
    let claimed = false;
    execute.mockImplementation(async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      queries.push(compiled);
      if (compiled.sql.includes("SET status = 'processing'")) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: job.id }] };
      }
      if (compiled.sql.includes('RETURNING id') || compiled.sql.includes('SELECT id FROM outreach_campaigns')) return { rows: [{ id: job.id }] };
      if (compiled.sql.includes('FROM leads')) return { rows: [{ email: 'fake@example.test', phone: '+15550000000', full_name: 'Test Lead' }] };
      return { rows: [] };
    });
    reserve.mockResolvedValue({ success: true, transactionId: 88 });
    refund.mockResolvedValue({ success: true });
    sendEmail.mockResolvedValue({ success: true, messageId: 'fake-email-receipt' });
    sendSMS.mockResolvedValue({ success: true, messageId: 'fake-sms-receipt' });
    reconcile.mockResolvedValue({ status: 'completed' });
    createSentMessage.mockResolvedValue({ id: 1 });
  });

  it('passes the exact approved lead/campaign IDs and persists the provider receipt', async () => {
    await process();
    expect(sendEmail).toHaveBeenCalledWith(12,expect.objectContaining({to:'fake@example.test',subject:'Reviewed subject',html:'<p>Reviewed test message</p>',text:'Reviewed test message',leadId:73,campaignId:9,sequenceStep:1,skipCreditDeduction:true,idempotencyKey:'outreach-job:14',expectedFromEmail:'sales@example.test',expectedProviderAccountId:'mailbox',expectedCredentialId:77}),7);
    const successWrite = queries.find((query) => query.sql.includes("SET status = 'sent'"));
    expect(successWrite?.params).toContain('fake-email-receipt');
    expect(reconcile).toHaveBeenLastCalledWith(9, 12);
    expect(refund).not.toHaveBeenCalled();
  });

  it('an already claimed job cannot call the provider twice', async () => {
    await process();
    await process();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('records definitive provider rejection without claiming sent', async () => {
    sendEmail.mockResolvedValue({ success: false, error: 'Address rejected',deliveryAttempted:true,outcomeUncertain:false });
    await process();
    expect(queries.some((query) => query.sql.includes("SET status = 'sent'"))).toBe(false);
    expect(queries.find((query) => query.sql.includes('attempts = attempts + 1'))?.params).toContain('failed');
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({ userId: 12, transactionId: 88 }));
    expect(reconcile).toHaveBeenLastCalledWith(9, 12);
  });

  it.each(['missing receipt', 'interrupted provider call'])('requires manual review after %s, without automatic resend/refund', async (kind) => {
    if (kind === 'missing receipt') sendEmail.mockResolvedValue({ success: true });
    else sendEmail.mockRejectedValue(new Error('Connection interrupted after request'));
    await process();
    expect(queries.some((query) => query.sql.includes("SET status = 'sent'"))).toBe(false);
    expect(queries.some((query) => query.params.some((value) => typeof value === 'string' && value.includes('"manualReviewRequired":true')))).toBe(true);
    expect(refund).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenLastCalledWith(9, 12);
  });

  it('records SMS acceptance as sent, never delivered', async () => {
    await process({ ...job, messageType: 'sms', deliveryReview:{version:1,assistant:readyDeliveryReceipt,channel:'sms',providerCredentialId:77,providerAccountId:'sms-account',recipient:'+15550000000',stepNumber:1,contentHash:campaignMessageHash('sms','+15550000000','Reviewed subject','Reviewed test message')} });
    expect(sendSMS).toHaveBeenCalledWith(12, '+15550000000', 'Reviewed test message',undefined,'sms-account');
    expect(createSentMessage).toHaveBeenCalledWith(expect.objectContaining({
      leadId: 73, userId: 12, campaignId: 9, messageId: 'fake-sms-receipt', deliveryStatus: 'sent',
    }), { skipCreditDeduction: true });
  });

  it('keeps uncertain MSG91 outcomes in manual review without retry or refund', async () => {
    sendSMS.mockResolvedValueOnce({ success: false, error: 'MSG91 timeout', deliveryAttempted: true, outcomeUncertain: true });
    await process({ ...job, messageType: 'sms', deliveryReview:{version:1,assistant:readyDeliveryReceipt,channel:'sms',providerCredentialId:77,providerAccountId:'sms-account',recipient:'+15550000000',stepNumber:1,contentHash:campaignMessageHash('sms','+15550000000','Reviewed subject','Reviewed test message')} });
    expect(refund).not.toHaveBeenCalled();
    expect(createSentMessage).not.toHaveBeenCalled();
    expect(queries.some(query => query.params.some(value => typeof value === 'string' && value.includes('"manualReviewRequired":true')))).toBe(true);
  });

  it('refunds a rejected MSG91 request without recording it as sent', async () => {
    sendSMS.mockResolvedValueOnce({ success: false, error: 'Template rejected', deliveryAttempted: true, outcomeUncertain: false });
    await process({ ...job, messageType: 'sms', deliveryReview:{version:1,assistant:readyDeliveryReceipt,channel:'sms',providerCredentialId:77,providerAccountId:'sms-account',recipient:'+15550000000',stepNumber:1,contentHash:campaignMessageHash('sms','+15550000000','Reviewed subject','Reviewed test message')} });
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 88, userId: 12 }));
    expect(createSentMessage).not.toHaveBeenCalled();
    expect(queries.some(query => query.sql.includes("SET status = 'sent'"))).toBe(false);
  });
  it('blocks unreviewed or changed-account jobs before reserving credits or contacting providers',async()=>{
    await process({...job,deliveryReview:undefined});
    expect(reserve).not.toHaveBeenCalled(); expect(sendEmail).not.toHaveBeenCalled();
    expect(queries.some(query=>query.params.includes('setup_required'))).toBe(true);
    expect(queries.some(query=>query.params.some(value=>typeof value==='string'&&value.includes('"customerDeliverySetup"')))).toBe(true);
  });
  it('requires the preceding confirmed sequence receipt before a later message can send',async()=>{
    await process({...job,stepNumber:2,deliveryReview:{...job.deliveryReview!,stepNumber:2}});
    expect(reserve).not.toHaveBeenCalled(); expect(sendEmail).not.toHaveBeenCalled();
    expect(queries.some(query=>query.params.includes('The preceding sequence message has no confirmed receipt. Review before continuing.'))).toBe(true);
  });

  it('stops uncertain email outcomes for manual review without refund or requeue',async()=>{
    sendEmail.mockResolvedValue({success:false,error:'Email timeout after request',deliveryAttempted:true,outcomeUncertain:true});
    await process(); expect(refund).not.toHaveBeenCalled();
    expect(queries.some(query=>query.params.some(value=>typeof value==='string'&&value.includes('"manualReviewRequired":true')))).toBe(true);
    expect(queries.some(query=>query.sql.includes('SET status = \'pending\''))).toBe(false);
    expect(queries.some(query=>query.sql.includes("SET status = 'failed'")&&query.sql.includes('is_dead_letter = true'))).toBe(true);
  });
  it('dispatches the immutable reviewed address directly when current lead data differs',async()=>{
    execute.mockImplementation(async(query:SQL)=>{
      const compiled=dialect.sqlToQuery(query);queries.push(compiled);
      if(compiled.sql.includes("SET status = 'processing'"))return {rows:[{id:job.id}]};
      if(compiled.sql.includes('RETURNING id') || compiled.sql.includes('SELECT id FROM outreach_campaigns'))return {rows:[{id:job.id}]};
      if(compiled.sql.includes('FROM leads'))return {rows:[{email:'changed-after-review@example.test',full_name:'Changed'}]};
      return {rows:[]};
    });
    await process(); expect(sendEmail).toHaveBeenCalledWith(12,expect.objectContaining({to:'fake@example.test',text:'Reviewed test message'}),7);
  });

  it.each(['customer reply','newer outbound'])('stops a later sequence message after %s before credit reservation',async(kind)=>{
    execute.mockImplementation(async(query:SQL)=>{
      const compiled=dialect.sqlToQuery(query);queries.push(compiled);
      if(compiled.sql.includes("SET status = 'processing'"))return {rows:[{id:job.id}]};
      if(compiled.sql.includes('RETURNING id') || compiled.sql.includes('SELECT id FROM outreach_campaigns'))return {rows:[{id:job.id}]};
      if(compiled.sql.includes('FROM leads'))return {rows:[{email:'fake@example.test',full_name:'Test Lead'}]};
      if(compiled.sql.includes('SELECT id,status,metadata FROM outreach_jobs'))return {rows:[{id:13,status:'sent'}]};
      if(kind==='customer reply'&&compiled.sql.includes("message.direction='inbound'"))return {rows:[{exists:1}]};
      if(kind==='newer outbound'&&compiled.sql.includes("message.direction='outbound'"))return {rows:[{exists:1}]};
      return {rows:[]};
    });
    await process({...job,stepNumber:2,deliveryReview:{...job.deliveryReview!,stepNumber:2}});
    expect(reserve).not.toHaveBeenCalled();expect(sendEmail).not.toHaveBeenCalled();
    expect(queries.some(query=>query.params.includes('cancelled'))).toBe(true);
  });

});
