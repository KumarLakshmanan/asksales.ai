import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// Exercise the registered queue processor, with every queue, account, provider,
// subscription, attachment and persistence boundary replaced locally.
const processors = new Map<string, (job: Job) => Promise<unknown>>();
const queueNames = new Proxy({}, { get: (_target, key) => String(key) });
const noop = async () => {};
let syntheticConsumersRunning = true;
jest.unstable_mockModule('bullmq', () => ({ DelayedError, UnrecoverableError, Worker: class {
  constructor(name: string, processor: (job: Job) => Promise<unknown>) { processors.set(name, processor); }
  on() { return this; }
  waitUntilReady = noop;
  isRunning = () => syntheticConsumersRunning;
  isPaused = () => false;
  close = noop;
} }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => ({}) }));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: { initialize: noop, close: noop, publish: noop }, EVENT_CHANNELS: {} }));
jest.unstable_mockModule('../queues/index.js', () => ({ QUEUE_NAMES: queueNames, QUEUE_LIMITERS: {},
  queueRegistry: { initialize: noop, addRepeatableJob: noop, close: noop } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ createWorkerLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.unstable_mockModule('../tenancy/jobBusinessScope.js', () => ({
  runBusinessJob: (data: unknown, work: (data: unknown) => Promise<unknown>) => work(data),
}));
jest.unstable_mockModule('../services/subscriptions/service.js', () => ({ requireSubscriptionForOperation: noop }));
jest.unstable_mockModule('../tools/outreachSender.js', () => ({ outreachSenderWorker: { start: noop, stop: noop } }));
jest.unstable_mockModule('../workers/NotificationEventConsumer.js', () => ({ notificationEventConsumer: { start: noop, stop: noop } }));

const dialect = new PgDialect();
const update = jest.fn<(...args: unknown[]) => Promise<void>>();
const send = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const refund = jest.fn<(...args: unknown[]) => Promise<void>>();
const activate = jest.fn<(...args: unknown[]) => Promise<boolean>>();
const updateConversation = jest.fn<(...args: unknown[]) => Promise<void>>();
let persisted: Record<string, unknown>;
let claimed: boolean;
let preparedMetadata: Record<string,unknown> = {};
let quotaAvailable=true, conversationChannel='email';
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: async (query: SQL) => {
  const text = dialect.sqlToQuery(query).sql;
  if (text.includes('UPDATE outreach_messages om')) {
    if (claimed) return { rows: [] };
    claimed = true;
    return { rows: [{ id: 101, provider_account_id: 'sender@example.test' }] };
  }
  if (text.includes('SELECT om.status')) return { rows: [persisted] };
  return { rows: [{ id: 101 }] };
} } }));
jest.unstable_mockModule('../models/index.js', () => ({ OutreachConversationModel: {
  updateOutreachMessageStatus: update,
  updateOutreachConversation: updateConversation,
  getOutreachConversationById: async () => ({ id: 58, userId: 12, channel: conversationChannel, providerAccountId:'sender@example.test', integrationProvider: 'gmail' }),
  getOutreachMessageById: async () => ({ id: 101, conversationId: 58, metadata:preparedMetadata, confirmationExpiresAt:new Date(Date.now()+30*86_400_000) }),
  getMessagesByConversationId: async () => [],
} }));
jest.unstable_mockModule('../services/outreach/ProviderBindingService.js', () => ({
  inspectOfficialProviderBinding: async () => ({ binding: { providerAccountId: 'sender@example.test' }, missing: [] }),
}));
jest.unstable_mockModule('../services/outreach/CreationFollowUpService.js', () => ({
  checkCreationDelivery: async () => null, activateCreationFollowUps: activate,
}));
jest.unstable_mockModule('../services/OutreachAttachmentService.js', () => ({ outreachAttachmentService: {
  getEmailAttachments: async () => [], markDelivery: noop,
} }));
jest.unstable_mockModule('../services/CreditService.js', () => ({ creditService: {
  reserveOutreachCredit: async () => ({ success: true, transactionId: 88 }), refundDeduction: refund,
} }));
jest.unstable_mockModule('../services/emailService.js', () => ({ emailService: { sendEmailWithUserCredentials: send } }));
jest.unstable_mockModule('../services/outreach/QuotaService.js',()=>({withCreationDailyQuota:async(_user:unknown,_channel:unknown,work:any)=>quotaAvailable ? work({execute:async()=>({rows:[{id:101}]})}) : null,getEffectiveDailyLimit:async()=>20}));
jest.unstable_mockModule('../services/whatsappApiService.js',()=>({whatsappApiService:{sendText:send,sendTemplate:send}}));
jest.unstable_mockModule('../services/instagramService.js',()=>({sendInstagramDM:send}));
jest.unstable_mockModule('../services/FacebookMessengerService.js',()=>({sendFacebookDM:send}));
jest.unstable_mockModule('../services/smsService.js',()=>({sendSMS:send}));
const { startAllWorkers, stopAllWorkers, workersAreReady } = await import('../workers/index.js');
const run = () => processors.get('OUTREACH')!({ name: 'send_outreach_message', id: 'fixture-job',
  data: { userId: 12, messageId: 101, conversationId: 58, channel: 'email',
    recipientEmail: 'recipient@example.test', message: 'Synthetic reviewed email', subject: 'Fixture' },
} as unknown as Job);

