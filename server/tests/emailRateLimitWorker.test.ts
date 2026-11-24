import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const send = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const update = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const refund = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const reserve = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const finishEmail = jest.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const statements: string[] = [];
let liveClaim:Record<string,unknown>|undefined;
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const dialect = new PgDialect();
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: log, createWorkerLogger: () => log }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: jest.fn() }));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: { emitToolEvent: async () => {}, publish: async () => {} }, EVENT_CHANNELS: {} }));
jest.unstable_mockModule('../queues/index.js', () => ({ QUEUE_NAMES: {}, QUEUE_LIMITERS: {}, queueRegistry: {} }));
jest.unstable_mockModule('../services/media/QueuedMediaConfig.js', () => ({ queuedMediaConfig: {} }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: async (sql: SQL) => {
  const query=dialect.sqlToQuery(sql).sql;statements.push(query);
  if(liveClaim && query.includes('UPDATE outreach_messages om'))return {rows:[]};
  if(liveClaim && query.includes('INNER JOIN outreach_conversations oc'))return {rows:[liveClaim]};
  if(query.startsWith('SELECT confirmation_expires_at'))return {rows:[{confirmation_expires_at:intentExpiresAt}]};
  return { rows: [{ id: 3, provider_account_id: 'sales@example.test' }] };
} } }));
const model = {
  updateOutreachMessageStatus: update,
  getOutreachConversationById: async () => ({ id: 2, userId: 1, integrationProvider: 'gmail', subject: 'Hello' }),
  getOutreachMessageById: async () => ({ id: 3, conversationId: 2, messageKind: 'outreach' }),
  getMessagesByConversationId: async () => [],
};
jest.unstable_mockModule('../models/index.js', () => ({ OutreachConversationModel: model }));
const readiness = jest.fn<(...args: unknown[]) => Promise<{ binding?: { providerAccountId: string }; missing: string[] }>>();
let intentExpiresAt: Date | null = null;
jest.unstable_mockModule('../services/outreach/ProviderBindingService.js', () => ({ inspectOfficialProviderBinding: readiness }));
jest.unstable_mockModule('../services/outreach/CreationFollowUpService.js', () => ({ checkCreationDelivery: async () => null, activateCreationFollowUps: async () => true }));
jest.unstable_mockModule('../services/OutreachAttachmentService.js', () => ({ outreachAttachmentService: { getEmailAttachments: async () => [], markDelivery: async () => {} } }));
jest.unstable_mockModule('../services/CreditService.js', () => ({ creditService: { reserveOutreachCredit: reserve, refundDeduction: refund } }));
jest.unstable_mockModule('../services/emailService.js', () => ({ emailService: { sendEmailWithUserCredentials: send } }));
// These tests isolate rate-limit propagation. Durable ownership and policy use actual PostgreSQL in emailQueueLifecyclePostgres.
jest.unstable_mockModule('../services/outreach/EmailQueueDeliveryService.js',()=>({
  EmailQueuePolicyError:class extends Error {},
  claimQueuedEmail:async()=>({claim:{messageId:3,token:'test-claim',account:{senderId:7,fromEmail:'sales@example.test',providerAccountId:'sales@example.test',credentialId:77}}}),
  recordQueuedEmailReservation:async()=>true,startQueuedEmailProvider:async()=>true,assertQueuedEmailFollowUpReady: async () => {},
    confirmQueuedEmailFollowUp:async()=>{},finishQueuedEmail:finishEmail,
}));
const { processQueuedOutreachMessage, processEmailSending } = await import('../workers/index.js');
const jobFixture = () => ({
  id: 'fixture-job', data: { userId: 1, messageId: 3, conversationId: 2, channel: 'email', recipientEmail: 'recipient@example.test', message: 'Hello', subject: 'Hello' },
  attemptsMade: 0, opts: { attempts: 3 }, token: 'fixture-token',
  updateData: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  moveToDelayed: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
});
let retryAt: string;
beforeEach(() => {
  jest.clearAllMocks(); statements.length = 0;
  liveClaim=undefined;
  retryAt = new Date(Date.now() + 7200_000).toISOString();
  send.mockResolvedValue({ success: false, error: 'User-rate limit exceeded', deliveryAttempted: true, outcomeUncertain: false, retryable: true, retryAt });
  reserve.mockResolvedValue({ success: true, transactionId: 10 }); refund.mockResolvedValue({ success: true });
  update.mockResolvedValue({ id: 3 });
  readiness.mockResolvedValue({ binding: { providerAccountId: 'sales@example.test' }, missing: [] });
  intentExpiresAt = null;
});

