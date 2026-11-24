import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { emptyAssistantDraft } from '../../shared/outreachAssistants.js';
const draft = emptyAssistantDraft();
draft.followUps = { mode: 'selected', sequences: [{ channel: 'whatsapp', steps: [{ delayMinutes: 60, templateId: 0, messageMode: 'ai' }] }] };
const assistant = { configuration: draft, provenance: { channel: 'whatsapp', surface: 'private', accountId: 'original-account', bindingId: 3 } };
let eligibleCalls = 0;
let cancelledAfterGeneration = false;
let lastInbound = '2026-10-28T11:00:00Z';
const execute = jest.fn(async () => {
  // The first and second reads authorize the same schedule on either side of generation.
  eligibleCalls++;
  return { rows: cancelledAfterGeneration && eligibleCalls > 2 ? [] : eligibleCalls === 2 ? [{ direction: 'inbound', content: 'Help with my enquiry' }, { direction: 'outbound', content: 'How can we help?' }] : [{ id: 8, version: 1, next_step: 0, user_id: 1, conversation_id: 2, anchor_message_id: 7, external_thread_id: 'test-recipient', channel: 'whatsapp', last_inbound_at: lastInbound, steps: draft.followUps.sequences[0].steps }] };
});
const generate = jest.fn(async () => ({ body: 'Would you like any more help?', subject: '', html: '' }));
const send = jest.fn(async (_params: unknown) => ({ messages: [{ id: 'provider-ack' }] }));
const markFailed = jest.fn(async () => undefined);
const complete = jest.fn(async () => undefined);
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
jest.unstable_mockModule('../services/assistants/AssistantAiFollowUp.js', () => ({ generateAssistantAiFollowUp: generate, assistantReplyWindowOpen: (value: unknown) => { const age = Date.now() - new Date(String(value)).getTime(); return Number.isFinite(age) && age >= 0 && age < 86400000; } }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { sendText: send } }));
const { assistantFollowUps } = await import('../services/assistants/AssistantFollowUps.js');
const action = { id: 5, userId: 1, conversationId: 2, channel: 'whatsapp', attemptCount: 1, payload: { recipient: 'test-recipient', metadata: { scheduleId: 8, scheduleVersion: 1, followUpStep: 0 } } } as unknown as Parameters<typeof assistantFollowUps.dispatchClaimed>[0];
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-28T12:00:00Z'));
  jest.clearAllMocks(); eligibleCalls = 0; cancelledAfterGeneration = false; lastInbound = '2026-10-28T11:00:00Z';
  generate.mockImplementation(async () => ({ body: 'Would you like any more help?', subject: '', html: '' }));
});
afterEach(() => { jest.useRealTimers(); });
describe('AI check-in final delivery boundary', () => {
  it('sends through the original account only after reauthorization and records the acknowledged result', async () => {
    await assistantFollowUps.dispatchClaimed(action);
    expect(generate).toHaveBeenCalledTimes(1); expect(template).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ userId: 1, to: 'test-recipient', text: 'Would you like any more help?', phoneNumberId: 'original-account' });
    expect(complete).toHaveBeenCalledTimes(1); expect(markFailed).not.toHaveBeenCalled();
  });
  it('never generates or sends after the customer reply window has expired', async () => {
    lastInbound = '2026-10-27T12:00:00Z';
    await assistantFollowUps.dispatchClaimed(action);
    expect(generate).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(markFailed).toHaveBeenCalled();
  });
  it('rejects a queued recipient that no longer matches the original conversation', async () => {
    await assistantFollowUps.dispatchClaimed({ ...action, payload: { ...action.payload, recipient: 'different-recipient' } });
    expect(generate).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(markFailed).toHaveBeenCalled();
  });
  it('stops if generation crosses the 24-hour boundary', async () => {
    lastInbound = '2026-10-27T12:00:01Z';
    generate.mockImplementation(async () => { jest.setSystemTime(new Date('2026-10-28T12:00:02Z')); return { body: 'Check in', subject: '', html: '' }; });
    await assistantFollowUps.dispatchClaimed(action);
    expect(generate).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled(); expect(markFailed).toHaveBeenCalled();
  });
  it('stops when a reply, handoff or reassignment invalidates eligibility during generation', async () => {
    cancelledAfterGeneration = true;
    await assistantFollowUps.dispatchClaimed(action);
    expect(generate).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });
});
