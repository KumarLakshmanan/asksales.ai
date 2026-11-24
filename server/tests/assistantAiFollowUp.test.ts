import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { emptyAssistantDraft } from '../../shared/outreachAssistants.js';

const configuration = { ...emptyAssistantDraft(), replyModel: { provider: 'openai', model: 'configured-model' } };
const fresh = jest.fn(async () => undefined);
const completion = jest.fn(async () => ({ success: true, content: '{"message":"Would you like any further help with your enquiry?"}' }));
const inbound = jest.fn(async (_text: string) => ({ safe: true }));
const outbound = jest.fn(async (text: string, _ctx?: unknown) => ({ safe: true, finalText: text }));
const policy = jest.fn((_ctx?: unknown, _rules?: unknown) => ({ passed: true }));
const vault = jest.fn(() => true);
jest.unstable_mockModule('../services/assistants/AssistantContext.js', () => ({ currentAssistant: () => ({ configuration }) }));
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({ assertAssistantFresh: fresh }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createChatCompletionWithFallback: completion } }));
jest.unstable_mockModule('../services/agents/pipeline/GuardrailService.js', () => ({ guardrailService: { checkInbound: inbound, checkOutbound: outbound } }));
jest.unstable_mockModule('../services/agents/pipeline/PolicyEngine.js', () => ({ policyEngine: { evaluatePreGeneration: policy } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({ isPrivacyVaultConfigured: vault, redactPiiWithStableTokens: (text: string) => ({ redactedText: text.replace(/private@example\.com/g, '[email_1]') }) }));
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({ parseUtcDatabaseTimestamp: (value: unknown) => value instanceof Date ? value : new Date(String(value).replace(' ', 'T').replace(/(?<!Z)$/, 'Z')) }));
const { assistantReplyWindowOpen, generateAssistantAiFollowUp } = await import('../services/assistants/AssistantAiFollowUp.js');
const input = { userId: 1, conversationId: 2, channel: 'whatsapp' as const, history: [{ direction: 'inbound', content: 'Please help private@example.com' }, { direction: 'outbound', content: 'How can I help?' }] };
beforeEach(() => {
  jest.clearAllMocks();
  completion.mockResolvedValue({ success: true, content: '{"message":"Would you like any further help with your enquiry?"}' });
  inbound.mockResolvedValue({ safe: true }); outbound.mockImplementation(async text => ({ safe: true, finalText: text }));
  vault.mockReturnValue(true); policy.mockReturnValue({ passed: true }); fresh.mockResolvedValue(undefined);
});
describe('AI follow-up generation and reply window', () => {
  it('uses a strict window from the last inbound message and rejects absent, invalid and future timestamps', () => {
    const now = new Date('2026-10-28T12:00:00Z');
    expect(assistantReplyWindowOpen('2026-10-27T12:00:00.001Z', now)).toBe(true);
    expect(assistantReplyWindowOpen('2026-10-27T12:00:00Z', now)).toBe(false);
    for (const value of [null, undefined, 'invalid', '2026-10-28T12:00:01Z']) expect(assistantReplyWindowOpen(value, now)).toBe(false);
  });
  it('uses the configured reply model with only redacted context and runs safety checks before and after generation', async () => {
    expect((await generateAssistantAiFollowUp(input)).body).toContain('further help');
    const [owner, options] = completion.mock.calls[0] as unknown as [number, { model: string; messages: { content: string }[]; loggingContext: { purpose: string } }];
    expect(owner).toBe(1); expect(options.model).toBe('configured-model');
    expect(options.messages[1].content).toContain('[email_1]'); expect(JSON.stringify(options)).not.toContain('private@example.com');
    expect(options.loggingContext.purpose).toBe('assistant_follow_up');
    expect(inbound).toHaveBeenCalledTimes(2); expect(outbound).toHaveBeenCalledTimes(1); expect(fresh).toHaveBeenCalledTimes(2);
  });
  it('does not call a model while privacy, policy or input safety is unavailable', async () => {
    vault.mockReturnValue(false); await expect(generateAssistantAiFollowUp(input)).rejects.toThrow('privacy vault');
    vault.mockReturnValue(true); policy.mockReturnValue({ passed: false }); await expect(generateAssistantAiFollowUp(input)).rejects.toThrow('policy blocked');
    policy.mockReturnValue({ passed: true }); inbound.mockResolvedValue({ safe: false }); await expect(generateAssistantAiFollowUp(input)).rejects.toThrow('human review');
    expect(completion).not.toHaveBeenCalled();
  });
  it('evaluates email follow-ups with the email policy context and the same redacted generation boundary', async () => {
    await generateAssistantAiFollowUp({ ...input, channel: 'email' });
    expect(policy.mock.calls[0][0]).toMatchObject({ message: { channel: 'email', userId: 1, conversationId: 2 } });
    expect(outbound.mock.calls[0][1]).toMatchObject({ message: { channel: 'email' } });
    expect(JSON.stringify(completion.mock.calls)).not.toContain('private@example.com');
  });
  it('rejects malformed model output and unsafe output without falling back to an unchecked message', async () => {
    completion.mockResolvedValue({ success: true, content: '{}' }); await expect(generateAssistantAiFollowUp(input)).rejects.toThrow('invalid content');
    completion.mockResolvedValue({ success: true, content: '{"message":"Check in"}' }); outbound.mockResolvedValue({ safe: false, finalText: 'Blocked' });
    await expect(generateAssistantAiFollowUp(input)).rejects.toThrow('output policy');
  });
});
