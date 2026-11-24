import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { emptyAssistantDraft } from '../../shared/outreachAssistants.js';

const configuration = emptyAssistantDraft();
const assistant = { configuration, provenance: { channel: 'email', surface: 'private', accountId: 'support@example.com', bindingId: 3 } };
let eligibleReads = 0, cancelAfterGeneration = false, changeAfterDesign = false, senderAvailable = true;
const dialect = new PgDialect();
const execute = jest.fn(async (query: SQL) => {
  const text = dialect.sqlToQuery(query).sql;
  if (text.includes('SELECT direction')) return { rows: [{ direction: 'inbound', content: 'Help with my enquiry' }, { direction: 'outbound', content: 'How can we help?' }] };
  if (text.includes('FROM email_senders')) return { rows: senderAvailable ? [{ id: 12 }] : [] };
  if (text.includes('outreach_assistant_follow_up_schedules s JOIN')) {
    eligibleReads++;
    if (cancelAfterGeneration && eligibleReads > 1) return { rows: [] };
    return { rows: [{ id: 8, version: 1, next_step: 0, user_id: 1, conversation_id: 2, anchor_message_id: 7,
      channel: 'email', lead_email: changeAfterDesign && eligibleReads > 2 ? 'changed@example.com' : 'qa@example.com',
      subject: 'Support enquiry', brand_toolkit_id: 34, external_thread_id: 'original-gmail-thread', last_inbound_rfc_message_id: '<inbound@example.com>',
      last_inbound_at: '2026-10-26T12:00:00Z', steps: configuration.followUps.sequences[0].steps }] };
  }
  return { rows: [] };
});
const generate = jest.fn(async (_input: unknown) => ({ body: 'Would you like any more help?', subject: '', html: '' }));
const windowOpen = jest.fn(() => false);
const prepareDesign = jest.fn(async (_owner: number, body: string, _kind: string, _design?: string, _brandToolkitId?: number | null) => `<!doctype html><body data-email-design="hospitality">${body}</body>`);
const send = jest.fn(async (_owner: number, _options: unknown, _sender: number) => ({ success: true, providerMessageId: 'gmail-ack' as string | undefined }));
const markFailed = jest.fn(async (..._args: unknown[]) => undefined);
const complete = jest.fn(async (..._args: unknown[]) => undefined);
const template = jest.fn(async () => { throw new Error('AI mode must not load a template'); });
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({ requireBusinessScope: () => ({ userId: 1, businessProfileId: 4 }), withBusinessScope: (_scope: unknown, callback: () => unknown) => callback(), withSystemScope: (_reason: unknown, callback: () => unknown) => callback() }));
jest.unstable_mockModule('../services/assistants/AssistantContext.js', () => ({ currentAssistant: () => assistant, assistantsRuntimeEnabled: () => true, assistantRolloutProfiles: () => null }));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({ assertAssistantFresh: async () => undefined, withPublishedAssistant: async (_p: unknown, work: () => unknown) => work() }));
jest.unstable_mockModule('../services/assistants/AssistantConfiguration.js', () => ({ assistantTemplateVariableAllowed: () => true, withinAssistantHours: () => true, nextAssistantOpen: () => new Date() }));
jest.unstable_mockModule('../services/followUpTemplateService.js', () => ({ loadFollowUpTemplate: template, renderFollowUpTemplate: template }));
jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({ deliveryOutboxService: { markFailed, completeClaimedAction: complete } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({ redactPiiWithStableTokens: (text: string) => ({ redactedText: text }) }));
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({ parseUtcDatabaseTimestamp: (value: unknown) => new Date(String(value)) }));
jest.unstable_mockModule('../services/assistants/AssistantAiFollowUp.js', () => ({ generateAssistantAiFollowUp: generate, assistantReplyWindowOpen: windowOpen }));
jest.unstable_mockModule('../services/EmailDesignService.js', () => ({ prepareDesignedEmail: prepareDesign }));
jest.unstable_mockModule('../services/emailService.js', () => ({ emailService: { sendEmailWithUserCredentials: send } }));
const { assistantFollowUps } = await import('../services/assistants/AssistantFollowUps.js');
const action = { id: 5, userId: 1, conversationId: 2, channel: 'email', attemptCount: 1, payload: { recipient: 'qa@example.com', metadata: { dispatchKind: 'assistant_follow_up', messageKind: 'follow_up', isAiGenerated: true, scheduleId: 8, scheduleVersion: 1, followUpStep: 0 } } } as unknown as Parameters<typeof assistantFollowUps.dispatchClaimed>[0];