describe('queued email authoritative outcome persistence', () => {
  beforeAll(startAllWorkers);
  afterAll(stopAllWorkers);
  it('reports readiness only while required queue consumers are running', () => {
    expect(workersAreReady()).toBe(true);
    syntheticConsumersRunning = false;
    expect(workersAreReady()).toBe(false);
    syntheticConsumersRunning = true;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    claimed = false;
    preparedMetadata={};quotaAvailable=true;conversationChannel="email";
    persisted = {};
    activate.mockResolvedValue(true);
    updateConversation.mockResolvedValue(undefined);
    update.mockImplementation(async (_id, status, evidence) => {
      const data = evidence as { providerCallState?: string; manualReviewRequired?: boolean; providerMessageId?: string };
      persisted = { status, provider_call_state: data?.providerCallState,
        manual_review_required: data?.manualReviewRequired, provider_message_id: data?.providerMessageId };
    });
  });

  it('retains acceptance when thread bookkeeping fails, and queue retry does not resend', async () => {
    send.mockResolvedValue({ success: true, providerMessageId: 'native-id', messageId: '<rfc@example.test>', threadId: 'thread-id' });
    updateConversation.mockRejectedValueOnce(new Error('Synthetic thread mapping failure'));
    await run();
    expect(update).toHaveBeenLastCalledWith(101, 'sent', expect.objectContaining({ providerCallState: 'confirmed', providerMessageId: 'native-id' }));
    expect(refund).not.toHaveBeenCalled();
    await run();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { result: { success: true, providerMessageId: 'native-id', messageId: '<rfc@example.test>', outcomeUncertain: false }, status: 'sent', state: 'confirmed', refund: false },
    { result: { success: false, error: 'Synthetic rejection', deliveryAttempted: true, outcomeUncertain: false }, status: 'failed', state: 'rejected', refund: true },
    { result: { success: false, error: 'Synthetic preflight failure', deliveryAttempted: false, outcomeUncertain: false }, status: 'failed', state: 'not_started', refund: true },
    { result: { success: false, error: 'Synthetic timeout', deliveryAttempted: true, outcomeUncertain: true }, status: 'manual_review', state: 'unknown', refund: false },
    { result: { success: true, rfcMessageId: '<generated@example.test>' }, status: 'manual_review', state: 'unknown', refund: false },
  ])('persists $status/$state and suppresses duplicate queue delivery', async fixture => {
    send.mockResolvedValue(fixture.result);
    await run();
    expect(update).toHaveBeenLastCalledWith(101, fixture.status,
      expect.objectContaining({ providerCallState: fixture.state, manualReviewRequired: fixture.status === 'manual_review' }));
    expect(refund).toHaveBeenCalledTimes(fixture.refund ? 1 : 0);
    await run();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(12, expect.objectContaining({ idempotencyKey: 'outreach-message-12-101' }), undefined);
    expect(activate).toHaveBeenCalledTimes(fixture.status === 'sent' ? 2 : 0);
  });
  const providerJob=(channel:string)=>({name:'send_outreach_message',id:'fixture-provider',token:'fixture-token',opts:{attempts:3},attemptsMade:0,
    data:{userId:12,messageId:101,conversationId:58,channel,message:'Reviewed offer',phone:'+919999999999',handle:'synthetic-igsid',facebookId:'synthetic-psid',templateName:'approved_fixture'},
    updateData:jest.fn<any>().mockResolvedValue(undefined),moveToDelayed:jest.fn<any>().mockResolvedValue(undefined)});
  it.each(['whatsapp','instagram','facebook','sms'])('delays an explicitly rejected %s attempt and releases its credit reservation',async channel=>{
    conversationChannel=channel;const job=providerJob(channel);
    if(channel==='whatsapp')send.mockRejectedValue(Object.assign(new Error('Rate limited'),{code:130429,retryable:true,deliveryAttempted:true,outcomeUncertain:false}));
    else send.mockResolvedValue({success:false,error:'Rate limited',retryable:true,deliveryAttempted:true,outcomeUnknown:false,outcomeUncertain:false});
    await expect(processors.get('OUTREACH')!(job as unknown as Job)).rejects.toBeInstanceOf(DelayedError);
    expect(refund).toHaveBeenCalledTimes(1);expect(job.moveToDelayed).toHaveBeenCalled();
    expect(update).toHaveBeenLastCalledWith(101,'pending',expect.objectContaining({providerCallState:'not_started',manualReviewRequired:false}));
  });
  it('keeps daily capacity exhaustion queued without calling a provider',async()=>{
    conversationChannel='whatsapp';preparedMetadata={outreachCreation:{version:1}};quotaAvailable=false;
    const job=providerJob('whatsapp');await expect(processors.get('OUTREACH')!(job as unknown as Job)).rejects.toBeInstanceOf(DelayedError);
    expect(send).not.toHaveBeenCalled();expect(refund).toHaveBeenCalledTimes(1);expect(job.moveToDelayed).toHaveBeenCalled();
  });
  it('defers a local WhatsApp limiter rejection on the existing message, refunds the credit and preserves the provider budget',async()=>{
    conversationChannel='whatsapp';const job=providerJob('whatsapp');Object.assign(job.data,{providerRateLimitRetries:4});
    send.mockRejectedValue(Object.assign(new Error('App capacity'),{code:'WHATSAPP_APP_RATE_LIMIT',retryable:true,deliveryAttempted:false,outcomeUncertain:false,retryAfterMs:61_000}));
    await expect(processors.get('OUTREACH')!(job as unknown as Job)).rejects.toBeInstanceOf(DelayedError);
    expect(refund).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledTimes(1);expect(job.updateData).not.toHaveBeenCalled();expect(job.moveToDelayed).toHaveBeenCalled();
    expect(update).toHaveBeenLastCalledWith(101,'pending',expect.objectContaining({providerCallState:'not_started',manualReviewRequired:false,sendClaimedAt:null}));
  });
  it('enforces the persisted cooldown even after a lost delayed-job acknowledgement',async()=>{
    conversationChannel='whatsapp';const due=Date.now()+86_400_000;preparedMetadata={outreachQueue:{nextAttemptAt:new Date(due).toISOString()}};
    const job=providerJob('whatsapp');await expect(processors.get('OUTREACH')!(job as unknown as Job)).rejects.toBeInstanceOf(DelayedError);
    expect(send).not.toHaveBeenCalled();expect(refund).not.toHaveBeenCalled();expect(job.moveToDelayed).toHaveBeenCalledWith(due,'fixture-token');
  });
  it('does not retry an uncertain WhatsApp provider timeout',async()=>{
    conversationChannel='whatsapp';const job=providerJob('whatsapp');send.mockRejectedValue(Object.assign(new Error('Timeout'),{retryable:true,deliveryAttempted:true,outcomeUncertain:true}));
    await processors.get('OUTREACH')!(job as unknown as Job);
    expect(job.moveToDelayed).not.toHaveBeenCalled();expect(refund).not.toHaveBeenCalled();expect(persisted.status).toBe('manual_review');
  });

});
