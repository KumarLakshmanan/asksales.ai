import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ToolContext } from '../mastra/tools/toolRegistry.js';
const batch = jest.fn<(...args: unknown[]) => Promise<any>>();
const recordOutcome = jest.fn<(...args: unknown[]) => Promise<any>>();
jest.unstable_mockModule('../models/widgetStates/functions.js', () => ({ WidgetStateModel: { recordQueuedJobOutcomeForUser: recordOutcome } }));
jest.unstable_mockModule('../controllers/outreachConversationsController.js', () => ({ executeOutreachBatch: batch }));
const { executeSendOutreachMessages } = await import('../mastra/tools/executors/outreachExecutor.js');
const context = { userId: 12, threadId: 42, widgetId: 7 } as ToolContext;
const input = (channel = 'email') => ({ lead_ids: [81], channel, body: 'Reviewed outreach', subject: 'Hello',
  outreach_review: { creationVersion: 1, followUpSource: 'outreach', channel, providerAccountId: 'selected-account',
    confirmation: { confirmed: true, channel, recipientCount: 1 }, messages: [{ leadId: 81, message: 'Hello Ada', followUps: [{ delayMinutes: 90, message: 'Checking in' }] }] } });
beforeEach(() => { jest.clearAllMocks(); batch.mockResolvedValue({ status: 200, body: { queued: 1, errors: 0, results: [{ leadId: 81, status: 'queued' }] } }); });
describe('campaign card uses composer batch admission', () => {
  it.each(['email', 'sms', 'whatsapp', 'instagram', 'facebook'])('passes the exact reviewed %s batch and stable widget key to the shared delivery path', async channel => {
    const value = input(channel);
    const result = await executeSendOutreachMessages(value, context);
    expect(batch).toHaveBeenCalledWith(12, value.outreach_review, 'campaign-widget-7', { id: 7, threadId: 42 });
    expect(result).toMatchObject({ success: true, output: { status: 'queued', successCount: 1 } });
  });
  it('retains all 575 reviewed recipients in one campaign execution', async () => {
    const value = input('whatsapp');
    value.lead_ids = Array.from({length:575},(_,i)=>i+1);
    value.outreach_review.confirmation.recipientCount = 575;
    value.outreach_review.messages = value.lead_ids.map(leadId=>({...value.outreach_review.messages[0],leadId}));
    await executeSendOutreachMessages(value,context);
    expect(batch.mock.calls[0][1]).toMatchObject({messages:expect.arrayContaining([{...value.outreach_review.messages[574]}])});
    expect((batch.mock.calls[0][1] as any).messages).toHaveLength(575);
  });
  it('does not send an old or model-only action without the composer review and durable widget approval', async () => {
    const { outreach_review: _review, ...legacy } = input();
    expect(await executeSendOutreachMessages(legacy, context)).toMatchObject({ success: false, requiresApproval: true });
    expect(await executeSendOutreachMessages(input(), { ...context, widgetId: undefined })).toMatchObject({ success: false, requiresApproval: true });
    expect(batch).not.toHaveBeenCalled();
  });
  it.each(['channel', 'recipients', 'global', 'campaign', 'duplicates'])('rejects a mismatched or mixed %s review', async change => {
    const value: any = input();
    if (change === 'channel') value.outreach_review.channel = 'sms';
    if (change === 'recipients') value.lead_ids = [99];
    if (change === 'global') value.outreach_review.useSavedFollowUpSettings = true;
    if (change === 'campaign') value.outreach_review.campaignManualReviewId = 'other-campaign';
    if (change === 'duplicates') { value.lead_ids = [81, 99]; value.outreach_review.messages.push({ ...value.outreach_review.messages[0] }); }
    expect(await executeSendOutreachMessages(value, context)).toMatchObject({ success: false });
    expect(batch).not.toHaveBeenCalled();
  });
  it('does not claim delivery or offer automatic retry after partial or uncertain queue acceptance', async () => {
    batch.mockResolvedValueOnce({ status: 200, body: { queued: 1, errors: 1 } });
    expect(await executeSendOutreachMessages(input(), context)).toMatchObject({ success: true, output: { status: 'queued_partial', retrySafe: false } });
    batch.mockResolvedValueOnce({ status: 200, body: { queued: 0, uncertain: 1 } });
    expect(await executeSendOutreachMessages(input(), context)).toMatchObject({ success: true, output: { status: 'needs_attention', retrySafe: false } });
  });
  it('reports shared validation and provider failures without starting a second send path', async () => {
    batch.mockResolvedValueOnce({ status: 409, body: { error: 'Recipient changed after review.' } });
    expect(await executeSendOutreachMessages(input(), context)).toMatchObject({ success: false, error: 'Recipient changed after review.' });
    expect(batch).toHaveBeenCalledTimes(1);
  });
  it('counts rejected recipients so a partially queued campaign can settle', async () => {
    const value = input(); value.lead_ids.push(99);
    value.outreach_review.confirmation.recipientCount = 2;
    value.outreach_review.messages.push({ ...value.outreach_review.messages[0], leadId: 99 });
    const rejection = { leadId: 99, status: 'error', error: 'Daily limit reached' };
    batch.mockResolvedValueOnce({ status: 200, body: { queued: 1, errors: 1, results: [{ leadId: 81, status: 'queued' }, rejection] } });
    expect(await executeSendOutreachMessages(value, context)).toMatchObject({ success: true, output: { totalLeads: 2, status: 'queued_partial' } });
    expect(recordOutcome).toHaveBeenCalledWith(7, 12, 'batch-rejection-99', 2, false, rejection);
  });
  it('allows correction only when no durable message exists', async () => {
    batch.mockResolvedValueOnce({ status: 200, body: { success: true, queued: 0, errors: 1, results: [{ leadId: 81, status: 'error', messageId: 0 }] } });
    expect(await executeSendOutreachMessages(input(), context)).toMatchObject({ success: false, output: { success: false, retrySafe: true } });
    batch.mockResolvedValueOnce({ status: 200, body: { success: true, queued: 0, errors: 1, results: [{ leadId: 81, status: 'error', messageId: 101 }] } });
    expect(await executeSendOutreachMessages(input(), context)).toMatchObject({ success: false, output: { retrySafe: false } });
  });
});