beforeEach(() => {
  jest.clearAllMocks(); eligibleReads = 0; cancelAfterGeneration = false; changeAfterDesign = false; senderAvailable = true;
  configuration.followUps = { mode: 'selected', sequences: [{ channel: 'email', steps: [{ delayMinutes: 2880, templateId: 0, messageMode: 'ai' }] }] };
  generate.mockImplementation(async () => ({ body: 'Would you like any more help?', subject: '', html: '' }));
  prepareDesign.mockImplementation(async (_owner, body) => `<!doctype html><body data-email-design="hospitality">${body}</body>`);
  send.mockResolvedValue({ success: true, providerMessageId: 'gmail-ack' });
});

describe('AI email follow-up delivery', () => {
  it('uses the original sender and thread, assistant design, stable intent and one native receipt after the WhatsApp window', async () => {
    await assistantFollowUps.dispatchClaimed(action);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, conversationId: 2, channel: 'email' }));
    expect(windowOpen).not.toHaveBeenCalled(); expect(template).not.toHaveBeenCalled();
    expect(prepareDesign).toHaveBeenCalledWith(1, '<p>Would you like any more help?</p>', 'assistant', undefined, 34);
    expect(send).toHaveBeenCalledWith(1, expect.objectContaining({ to: 'qa@example.com', subject: 'Re: Support enquiry',
      html: expect.stringContaining('data-email-design="hospitality"'), threadId: 'original-gmail-thread', inReplyTo: '<inbound@example.com>',
      idempotencyKey: 'assistant-follow-up:8:1:0', skipConversationLog: true, isFollowUp: true, followUpStep: 1 }), 12);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ text: 'Would you like any more help?', subject: 'Re: Support enquiry',
      metadata: expect.objectContaining({ emailHtml: expect.stringContaining('data-email-design="hospitality"') }) }) }), 'gmail-ack', expect.any(Function));
    expect(markFailed).not.toHaveBeenCalled();
  });
  it('requires the original verified sender before provider delivery', async () => {
    senderAvailable = false; await assistantFollowUps.dispatchClaimed(action);
    expect(send).not.toHaveBeenCalled(); expect(markFailed).toHaveBeenCalledWith(5, expect.any(String), false, false);
  });
  it('rechecks reply, opt-out and handoff eligibility after generation', async () => {
    cancelAfterGeneration = true; await assistantFollowUps.dispatchClaimed(action);
    expect(generate).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });
  it('rechecks the exact recipient after preparing the design', async () => {
    changeAfterDesign = true; await assistantFollowUps.dispatchClaimed(action);
    expect(prepareDesign).toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });
  it('rejects a stale template selection in AI mode without loading a template or sending', async () => {
    configuration.followUps.sequences[0].steps[0].templateId = 7;
    await assistantFollowUps.dispatchClaimed(action);
    expect(generate).not.toHaveBeenCalled(); expect(template).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('does not record success when provider acknowledgement is missing', async () => {
    send.mockResolvedValue({ success: true, providerMessageId: undefined });
    await assistantFollowUps.dispatchClaimed(action);
    expect(complete).not.toHaveBeenCalled(); expect(markFailed).toHaveBeenCalledWith(5, expect.any(String), true, false);
  });
});