describe('a confirmed sending account that is not ready', () => {
  it('holds the message for an hour while the same account is connected but not ready', async () => {
    readiness.mockResolvedValue({ missing: ['unexpired_token'] });
    intentExpiresAt = new Date(Date.now() + 3 * 86_400_000);
    const job = jobFixture();
    await expect(processQueuedOutreachMessage(job as unknown as Job)).rejects.toBeInstanceOf(DelayedError);
    expect(update).toHaveBeenCalledWith(3, 'pending', expect.objectContaining({
      errorMessage: expect.stringContaining('The sending account needs attention (unexpired_token)'), providerCallState: 'not_started', sendClaimedAt: null }));
    expect(statements.some(query => query.includes('jsonb_set') && query.includes('{outreachQueue}'))).toBe(true);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'fixture-token');
    expect(update.mock.calls.some(call => call[1] === 'failed')).toBe(false);
    expect(reserve).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('fails the message when the confirmed account is no longer connected', async () => {
    readiness.mockResolvedValue({ missing: ['credential'] });
    intentExpiresAt = new Date(Date.now() + 3 * 86_400_000);
    const job = jobFixture();
    expect(await processQueuedOutreachMessage(job as unknown as Job)).toMatchObject({ success: false, retryable: false });
    expect(update).toHaveBeenCalledWith(3, 'failed', expect.objectContaining({ errorMessage: expect.stringContaining('no longer matches') }));
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
  it('fails rather than holds once the hour would pass the message expiry', async () => {
    readiness.mockResolvedValue({ missing: ['readiness_error'] });
    intentExpiresAt = new Date(Date.now() + 10 * 60_000);
    const job = jobFixture();
    expect(await processQueuedOutreachMessage(job as unknown as Job)).toMatchObject({ success: false });
    expect(update).toHaveBeenCalledWith(3, 'failed', expect.anything());
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});

describe('email rate limits through actual workers', () => {
  it.each(['not_started','started'])('leaves another live worker claim alone (%s)',async provider_call_state=>{
    liveClaim={status:'sending',provider_call_state,send_claimed_at:new Date()};
    expect(await processQueuedOutreachMessage(jobFixture() as unknown as Job)).toMatchObject({inProgress:true,retryable:false});
    expect(update).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  });
  it('holds a late assistant setup failure without an uncertain outcome or automatic retry', async () => {
    send.mockResolvedValue({ success: false, code: 'ASSISTANT_SETUP_REQUIRED', reason: 'runtime_disabled', error: 'Assistant runtime disabled', deliveryAttempted: false, outcomeUncertain: false, retryable: false });
    const job = jobFixture();
    await expect(processQueuedOutreachMessage(job as unknown as Job)).rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED', reason: 'runtime_disabled' });
    expect(update).toHaveBeenCalledWith(3, 'setup_required', expect.objectContaining({ providerCallState: 'not_started', manualReviewRequired: false }));
    expect(refund).toHaveBeenCalledTimes(1); expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
  it('holds a late setup failure on the email queue with a refund and no replay', async () => {
    send.mockResolvedValue({ success: false, code: 'ASSISTANT_SETUP_REQUIRED', reason: 'assignment_changed', error: 'Assistant assignment changed', deliveryAttempted: false, outcomeUncertain: false, retryable: false });
    const job = jobFixture();
    await expect(processEmailSending(job as unknown as Job)).rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED', reason: 'assignment_changed' });
    expect(finishEmail).toHaveBeenCalledWith(expect.objectContaining({ messageId: 3 }), 'setup_required', undefined, expect.stringContaining('ASSISTANT_SETUP_REQUIRED'));
    expect(refund).toHaveBeenCalledTimes(1); expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
  it('preserves provider evidence, refunds, releases the outreach claim, and delays the job', async () => {
    const job = jobFixture();
    await expect(processQueuedOutreachMessage(job as unknown as Job)).rejects.toBeInstanceOf(DelayedError);
    expect(send).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(3, 'pending', expect.objectContaining({ providerCallState: 'not_started', manualReviewRequired: false, sendClaimedAt: null }));
    expect(job.moveToDelayed).toHaveBeenCalledWith(Date.parse(retryAt), 'fixture-token');
    expect(update.mock.calls.some(call => call[1] === 'failed' || call[1] === 'manual_review')).toBe(false);
  });
  it('leaves an ambiguous email outcome for manual review without refunding or delaying', async () => {
    send.mockResolvedValue({ success: false, error: 'Connection lost', deliveryAttempted: true, outcomeUncertain: true, retryable: true });
    const job = jobFixture();
    await processQueuedOutreachMessage(job as unknown as Job);
    expect(job.moveToDelayed).not.toHaveBeenCalled(); expect(refund).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(3, 'manual_review', expect.objectContaining({ providerCallState: 'unknown', manualReviewRequired: true }));
  });
  it('records a final rejection after exhausting rate-limit retries', async () => {
    const job = jobFixture(); Object.assign(job.data, { emailRateLimitRetries: 2 });
    await processQueuedOutreachMessage(job as unknown as Job);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(3, 'failed', expect.objectContaining({ providerCallState: 'rejected', manualReviewRequired: false }));
  });
  it('honors the provider cooldown on the legacy email queue too', async () => {
    const job = jobFixture();
    await expect(processEmailSending(job as unknown as Job)).rejects.toBeInstanceOf(DelayedError);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(job.moveToDelayed).toHaveBeenCalledWith(Date.parse(retryAt), 'fixture-token');
  });
  it('does not refund or retry an ambiguous response on the legacy email queue', async () => {
    send.mockResolvedValue({ success: false, error: 'Connection lost', deliveryAttempted: true, outcomeUncertain: true });
    const job = jobFixture();
    expect(await processEmailSending(job as unknown as Job)).toMatchObject({ success: false, uncertain: true });
    expect(refund).not.toHaveBeenCalled(); expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
  it('stops the legacy queue when its durable rate-limit retry budget is exhausted', async () => {
    const job = jobFixture(); Object.assign(job.data, { emailRateLimitRetries: 2 });
    await expect(processEmailSending(job as unknown as Job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(job.moveToDelayed).not.toHaveBeenCalled(); expect(refund).toHaveBeenCalledTimes(1);
  });
});
